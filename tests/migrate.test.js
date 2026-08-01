'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync, spawn } = require('child_process');

const MIGRATE_SCRIPT = path.join(__dirname, '..', 'hooks', 'migrate.js');
const INIT_SCRIPT = path.join(__dirname, '..', 'hooks', 'init.js');

const SID = '11111111-1111-4111-8111-111111111111';
const DAY_MS = 86400000;

function mkTmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-migrate-'));
}

function stateDirOf(repo) {
  return path.join(repo, '.claude', 'state', 'eghs');
}

function init(repo) {
  execFileSync('node', [INIT_SCRIPT], { cwd: repo, encoding: 'utf8' });
}

function migrate(args, repo, env = {}) {
  return spawnSync('node', [MIGRATE_SCRIPT, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function deadPid() {
  return spawnSync('node', ['-e', '']).pid;
}

// A repo that is initialized and then rolled to a different on-disk schema, so
// eghs-migrate has actual work to do (steps 6-7).
function repoNeedingMigrate() {
  const repo = mkTmpRepo();
  init(repo);
  fs.writeFileSync(path.join(stateDirOf(repo), 'schema_version'), '2\n');
  return repo;
}

function writeLease(repo, sid, body) {
  fs.writeFileSync(path.join(stateDirOf(repo), 'sessions', `${sid}.json`), JSON.stringify(body));
}

// ---- steps 0 / 3: bootstrap + role validation ----

test('eghs-migrate aborts on a clean install and defers to eghs-init', () => {
  const repo = mkTmpRepo();
  const r = migrate([], repo);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /eghs-init/);
});

test('eghs-migrate aborts when schema_version is absent', () => {
  const repo = mkTmpRepo();
  init(repo);
  fs.rmSync(path.join(stateDirOf(repo), 'schema_version'));
  const r = migrate([], repo);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /schema_version absent; use eghs-init to bootstrap/);
});

test('eghs-migrate aborts on an INVALID schema_version', () => {
  const repo = mkTmpRepo();
  init(repo);
  fs.writeFileSync(path.join(stateDirOf(repo), 'schema_version'), '01\n');
  const r = migrate([], repo);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--repair/);
});

test('eghs-migrate is a no-op when the on-disk schema already matches the hook', () => {
  const repo = mkTmpRepo();
  init(repo);
  const readsRecord = path.join(stateDirOf(repo), 'reads', 'abc.json');
  fs.writeFileSync(readsRecord, '{}');
  const schemaPath = path.join(stateDirOf(repo), 'schema_version');
  const before = fs.statSync(schemaPath).mtimeMs;
  const r = migrate([], repo);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no-op/);
  assert.ok(fs.existsSync(readsRecord), 'records must survive a no-op migrate');
  assert.equal(fs.statSync(schemaPath).mtimeMs, before);
});

// ---- steps 6-7: per-record cleanup + atomic schema rewrite ----

test('eghs-migrate wipes reads/ and failed/ records and rewrites schema_version', () => {
  const repo = repoNeedingMigrate();
  const stateDir = stateDirOf(repo);
  fs.writeFileSync(path.join(stateDir, 'reads', 'aaa.json'), '{}');
  fs.writeFileSync(path.join(stateDir, 'failed', 'bbb.json'), '{}');
  const r = migrate([], repo);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(stateDir, 'reads', 'aaa.json')));
  assert.ok(!fs.existsSync(path.join(stateDir, 'failed', 'bbb.json')));
  assert.equal(fs.readFileSync(path.join(stateDir, 'schema_version'), 'utf8'), '1\n');
  assert.ok(!fs.existsSync(path.join(stateDir, 'migrate.lock')), 'migrate.lock must be released');
});

test('eghs-migrate keeps fs-info.json across a schema change', () => {
  const repo = repoNeedingMigrate();
  const infoPath = path.join(stateDirOf(repo), 'fs-info.json');
  const before = fs.readFileSync(infoPath, 'utf8');
  assert.equal(migrate([], repo).status, 0);
  assert.equal(fs.readFileSync(infoPath, 'utf8'), before);
});

// ---- steps 4-5: sessions GC + preconditions ----

test('eghs-migrate refuses while an active session lease exists', () => {
  const repo = repoNeedingMigrate();
  writeLease(repo, SID, {
    pid: process.pid,
    uid: process.getuid(),
    start_ms: Date.now(),
    renewed_ms: Date.now(),
  });
  const r = migrate([], repo);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /active session/i);
  assert.equal(fs.readFileSync(path.join(stateDirOf(repo), 'schema_version'), 'utf8'), '2\n');
  assert.ok(!fs.existsSync(path.join(stateDirOf(repo), 'migrate.lock')), 'migrate.lock must be released on abort');
});

test('eghs-migrate GCs a same-uid dead stale lease with its full cascade', () => {
  const repo = repoNeedingMigrate();
  const stateDir = stateDirOf(repo);
  writeLease(repo, SID, {
    pid: deadPid(),
    uid: process.getuid(),
    start_ms: Date.now() - 3 * DAY_MS,
    renewed_ms: Date.now() - 3 * DAY_MS,
  });
  fs.writeFileSync(path.join(stateDir, 'baselines', `${SID}.txt`), '{}');
  fs.writeFileSync(path.join(stateDir, 'debug', `${SID}.jsonl`), '');
  fs.mkdirSync(path.join(stateDir, 'pre', SID), { recursive: true });
  const r = migrate([], repo);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(stateDir, 'sessions', `${SID}.json`)));
  assert.ok(!fs.existsSync(path.join(stateDir, 'baselines', `${SID}.txt`)));
  assert.ok(!fs.existsSync(path.join(stateDir, 'debug', `${SID}.jsonl`)));
  assert.ok(!fs.existsSync(path.join(stateDir, 'pre', SID)));
  assert.equal(fs.readFileSync(path.join(stateDir, 'schema_version'), 'utf8'), '1\n');
});

test('eghs-migrate leaves a foreign-uid stale lease alone without --force-foreign-cleanup', () => {
  const repo = repoNeedingMigrate();
  writeLease(repo, SID, {
    pid: deadPid(),
    uid: process.getuid() + 1,
    start_ms: Date.now() - 5 * DAY_MS,
    renewed_ms: Date.now() - 5 * DAY_MS,
  });
  const r = migrate([], repo);
  assert.notEqual(r.status, 0);
  assert.ok(fs.existsSync(path.join(stateDirOf(repo), 'sessions', `${SID}.json`)));
});

test('eghs-migrate --force-foreign-cleanup removes a foreign-uid lease past 2x the stale TTL', () => {
  const repo = repoNeedingMigrate();
  writeLease(repo, SID, {
    pid: deadPid(),
    uid: process.getuid() + 1,
    start_ms: Date.now() - 5 * DAY_MS,
    renewed_ms: Date.now() - 5 * DAY_MS,
  });
  const r = migrate(['--force-foreign-cleanup'], repo);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(stateDirOf(repo), 'sessions', `${SID}.json`)));
});

test('eghs-migrate --force-foreign-cleanup keeps a foreign lease that is still within 2x the TTL', () => {
  const repo = repoNeedingMigrate();
  writeLease(repo, SID, {
    pid: deadPid(),
    uid: process.getuid() + 1,
    start_ms: Date.now() - 1.5 * DAY_MS,
    renewed_ms: Date.now() - 1.5 * DAY_MS,
  });
  const r = migrate(['--force-foreign-cleanup'], repo);
  assert.notEqual(r.status, 0);
  assert.ok(fs.existsSync(path.join(stateDirOf(repo), 'sessions', `${SID}.json`)));
});

test('eghs-migrate unlinks orphan stop-locks whose lease is gone (precondition c)', () => {
  const repo = repoNeedingMigrate();
  const locksDir = path.join(stateDirOf(repo), 'locks');
  fs.writeFileSync(path.join(locksDir, `stop-${SID}.lock`), JSON.stringify({ pid: 1, uid: 0, start_ms: 0, timeout_ms: 0 }));
  fs.writeFileSync(path.join(locksDir, `stop-${SID}.recover.lock`), '{}');
  const r = migrate([], repo);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(locksDir, `stop-${SID}.lock`)));
  assert.ok(!fs.existsSync(path.join(locksDir, `stop-${SID}.recover.lock`)));
});

test('eghs-migrate keeps a stop-lock whose lease body is corrupt (liveness undecidable)', () => {
  const repo = repoNeedingMigrate();
  const stateDir = stateDirOf(repo);
  fs.writeFileSync(path.join(stateDir, 'locks', `stop-${SID}.lock`), '{}');
  fs.writeFileSync(path.join(stateDir, 'sessions', `${SID}.json`), '{ nope');
  const r = migrate([], repo);
  assert.notEqual(r.status, 0);
  assert.ok(fs.existsSync(path.join(stateDir, 'locks', `stop-${SID}.lock`)));
});

test('eghs-migrate aborts on an unexpected leftover in locks/', () => {
  const repo = repoNeedingMigrate();
  fs.writeFileSync(path.join(stateDirOf(repo), 'locks', 'mystery.lock'), '{}');
  const r = migrate([], repo);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /locks\//);
  assert.equal(fs.readFileSync(path.join(stateDirOf(repo), 'schema_version'), 'utf8'), '2\n');
});

// ---- steps 1-2: migrate.lock ----

test('eghs-migrate aborts on a non-regular migrate.lock and defers to --clear-migrate-lock', () => {
  const repo = repoNeedingMigrate();
  fs.mkdirSync(path.join(stateDirOf(repo), 'migrate.lock'));
  const r = migrate([], repo);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--clear-migrate-lock/);
});

test('eghs-migrate aborts while a live same-uid migrate.lock is held', () => {
  const repo = repoNeedingMigrate();
  const lockPath = path.join(stateDirOf(repo), 'migrate.lock');
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, uid: process.getuid(), start_ms: Date.now(), role: 'migrate' })
  );
  const r = migrate([], repo);
  assert.notEqual(r.status, 0);
  assert.ok(fs.existsSync(lockPath), 'a live lock must survive');
});

test('eghs-migrate reclaims a same-uid dead migrate.lock past its grace', () => {
  const repo = repoNeedingMigrate();
  fs.writeFileSync(
    path.join(stateDirOf(repo), 'migrate.lock'),
    JSON.stringify({ pid: deadPid(), uid: process.getuid(), start_ms: Date.now() - 700000, role: 'migrate' })
  );
  const r = migrate([], repo);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(stateDirOf(repo), 'schema_version'), 'utf8'), '1\n');
});

test('eghs-migrate aborts on a same-uid dead migrate.lock still within its grace', () => {
  const repo = repoNeedingMigrate();
  fs.writeFileSync(
    path.join(stateDirOf(repo), 'migrate.lock'),
    JSON.stringify({ pid: deadPid(), uid: process.getuid(), start_ms: Date.now() - 1000, role: 'migrate' })
  );
  assert.notEqual(migrate([], repo).status, 0);
});

test('eghs-migrate needs --force-foreign-cleanup to reclaim a stale FOREIGN migrate.lock', () => {
  const repo = repoNeedingMigrate();
  const body = JSON.stringify({
    pid: deadPid(),
    uid: process.getuid() + 1,
    start_ms: Date.now() - 3 * 3600000,
    role: 'migrate',
  });
  const lockPath = path.join(stateDirOf(repo), 'migrate.lock');
  fs.writeFileSync(lockPath, body);
  const refused = migrate([], repo);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /--force-foreign-cleanup/);
  assert.ok(fs.existsSync(lockPath));

  const forced = migrate(['--force-foreign-cleanup'], repo);
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(fs.readFileSync(path.join(stateDirOf(repo), 'schema_version'), 'utf8'), '1\n');
});

test('eghs-migrate aborts on a corrupt migrate.lock body and defers to --clear-migrate-lock', () => {
  const repo = repoNeedingMigrate();
  fs.writeFileSync(path.join(stateDirOf(repo), 'migrate.lock'), '{ nope');
  const r = migrate([], repo);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--clear-migrate-lock/);
});

// ---- step 0: admin mutex ----

test('eghs-migrate aborts when the admin mutex is held elsewhere', () => {
  const repo = repoNeedingMigrate();
  const guard = path.join(stateDirOf(repo), 'locks', 'admin-mutex.guard');
  const sentinel = path.join(repo, 'holder-ready');
  const holder = spawn('node', ['-e', `
    const fs = require('fs');
    const { flockSync } = require(${JSON.stringify(require.resolve('fs-ext'))});
    const fd = fs.openSync(${JSON.stringify(guard)}, 'w');
    flockSync(fd, 'exnb');
    fs.writeFileSync(${JSON.stringify(sentinel)}, '1');
    setTimeout(() => {}, 10000);
  `]);
  try {
    const t0 = Date.now();
    while (!fs.existsSync(sentinel) && Date.now() - t0 < 5000) {
      spawnSync('node', ['-e', 'setTimeout(()=>{},10)']);
    }
    assert.ok(fs.existsSync(sentinel), 'holder never took the mutex');
    const r = migrate([], repo, { EGHS_ADMIN_MUTEX_TIMEOUT_MS: '300' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /admin/);
    assert.equal(fs.readFileSync(path.join(stateDirOf(repo), 'schema_version'), 'utf8'), '2\n');
  } finally {
    holder.kill('SIGKILL');
  }
});

test('eghs-migrate leaves no migrate.lock and an unlocked mutex after a successful run', () => {
  const repo = repoNeedingMigrate();
  assert.equal(migrate([], repo).status, 0);
  assert.ok(!fs.existsSync(path.join(stateDirOf(repo), 'migrate.lock')));
  // A second run must not deadlock on a leaked flock.
  const again = migrate([], repo);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /no-op/);
});

// ---- --dry-run trace ----

test('eghs-migrate --dry-run traces the plan and writes nothing', () => {
  const repo = repoNeedingMigrate();
  const stateDir = stateDirOf(repo);
  fs.writeFileSync(path.join(stateDir, 'reads', 'aaa.json'), '{}');
  writeLease(repo, SID, {
    pid: deadPid(),
    uid: process.getuid(),
    start_ms: Date.now() - 3 * DAY_MS,
    renewed_ms: Date.now() - 3 * DAY_MS,
  });
  const r = migrate(['--dry-run'], repo);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dry-run/);
  assert.match(r.stdout, /would unlink/);
  assert.match(r.stdout, /would write schema_version=1/);
  assert.match(r.stdout, new RegExp(SID));
  // Nothing may have changed on disk.
  assert.equal(fs.readFileSync(path.join(stateDir, 'schema_version'), 'utf8'), '2\n');
  assert.ok(fs.existsSync(path.join(stateDir, 'reads', 'aaa.json')));
  assert.ok(fs.existsSync(path.join(stateDir, 'sessions', `${SID}.json`)));
  assert.ok(!fs.existsSync(path.join(stateDir, 'migrate.lock')));
});

test('eghs-migrate --dry-run reports a would-abort without touching state', () => {
  const repo = repoNeedingMigrate();
  writeLease(repo, SID, {
    pid: process.pid,
    uid: process.getuid(),
    start_ms: Date.now(),
    renewed_ms: Date.now(),
  });
  const r = migrate(['--dry-run'], repo);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /would abort/);
  assert.equal(fs.readFileSync(path.join(stateDirOf(repo), 'schema_version'), 'utf8'), '2\n');
});

test('eghs-migrate rejects unknown options', () => {
  const repo = repoNeedingMigrate();
  const r = migrate(['--nope'], repo);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--nope/);
});

// ---- unit 13: --clear-sid (PRD §R2.5 §301-323) ----

function initedRepo() {
  const repo = mkTmpRepo();
  init(repo);
  return repo;
}

function seedSid(repo, sid, leaseBody) {
  const stateDir = stateDirOf(repo);
  if (leaseBody !== null) writeLease(repo, sid, leaseBody);
  fs.writeFileSync(path.join(stateDir, 'baselines', `${sid}.txt`), '{}');
  fs.writeFileSync(path.join(stateDir, 'debug', `${sid}.jsonl`), '');
  fs.mkdirSync(path.join(stateDir, 'verify-logs', sid), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'pre', sid), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'failed', sid), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'locks', `stop-${sid}.lock`), '{}');
  fs.writeFileSync(
    path.join(stateDir, 'failed', 'keyscoped.json'),
    JSON.stringify({ schema_version: 1, origin_sid: sid, ts_ms: 1, reason: 'x' })
  );
}

function sidResidue(repo, sid) {
  const stateDir = stateDirOf(repo);
  return [
    path.join(stateDir, 'sessions', `${sid}.json`),
    path.join(stateDir, 'sessions', `${sid}.guard.lock`),
    path.join(stateDir, 'sessions', `${sid}.tombstone`),
    path.join(stateDir, 'baselines', `${sid}.txt`),
    path.join(stateDir, 'debug', `${sid}.jsonl`),
    path.join(stateDir, 'verify-logs', sid),
    path.join(stateDir, 'pre', sid),
    path.join(stateDir, 'failed', sid),
    path.join(stateDir, 'locks', `stop-${sid}.lock`),
    path.join(stateDir, 'failed', 'keyscoped.json'),
  ].filter((p) => fs.existsSync(p));
}

test('--clear-sid removes a dead sid with its full cascade and cleans up after itself', () => {
  const repo = initedRepo();
  seedSid(repo, SID, {
    pid: deadPid(),
    uid: process.getuid(),
    start_ms: Date.now(),
    renewed_ms: Date.now(),
  });
  const r = migrate(['--clear-sid', SID], repo);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(sidResidue(repo, SID), []);
  assert.ok(!fs.existsSync(path.join(stateDirOf(repo), 'migrate.lock')));
});

test('--clear-sid leaves other sids untouched', () => {
  const repo = initedRepo();
  const other = '22222222-2222-4222-8222-222222222222';
  seedSid(repo, SID, { pid: deadPid(), uid: process.getuid(), start_ms: 1, renewed_ms: 1 });
  seedSid(repo, other, { pid: process.pid, uid: process.getuid(), start_ms: 1, renewed_ms: 1 });
  assert.equal(migrate(['--clear-sid', SID], repo).status, 0);
  assert.ok(fs.existsSync(path.join(stateDirOf(repo), 'sessions', `${other}.json`)));
  assert.ok(fs.existsSync(path.join(stateDirOf(repo), 'baselines', `${other}.txt`)));
});

test('--clear-sid refuses a live lease without --force', () => {
  const repo = initedRepo();
  seedSid(repo, SID, { pid: process.pid, uid: process.getuid(), start_ms: 1, renewed_ms: 1 });
  const r = migrate(['--clear-sid', SID], repo);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /lease pid alive; refusing without --force/);
  assert.ok(fs.existsSync(path.join(stateDirOf(repo), 'sessions', `${SID}.json`)));
  assert.ok(!fs.existsSync(path.join(stateDirOf(repo), 'sessions', `${SID}.tombstone`)));
});

test('--clear-sid --force clears a live lease through the tombstone barrier', () => {
  const repo = initedRepo();
  seedSid(repo, SID, { pid: process.pid, uid: process.getuid(), start_ms: 1, renewed_ms: 1 });
  const r = migrate(['--clear-sid', SID, '--force'], repo);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(sidResidue(repo, SID), []);
});

test('--clear-sid refuses a corrupt lease body without --force', () => {
  const repo = initedRepo();
  seedSid(repo, SID, null);
  fs.writeFileSync(path.join(stateDirOf(repo), 'sessions', `${SID}.json`), '{ nope');
  const r = migrate(['--clear-sid', SID], repo);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /lease body corrupt; --force required/);
});

test('--clear-sid --force clears a corrupt lease body', () => {
  const repo = initedRepo();
  seedSid(repo, SID, null);
  fs.writeFileSync(path.join(stateDirOf(repo), 'sessions', `${SID}.json`), '{ nope');
  const r = migrate(['--clear-sid', SID, '--force'], repo);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(sidResidue(repo, SID), []);
});

test('--clear-sid rejects a foreign-uid lease and names --force-foreign-cleanup', () => {
  const repo = initedRepo();
  seedSid(repo, SID, { pid: deadPid(), uid: process.getuid() + 1, start_ms: 1, renewed_ms: 1 });
  const r = migrate(['--clear-sid', SID, '--force'], repo);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /foreign uid; use --force-foreign-cleanup instead/);
});

test('--clear-sid --force-foreign-cleanup clears a foreign-uid lease', () => {
  const repo = initedRepo();
  seedSid(repo, SID, { pid: deadPid(), uid: process.getuid() + 1, start_ms: 1, renewed_ms: 1 });
  const r = migrate(['--clear-sid', SID, '--force-foreign-cleanup'], repo);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(sidResidue(repo, SID), []);
});

test('--clear-sid works when the lease is absent (baseline-only corruption)', () => {
  const repo = initedRepo();
  seedSid(repo, SID, null);
  const r = migrate(['--clear-sid', SID], repo);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(sidResidue(repo, SID), []);
});

test('--clear-sid rejects a non-UUIDv4 sid', () => {
  const repo = initedRepo();
  const r = migrate(['--clear-sid', '../../etc'], repo);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /UUIDv4/);
});

test('--clear-sid aborts when hooks do not drain, leaving the tombstone in place', () => {
  const repo = initedRepo();
  seedSid(repo, SID, { pid: deadPid(), uid: process.getuid(), start_ms: 1, renewed_ms: 1 });
  const guard = path.join(stateDirOf(repo), 'sessions', `${SID}.guard.lock`);
  const sentinel = path.join(repo, 'guard-held');
  const holder = spawn('node', ['-e', `
    const fs = require('fs');
    const { flockSync } = require(${JSON.stringify(require.resolve('fs-ext'))});
    const fd = fs.openSync(${JSON.stringify(guard)}, 'w');
    flockSync(fd, 'shnb');
    fs.writeFileSync(${JSON.stringify(sentinel)}, '1');
    setTimeout(() => {}, 10000);
  `]);
  try {
    const t0 = Date.now();
    while (!fs.existsSync(sentinel) && Date.now() - t0 < 5000) {
      spawnSync('node', ['-e', 'setTimeout(()=>{},10)']);
    }
    assert.ok(fs.existsSync(sentinel), 'holder never took the guard');
    const r = migrate(['--clear-sid', SID], repo, { EGHS_CLEAR_SID_WAIT_MS: '300' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /drain/);
    assert.ok(fs.existsSync(path.join(stateDirOf(repo), 'sessions', `${SID}.tombstone`)));
    assert.ok(fs.existsSync(path.join(stateDirOf(repo), 'sessions', `${SID}.json`)));
    assert.ok(!fs.existsSync(path.join(stateDirOf(repo), 'migrate.lock')));
  } finally {
    holder.kill('SIGKILL');
  }
});

test('--clear-sid resumes from a same-uid dead clearer tombstone', () => {
  const repo = initedRepo();
  seedSid(repo, SID, { pid: deadPid(), uid: process.getuid(), start_ms: 1, renewed_ms: 1 });
  fs.writeFileSync(
    path.join(stateDirOf(repo), 'sessions', `${SID}.tombstone`),
    JSON.stringify({ cleared_by_pid: deadPid(), cleared_by_uid: process.getuid(), ts_ms: 1, reason: 'clear-sid' })
  );
  const r = migrate(['--clear-sid', SID], repo);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(sidResidue(repo, SID), []);
});

test('--clear-sid aborts on a tombstone held by a live clearer', () => {
  const repo = initedRepo();
  seedSid(repo, SID, { pid: deadPid(), uid: process.getuid(), start_ms: 1, renewed_ms: 1 });
  fs.writeFileSync(
    path.join(stateDirOf(repo), 'sessions', `${SID}.tombstone`),
    JSON.stringify({ cleared_by_pid: process.pid, cleared_by_uid: process.getuid(), ts_ms: 1, reason: 'clear-sid' })
  );
  const r = migrate(['--clear-sid', SID], repo);
  assert.notEqual(r.status, 0);
  assert.ok(fs.existsSync(path.join(stateDirOf(repo), 'sessions', `${SID}.json`)));
});

test('--clear-sid aborts while a migrate.lock is held', () => {
  const repo = initedRepo();
  seedSid(repo, SID, { pid: deadPid(), uid: process.getuid(), start_ms: 1, renewed_ms: 1 });
  fs.writeFileSync(
    path.join(stateDirOf(repo), 'migrate.lock'),
    JSON.stringify({ pid: process.pid, uid: process.getuid(), start_ms: Date.now(), role: 'migrate' })
  );
  const r = migrate(['--clear-sid', SID], repo);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /migrate\.lock/);
  assert.ok(fs.existsSync(path.join(stateDirOf(repo), 'sessions', `${SID}.json`)));
});

// ---- unit 13: --clear-migrate-lock / --clear-init-lock (PRD §324-343) ----

test('--clear-migrate-lock is a no-op when the lock is absent', () => {
  const repo = initedRepo();
  const r = migrate(['--clear-migrate-lock'], repo);
  assert.equal(r.status, 0, r.stderr);
});

test('--clear-migrate-lock unlinks a symlink without following it', () => {
  const repo = initedRepo();
  const target = path.join(repo, 'precious.txt');
  fs.writeFileSync(target, 'keep me');
  fs.symlinkSync(target, path.join(stateDirOf(repo), 'migrate.lock'));
  const r = migrate(['--clear-migrate-lock'], repo);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(stateDirOf(repo), 'migrate.lock')));
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep me');
});

test('--clear-migrate-lock removes a FIFO without opening it', () => {
  const repo = initedRepo();
  const lockPath = path.join(stateDirOf(repo), 'migrate.lock');
  assert.equal(spawnSync('mkfifo', [lockPath]).status, 0);
  const r = migrate(['--clear-migrate-lock'], repo);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(lockPath));
});

test('--clear-migrate-lock rmdirs an empty directory but refuses a non-empty one', () => {
  const repo = initedRepo();
  const lockPath = path.join(stateDirOf(repo), 'migrate.lock');
  fs.mkdirSync(lockPath);
  fs.writeFileSync(path.join(lockPath, 'stuff'), 'x');
  const refused = migrate(['--clear-migrate-lock'], repo);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /not empty/);
  fs.rmSync(path.join(lockPath, 'stuff'));
  const r = migrate(['--clear-migrate-lock'], repo);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(lockPath));
});

test('--clear-migrate-lock removes a corrupt-body regular lock', () => {
  const repo = initedRepo();
  const lockPath = path.join(stateDirOf(repo), 'migrate.lock');
  fs.writeFileSync(lockPath, '{ nope');
  assert.equal(migrate(['--clear-migrate-lock'], repo).status, 0);
  assert.ok(!fs.existsSync(lockPath));
});

test('--clear-migrate-lock refuses a live lock', () => {
  const repo = initedRepo();
  const lockPath = path.join(stateDirOf(repo), 'migrate.lock');
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, uid: process.getuid(), start_ms: Date.now(), role: 'migrate' })
  );
  const r = migrate(['--clear-migrate-lock'], repo);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, new RegExp(`held by pid=${process.pid}`));
  assert.ok(fs.existsSync(lockPath));
});

test('--clear-migrate-lock refuses a dead lock still within its grace', () => {
  const repo = initedRepo();
  const lockPath = path.join(stateDirOf(repo), 'migrate.lock');
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: deadPid(), uid: process.getuid(), start_ms: Date.now(), role: 'migrate' })
  );
  const r = migrate(['--clear-migrate-lock'], repo);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /grace/);
  assert.ok(fs.existsSync(lockPath));
});

test('--clear-migrate-lock removes a dead lock past its grace', () => {
  const repo = initedRepo();
  const lockPath = path.join(stateDirOf(repo), 'migrate.lock');
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: deadPid(), uid: process.getuid(), start_ms: Date.now() - 700000, role: 'migrate' })
  );
  assert.equal(migrate(['--clear-migrate-lock'], repo).status, 0);
  assert.ok(!fs.existsSync(lockPath));
});

test('--clear-migrate-lock treats a body uid that disagrees with st_uid as corrupt', () => {
  const repo = initedRepo();
  const lockPath = path.join(stateDirOf(repo), 'migrate.lock');
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, uid: process.getuid() + 1, start_ms: Date.now(), role: 'migrate' })
  );
  assert.equal(migrate(['--clear-migrate-lock'], repo).status, 0);
  assert.ok(!fs.existsSync(lockPath));
});

test('--clear-init-lock removes a corrupt .init.lock and unblocks eghs-init --repair', () => {
  const repo = initedRepo();
  const lockPath = path.join(stateDirOf(repo), '.init.lock');
  fs.writeFileSync(lockPath, '{ nope');
  assert.equal(migrate(['--clear-init-lock'], repo).status, 0);
  assert.ok(!fs.existsSync(lockPath));
  assert.equal(spawnSync('node', [INIT_SCRIPT, '--repair'], { cwd: repo, encoding: 'utf8' }).status, 0);
});

test('--clear-init-lock refuses a live .init.lock', () => {
  const repo = initedRepo();
  const lockPath = path.join(stateDirOf(repo), '.init.lock');
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, uid: process.getuid(), start_ms: Date.now() }));
  const r = migrate(['--clear-init-lock'], repo);
  assert.notEqual(r.status, 0);
  assert.ok(fs.existsSync(lockPath));
});

test('--clear-init-lock removes a dead .init.lock past its 60s grace', () => {
  const repo = initedRepo();
  const lockPath = path.join(stateDirOf(repo), '.init.lock');
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: deadPid(), uid: process.getuid(), start_ms: Date.now() - 61000 })
  );
  assert.equal(migrate(['--clear-init-lock'], repo).status, 0);
  assert.ok(!fs.existsSync(lockPath));
});

test('the clear-* commands are mutually exclusive and reject --dry-run', () => {
  const repo = initedRepo();
  const both = migrate(['--clear-migrate-lock', '--clear-init-lock'], repo);
  assert.notEqual(both.status, 0);
  assert.match(both.stderr, /one command/);
  const dry = migrate(['--clear-migrate-lock', '--dry-run'], repo);
  assert.notEqual(dry.status, 0);
  assert.match(dry.stderr, /--dry-run/);
  const stray = migrate(['--force'], repo);
  assert.notEqual(stray.status, 0);
  assert.match(stray.stderr, /--force/);
});
