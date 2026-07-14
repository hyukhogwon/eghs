'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const INIT_SCRIPT = path.join(__dirname, '..', 'hooks', 'init.js');

function mkTmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-init-'));
  return dir;
}

function run(args, cwd) {
  return execFileSync('node', [INIT_SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

test('eghs-init bootstraps schema_version and all P1 subdirs', () => {
  const repo = mkTmpRepo();
  run([], repo);
  const stateDir = path.join(repo, '.claude', 'state', 'eghs');
  assert.equal(fs.readFileSync(path.join(stateDir, 'schema_version'), 'utf8'), '1\n');
  for (const sub of ['locks', 'sessions', 'baselines', 'verify-logs', 'debug', 'tmp']) {
    assert.ok(fs.statSync(path.join(stateDir, sub)).isDirectory(), sub);
  }
});

test('eghs-init bootstraps the P3 state-writer subdirs', () => {
  const repo = mkTmpRepo();
  run([], repo);
  const stateDir = path.join(repo, '.claude', 'state', 'eghs');
  for (const sub of ['reads', path.join('reads', 'tmp'), 'failed', path.join('failed', 'tmp'), 'pre']) {
    assert.ok(fs.statSync(path.join(stateDir, sub)).isDirectory(), sub);
  }
});

test('eghs-init writes fs-info.json (boolean caseless_fs) and removes the probe files', () => {
  const repo = mkTmpRepo();
  run([], repo);
  const stateDir = path.join(repo, '.claude', 'state', 'eghs');
  const info = JSON.parse(fs.readFileSync(path.join(stateDir, 'fs-info.json'), 'utf8'));
  assert.equal(info.schema_version, 1);
  assert.equal(typeof info.caseless_fs, 'boolean');
  assert.equal(typeof info.ts_ms, 'number');
  assert.ok(!fs.existsSync(path.join(stateDir, '.cs-probe')));
  assert.ok(!fs.existsSync(path.join(stateDir, '.CS-PROBE')));
});

test('eghs-init --repair recreates a missing fs-info.json', () => {
  const repo = mkTmpRepo();
  run([], repo);
  const infoPath = path.join(repo, '.claude', 'state', 'eghs', 'fs-info.json');
  fs.rmSync(infoPath);
  run(['--repair'], repo);
  assert.equal(typeof JSON.parse(fs.readFileSync(infoPath, 'utf8')).caseless_fs, 'boolean');
});

test('eghs-init --repair keeps a healthy fs-info.json untouched (no re-probe)', () => {
  const repo = mkTmpRepo();
  run([], repo);
  const infoPath = path.join(repo, '.claude', 'state', 'eghs', 'fs-info.json');
  const healthy = fs.readFileSync(infoPath, 'utf8'); // real probe output = healthy v2
  run(['--repair'], repo);
  assert.equal(fs.readFileSync(infoPath, 'utf8'), healthy);
});

test('eghs-init --repair re-probes a legacy pre-R20 v1 fs-info.json (unhealthy cache, PRD Case 4)', () => {
  const repo = mkTmpRepo();
  run([], repo);
  const infoPath = path.join(repo, '.claude', 'state', 'eghs', 'fs-info.json');
  fs.writeFileSync(infoPath, JSON.stringify({ schema_version: 1, caseless_fs: false, ts_ms: 42 }));
  run(['--repair'], repo);
  const body = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
  assert.equal(body.flock_ok, true);
  assert.equal(typeof body.fs_st_dev, 'number');
});

test('eghs-init survives stale probe leftovers from a crashed previous run', () => {
  const repo = mkTmpRepo();
  const stateDir = path.join(repo, '.claude', 'state', 'eghs');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '.CS-PROBE'), '');
  run([], repo);
  assert.ok(!fs.existsSync(path.join(stateDir, '.CS-PROBE')));
  // Verdict must match a clean-room probe, not be poisoned by the leftover.
  const fresh = mkTmpRepo();
  run([], fresh);
  const verdict = (repo2) =>
    JSON.parse(
      fs.readFileSync(path.join(repo2, '.claude', 'state', 'eghs', 'fs-info.json'), 'utf8')
    ).caseless_fs;
  assert.equal(verdict(repo), verdict(fresh));
});

test('eghs-init refuses to run twice without --repair', () => {
  const repo = mkTmpRepo();
  run([], repo);
  assert.throws(() => run([], repo));
});

test('eghs-init --repair is idempotent when everything is already healthy', () => {
  const repo = mkTmpRepo();
  run([], repo);
  assert.doesNotThrow(() => run(['--repair'], repo));
});

test('eghs-init --repair recreates a manually deleted subdir', () => {
  const repo = mkTmpRepo();
  run([], repo);
  const locksDir = path.join(repo, '.claude', 'state', 'eghs', 'locks');
  fs.rmSync(locksDir, { recursive: true, force: true });
  run(['--repair'], repo);
  assert.ok(fs.statSync(locksDir).isDirectory());
});

test('eghs-init does not leak .init.lock after a successful run', () => {
  const repo = mkTmpRepo();
  run([], repo);
  assert.ok(!fs.existsSync(path.join(repo, '.claude', 'state', 'eghs', '.init.lock')));
});

test('eghs-init does not leak .init.lock when it refuses to run twice', () => {
  const repo = mkTmpRepo();
  run([], repo);
  assert.throws(() => run([], repo));
  assert.ok(!fs.existsSync(path.join(repo, '.claude', 'state', 'eghs', '.init.lock')));
});

test('eghs-init refuses to run while another .init.lock is held (concurrent bootstrap)', () => {
  const repo = mkTmpRepo();
  const stateDir = path.join(repo, '.claude', 'state', 'eghs');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '.init.lock'), '');
  assert.throws(() => run([], repo));
  // schema_version must not have been written while the lock was held.
  assert.ok(!fs.existsSync(path.join(stateDir, 'schema_version')));
});

// ---- P4 unit 4: R16-R20 admin-mutex / migrate.lock / .init.lock body ----

const { spawnSync, spawn } = require('child_process');

function runRaw(args, cwd, env = {}) {
  return spawnSync('node', [INIT_SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function stateDirOf(repo) {
  return path.join(repo, '.claude', 'state', 'eghs');
}

test('eghs-init acquires migrate.lock (role init) during the run and removes it after', () => {
  const repo = mkTmpRepo();
  run([], repo);
  assert.ok(!fs.existsSync(path.join(stateDirOf(repo), 'migrate.lock')));
  // admin-mutex.guard persists (existence is normal) but must be unlocked:
  // an immediate --repair would deadlock if init leaked the flock.
  assert.ok(fs.existsSync(path.join(stateDirOf(repo), 'locks', 'admin-mutex.guard')));
  assert.equal(runRaw(['--repair'], repo).status, 0);
});

test('eghs-init aborts while another process holds a LIVE migrate.lock (same uid)', () => {
  const repo = mkTmpRepo();
  const stateDir = stateDirOf(repo);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'migrate.lock'),
    JSON.stringify({ pid: process.pid, uid: process.getuid(), start_ms: Date.now(), role: 'migrate' })
  );
  const r = runRaw([], repo);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /migrate\.lock/);
  assert.ok(fs.existsSync(path.join(stateDir, 'migrate.lock')), 'live lock must survive');
});

test('eghs-init reclaims a same-uid DEAD migrate.lock past its grace and proceeds', () => {
  const repo = mkTmpRepo();
  const stateDir = stateDirOf(repo);
  fs.mkdirSync(stateDir, { recursive: true });
  const deadPid = spawnSync('node', ['-e', '']).pid;
  fs.writeFileSync(
    path.join(stateDir, 'migrate.lock'),
    JSON.stringify({ pid: deadPid, uid: process.getuid(), start_ms: Date.now() - 700000, role: 'migrate' })
  );
  const r = runRaw([], repo);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(stateDir, 'migrate.lock')));
  assert.equal(fs.readFileSync(path.join(stateDir, 'schema_version'), 'utf8'), '1\n');
});

test('eghs-init aborts on a same-uid dead migrate.lock still WITHIN its grace window', () => {
  const repo = mkTmpRepo();
  const stateDir = stateDirOf(repo);
  fs.mkdirSync(stateDir, { recursive: true });
  const deadPid = spawnSync('node', ['-e', '']).pid;
  fs.writeFileSync(
    path.join(stateDir, 'migrate.lock'),
    JSON.stringify({ pid: deadPid, uid: process.getuid(), start_ms: Date.now() - 1000, role: 'migrate' })
  );
  const r = runRaw([], repo);
  assert.notEqual(r.status, 0);
});

test('eghs-init aborts on a corrupt migrate.lock body and points at --clear-migrate-lock', () => {
  const repo = mkTmpRepo();
  const stateDir = stateDirOf(repo);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'migrate.lock'), '{ nope');
  const r = runRaw([], repo);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--clear-migrate-lock/);
});

test('eghs-init aborts when the admin mutex is held elsewhere (timeout, no state touched)', () => {
  const repo = mkTmpRepo();
  const stateDir = stateDirOf(repo);
  fs.mkdirSync(path.join(stateDir, 'locks'), { recursive: true });
  const guard = path.join(stateDir, 'locks', 'admin-mutex.guard');
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
    const r = runRaw([], repo, { EGHS_ADMIN_MUTEX_TIMEOUT_MS: '300' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /admin/);
    assert.ok(!fs.existsSync(path.join(stateDir, 'schema_version')));
  } finally {
    holder.kill('SIGKILL');
  }
});

test('.init.lock now carries a JSON body {pid, uid, start_ms}', () => {
  const repo = mkTmpRepo();
  const stateDir = stateDirOf(repo);
  fs.mkdirSync(stateDir, { recursive: true });
  // Block at step 4 by pre-holding .init.lock with a LIVE body, then check
  // the error message names the holder pid (proves the body was parsed).
  fs.writeFileSync(
    path.join(stateDir, '.init.lock'),
    JSON.stringify({ pid: process.pid, uid: process.getuid(), start_ms: Date.now() })
  );
  const r = runRaw([], repo);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, new RegExp(`pid=${process.pid}`));
});

test('.init.lock corrupt body aborts with --clear-init-lock guidance', () => {
  const repo = mkTmpRepo();
  const stateDir = stateDirOf(repo);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '.init.lock'), JSON.stringify({ pid: -5 }));
  const r = runRaw([], repo);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--clear-init-lock/);
});

test('.init.lock same-uid dead past 60s grace is reclaimed (init proceeds)', () => {
  const repo = mkTmpRepo();
  const stateDir = stateDirOf(repo);
  fs.mkdirSync(stateDir, { recursive: true });
  const deadPid = spawnSync('node', ['-e', '']).pid;
  fs.writeFileSync(
    path.join(stateDir, '.init.lock'),
    JSON.stringify({ pid: deadPid, uid: process.getuid(), start_ms: Date.now() - 61000 })
  );
  const r = runRaw([], repo);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(stateDir, 'schema_version'), 'utf8'), '1\n');
});

test('.init.lock same-uid dead WITHIN 60s grace aborts (recent-crash protection)', () => {
  const repo = mkTmpRepo();
  const stateDir = stateDirOf(repo);
  fs.mkdirSync(stateDir, { recursive: true });
  const deadPid = spawnSync('node', ['-e', '']).pid;
  fs.writeFileSync(
    path.join(stateDir, '.init.lock'),
    JSON.stringify({ pid: deadPid, uid: process.getuid(), start_ms: Date.now() - 1000 })
  );
  const r = runRaw([], repo);
  assert.notEqual(r.status, 0);
});

test('--repair Case 5 (everything healthy) is a silent no-op exit 0', () => {
  const repo = mkTmpRepo();
  run([], repo);
  const schemaPath = path.join(stateDirOf(repo), 'schema_version');
  const before = fs.statSync(schemaPath).mtimeMs;
  const r = runRaw(['--repair'], repo);
  assert.equal(r.status, 0);
  assert.equal(fs.statSync(schemaPath).mtimeMs, before, 'schema_version must not be rewritten');
});

test('--repair Case 1 (INVALID schema) rewrites schema_version after subdirs+fs-info', () => {
  const repo = mkTmpRepo();
  run([], repo);
  const schemaPath = path.join(stateDirOf(repo), 'schema_version');
  fs.writeFileSync(schemaPath, '01\n'); // leading zero = strict-regex INVALID
  const r = runRaw(['--repair'], repo);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(schemaPath, 'utf8'), '1\n');
});
