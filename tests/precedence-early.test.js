'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');
const { earlyPrecedence } = require('../hooks/lib/precedence');
const { liveAnchor } = require('../hooks/lib/fs-info');
const { flockExNb } = require('../hooks/lib/flock');
const { sleepMs } = require('../hooks/lib/stdin');

const INIT_SCRIPT = path.join(__dirname, '..', 'hooks', 'init.js');
const SID = '11111111-1111-4111-8111-111111111111';

function mkRepo({ init = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-prec-')));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  if (init) execFileSync('node', [INIT_SCRIPT], { cwd: dir });
  return dir;
}

function stateDirOf(repo) {
  return path.join(repo, '.claude', 'state', 'eghs');
}

function run(kind, repo, opts = {}) {
  const sid = 'sid' in opts ? opts.sid : SID; // an explicit undefined must NOT fall back
  return earlyPrecedence(kind, { session_id: sid, ...(opts.input || {}) }, {
    env: { ...(opts.env || {}) },
    cwd: repo,
    nowMs: Date.now(),
  });
}

function closeGuard(r) {
  if (r.ctx && typeof r.ctx.guardFd === 'number') fs.closeSync(r.ctx.guardFd);
}

function captureStderr(fn) {
  const orig = process.stderr.write;
  let stderr = '';
  process.stderr.write = (chunk) => {
    stderr += chunk;
    return true;
  };
  try {
    return { result: fn(), stderr };
  } finally {
    process.stderr.write = orig;
  }
}

// Simulate the APFS synthetic-st_dev churn (reboot changes st_dev) by
// corrupting only the anchor of an otherwise healthy v2 body.
function breakAnchor(repo) {
  const p = path.join(stateDirOf(repo), 'fs-info.json');
  const body = JSON.parse(fs.readFileSync(p, 'utf8'));
  body.fs_st_dev = -1;
  fs.writeFileSync(p, JSON.stringify(body));
}

test('#2 kill switch wins over everything, even corrupt fs-info (mutation-free exit 0)', () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(stateDirOf(repo), 'fs-info.json'), '{ corrupt');
  fs.writeFileSync(path.join(repo, '.claude', 'eghs-off'), '');
  const r = run('pre-write', repo);
  assert.deepEqual(r, { outcome: 'exit0', reason: 'kill_switch' });
  // no guard.lock appeared (no mutation)
  assert.ok(!fs.existsSync(path.join(stateDirOf(repo), 'sessions', `${SID}.guard.lock`)));
});

test('#3 CI passthrough exits 0 for non-Stop hooks and is IGNORED for Stop', () => {
  const repo = mkRepo();
  const ci = { CI: 'true' };
  assert.equal(run('pre-write', repo, { env: ci }).outcome, 'exit0');
  assert.equal(run('post-read', repo, { env: ci }).outcome, 'exit0');
  assert.equal(run('ups', repo, { env: ci }).outcome, 'exit0');
  const stop = run('stop', repo, { env: ci });
  assert.equal(stop.outcome, 'continue', 'Stop must not honor CI passthrough (G3)');
  closeGuard(stop);
});

test('#1/#3.7 clean-install fast-path: schema absent → no guard, no tombstone stat, continue', () => {
  const repo = mkRepo({ init: false });
  const r = run('pre-write', repo);
  assert.equal(r.outcome, 'continue');
  assert.equal(r.ctx.diskSchema, null);
  assert.equal(r.ctx.guardFd, null);
  assert.ok(!fs.existsSync(path.join(stateDirOf(repo), 'sessions', `${SID}.guard.lock`)));
});

test('#3.3 unhealthy fs-info (schema present) → INFRA_NOT_READY candidate, reason infra_not_ready', () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(stateDirOf(repo), 'fs-info.json'), '{ corrupt');
  const { result: r, stderr } = captureStderr(() => run('pre-write', repo));
  assert.equal(r.outcome, 'candidate');
  assert.equal(r.candidate, 'INFRA_NOT_READY');
  assert.equal(r.reason, 'infra_not_ready');
  // The remediation line IS the user-facing contract for this row (PRD §681-685).
  assert.match(stderr, /fs-info\.json corrupt; run: eghs-init --repair/);
});

test('#3.3 flock_ok !== true names the flock case on stderr, not the generic corrupt one', () => {
  const repo = mkRepo();
  const p = path.join(stateDirOf(repo), 'fs-info.json');
  const body = JSON.parse(fs.readFileSync(p, 'utf8'));
  fs.writeFileSync(p, JSON.stringify({ ...body, flock_ok: false }));
  const { result: r, stderr } = captureStderr(() => run('pre-write', repo));
  assert.equal(r.candidate, 'INFRA_NOT_READY');
  assert.match(stderr, /flock_ok not true; run: eghs-init --repair/);
});

test('#3.3 MISSING fs-info defers to #7 (continue, fsInfo status carried in ctx)', () => {
  const repo = mkRepo();
  fs.rmSync(path.join(stateDirOf(repo), 'fs-info.json'));
  const r = run('pre-write', repo);
  assert.equal(r.outcome, 'continue');
  assert.equal(r.ctx.fsInfo.status, 'missing');
  closeGuard(r);
});

test('#3.5 NO_SESSION per-hook outcomes (PRD R6 #3.5)', () => {
  const repo = mkRepo();
  for (const sid of [undefined, 'nope', 'AAAAAAAA-1111-4111-8111-111111111111']) {
    assert.deepEqual(run('pre-write', repo, { sid }), { outcome: 'deny', denyCode: 'NO_SESSION' });
    assert.deepEqual(run('pre-read', repo, { sid }), { outcome: 'deny', denyCode: 'NO_SESSION' });
    assert.deepEqual(run('post-write', repo, { sid }), { outcome: 'exit0', reason: 'no_session' });
    assert.deepEqual(run('post-read', repo, { sid }), { outcome: 'exit0', reason: 'no_session' });
    assert.deepEqual(run('ups', repo, { sid }), { outcome: 'exit0', reason: 'no_session' });
    assert.deepEqual(run('stop', repo, { sid }), { outcome: 'deny', denyCode: 'NO_SESSION' });
  }
});

test('#3.5 comes after #2: kill switch beats NO_SESSION', () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, '.claude', 'eghs-off'), '');
  assert.deepEqual(run('pre-write', repo, { sid: undefined }), { outcome: 'exit0', reason: 'kill_switch' });
});

test('#3.7 tombstone present → sid_cleared candidate, guard never created', () => {
  const repo = mkRepo();
  const sessions = path.join(stateDirOf(repo), 'sessions');
  fs.writeFileSync(
    path.join(sessions, `${SID}.tombstone`),
    JSON.stringify({ cleared_by_pid: 1, cleared_by_uid: process.getuid(), ts_ms: 1, reason: 'clear-sid' })
  );
  const r = run('pre-write', repo);
  assert.equal(r.outcome, 'candidate');
  assert.equal(r.candidate, 'INFRA_NOT_READY');
  assert.equal(r.reason, 'sid_cleared');
  assert.ok(!fs.existsSync(path.join(sessions, `${SID}.guard.lock`)));
});

test('#3.7 sessions/ dir manually deleted (schema present) → infra_not_ready candidate', () => {
  const repo = mkRepo();
  fs.rmSync(path.join(stateDirOf(repo), 'sessions'), { recursive: true, force: true });
  const { result: r, stderr } = captureStderr(() => run('pre-write', repo));
  assert.equal(r.outcome, 'candidate');
  assert.equal(r.reason, 'infra_not_ready');
  // ENOENT is the only guard failure that earns repair guidance (PRD §706).
  assert.match(stderr, /sessions\/ missing; run: eghs-init --repair/);
  assert.ok(!fs.existsSync(path.join(stateDirOf(repo), 'sessions')), 'must not recreate the dir');
});

test('#3.7 normal path: shared guard held for the hook lifetime (child EX would-block)', () => {
  const repo = mkRepo();
  const r = run('pre-write', repo);
  assert.equal(r.outcome, 'continue');
  assert.equal(typeof r.ctx.guardFd, 'number');
  const guardPath = path.join(stateDirOf(repo), 'sessions', `${SID}.guard.lock`);
  assert.ok(fs.existsSync(guardPath));
  const child = spawnSync(process.execPath, ['-e', `
    const fs = require('fs');
    const { flockSync } = require(${JSON.stringify(require.resolve('fs-ext'))});
    const fd = fs.openSync(${JSON.stringify(guardPath)}, 'r');
    try { flockSync(fd, 'exnb'); process.exit(3); } catch (e) { process.exit(0); }
  `]);
  assert.equal(child.status, 0, 'exclusive must be blocked while the hook holds shared');
  closeGuard(r);
});

test('#3.7 exclusive holder (clear-sid in flight) → sid_cleared, no deadlock', () => {
  const repo = mkRepo();
  const guardPath = path.join(stateDirOf(repo), 'sessions', `${SID}.guard.lock`);
  const sentinel = path.join(repo, 'holder-ready');
  const holder = spawn(process.execPath, ['-e', `
    const fs = require('fs');
    const { flockSync } = require(${JSON.stringify(require.resolve('fs-ext'))});
    const fd = fs.openSync(${JSON.stringify(guardPath)}, 'w');
    flockSync(fd, 'exnb');
    fs.writeFileSync(${JSON.stringify(sentinel)}, '1');
    setTimeout(() => {}, 10000);
  `]);
  try {
    const t0 = Date.now();
    while (!fs.existsSync(sentinel) && Date.now() - t0 < 5000) sleepMs(10);
    assert.ok(fs.existsSync(sentinel));
    const r = run('pre-write', repo);
    assert.equal(r.outcome, 'candidate');
    assert.equal(r.reason, 'sid_cleared');
  } finally {
    holder.kill('SIGKILL');
  }
});

test('#3.7 tombstone created between stat and lock is caught by the re-stat (sid_cleared)', () => {
  // Direct simulation of the race outcome: tombstone appears, then a fresh
  // call must still return sid_cleared even though a guard fd was created
  // by the earlier call.
  const repo = mkRepo();
  const first = run('pre-write', repo);
  assert.equal(first.outcome, 'continue');
  closeGuard(first);
  fs.writeFileSync(
    path.join(stateDirOf(repo), 'sessions', `${SID}.tombstone`),
    JSON.stringify({ cleared_by_pid: 1, cleared_by_uid: process.getuid(), ts_ms: 1, reason: 'clear-sid' })
  );
  const r = run('pre-write', repo);
  assert.equal(r.reason, 'sid_cleared');
});

test('#3.3 anchor mismatch self-heals: re-probe under .init.lock, rewrite, continue (2026-07-19)', () => {
  const repo = mkRepo();
  breakAnchor(repo);
  const { result: r, stderr } = captureStderr(() => run('pre-write', repo));
  assert.equal(r.outcome, 'continue');
  assert.equal(r.ctx.fsInfo.status, 'ok');
  // fs-info.json rewritten with the live anchor + freshly probed caseless.
  const body = JSON.parse(fs.readFileSync(path.join(stateDirOf(repo), 'fs-info.json'), 'utf8'));
  const anchor = liveAnchor(stateDirOf(repo));
  assert.equal(body.fs_st_dev, anchor.fsStDev);
  assert.equal(body.fs_statfs_id, anchor.fsStatfsId);
  assert.equal(body.flock_ok, true);
  assert.equal(r.ctx.caseless, body.caseless_fs, 'ctx must carry the fresh probe value');
  // Exactly one warn line, and the .init.lock was released.
  const lines = stderr.split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /fs-info anchor changed — re-probed/);
  assert.ok(!fs.existsSync(path.join(stateDirOf(repo), '.init.lock')));
  closeGuard(r);
});

test('#3.3 anchor mismatch + .init.lock held by a live process → fail-closed INFRA_NOT_READY', () => {
  const repo = mkRepo();
  breakAnchor(repo);
  fs.writeFileSync(
    path.join(stateDirOf(repo), '.init.lock'),
    JSON.stringify({ pid: process.pid, uid: process.getuid(), start_ms: Date.now() })
  );
  const { result: r } = captureStderr(() => run('pre-write', repo));
  assert.equal(r.outcome, 'candidate');
  assert.equal(r.candidate, 'INFRA_NOT_READY');
  assert.equal(r.reason, 'infra_not_ready');
  // No self-heal ran: the stale anchor body is untouched, lock still there.
  const body = JSON.parse(fs.readFileSync(path.join(stateDirOf(repo), 'fs-info.json'), 'utf8'));
  assert.equal(body.fs_st_dev, -1);
  assert.ok(fs.existsSync(path.join(stateDirOf(repo), '.init.lock')));
});

test('#3.3 anchor mismatch + probe failure → fail-closed, .init.lock never leaked', () => {
  const repo = mkRepo();
  breakAnchor(repo);
  // Turn tmp/ into a regular file: the flock-probe mkdir throws mid-probe.
  const tmp = path.join(stateDirOf(repo), 'tmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.writeFileSync(tmp, 'not a dir');
  const { result: r } = captureStderr(() => run('pre-write', repo));
  assert.equal(r.outcome, 'candidate');
  assert.equal(r.candidate, 'INFRA_NOT_READY');
  assert.equal(r.reason, 'infra_not_ready');
  assert.ok(!fs.existsSync(path.join(stateDirOf(repo), '.init.lock')), 'failed heal must release the lock');
});

test('#3.3 non-anchor unhealthy reasons never re-probe (flock_not_ok stays fail-closed)', () => {
  const repo = mkRepo();
  const p = path.join(stateDirOf(repo), 'fs-info.json');
  const body = JSON.parse(fs.readFileSync(p, 'utf8'));
  body.flock_ok = false;
  fs.writeFileSync(p, JSON.stringify(body));
  const before = fs.readFileSync(p, 'utf8');
  const { result: r } = captureStderr(() => run('pre-write', repo));
  assert.equal(r.outcome, 'candidate');
  assert.equal(r.candidate, 'INFRA_NOT_READY');
  assert.equal(fs.readFileSync(p, 'utf8'), before, 'no rewrite for non-anchor unhealthy');
  assert.ok(!fs.existsSync(path.join(stateDirOf(repo), '.init.lock')));
});

test('ctx carries stateDir, repoRoot, sid and caseless for downstream stages', () => {
  const repo = mkRepo();
  const r = run('pre-write', repo);
  assert.equal(r.outcome, 'continue');
  assert.equal(r.ctx.sid, SID);
  assert.equal(r.ctx.repoRoot, repo);
  assert.equal(r.ctx.stateDir, stateDirOf(repo));
  assert.equal(typeof r.ctx.caseless, 'boolean');
  assert.equal(r.ctx.diskSchema, 1);
  closeGuard(r);
});

test('INVALID schema continues through #3.3/#3.7 (deny happens at #7, never fail-open)', () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(stateDirOf(repo), 'schema_version'), '01\n'); // leading zero = INVALID
  fs.rmSync(path.join(stateDirOf(repo), 'fs-info.json'));
  const r = run('pre-write', repo);
  // #3.3 runs for INVALID too; missing fs-info defers, guard still acquired.
  assert.equal(r.outcome, 'continue');
  assert.equal(r.ctx.diskSchema, 'INVALID');
  assert.equal(r.ctx.fsInfo.status, 'missing');
  closeGuard(r);
});
