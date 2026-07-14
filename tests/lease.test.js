'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { establishLeaseAndBaseline } = require('../hooks/lib/lease');

const SID = '11111111-1111-4111-8111-111111111111';

function mkStateDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-lease-'));
  for (const d of ['sessions/tmp', 'baselines/tmp', 'verify-logs', 'debug', 'pre', 'failed', 'locks']) {
    fs.mkdirSync(path.join(dir, d), { recursive: true });
  }
  return dir;
}

function deadPid() {
  return spawnSync('node', ['-e', '']).pid;
}

function leaseP(dir) {
  return path.join(dir, 'sessions', `${SID}.json`);
}
function baseP(dir) {
  return path.join(dir, 'baselines', `${SID}.txt`);
}
function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const ME = { pid: process.pid, uid: process.getuid(), repoRoot: null };

function run(dir, { nowMs = 1000, events } = {}) {
  return establishLeaseAndBaseline(dir, SID, {
    ...ME,
    nowMs,
    onEvent: events ? (e) => events.push(e) : undefined,
  });
}

test('fresh sid: creates lease (schema_version, start_ms=now) and baseline anchored to it', () => {
  const dir = mkStateDir();
  const r = run(dir, { nowMs: 1234 });
  assert.equal(r.ok, true);
  const lease = readJson(leaseP(dir));
  assert.equal(lease.schema_version, 1);
  assert.equal(lease.pid, process.pid);
  assert.equal(lease.start_ms, 1234);
  const base = readJson(baseP(dir));
  assert.equal(base.lease_start_ms, 1234);
  assert.equal(base.lease_pid, process.pid);
  assert.equal(typeof base.commit, 'string'); // getHeadCommit(cwd) or NO_GIT sentinel
});

test('same pid again: renews renewed_ms, keeps start_ms, reuses baseline (branch 6.3b.1)', () => {
  const dir = mkStateDir();
  run(dir, { nowMs: 1000 });
  const r = run(dir, { nowMs: 9999 });
  assert.equal(r.ok, true);
  const lease = readJson(leaseP(dir));
  assert.equal(lease.start_ms, 1000);
  assert.equal(lease.renewed_ms, 9999);
  assert.equal(readJson(baseP(dir)).lease_start_ms, 1000);
});

test('anchor matches but lease held by a LIVE foreign pid → SID_COLLISION (branch 2) + logs detail', () => {
  const dir = mkStateDir();
  // A live pid that is not ours: use this test runner's parent.
  const foreign = process.ppid;
  fs.writeFileSync(leaseP(dir), JSON.stringify({ schema_version: 1, pid: foreign, uid: process.getuid(), start_ms: 5, renewed_ms: 5 }));
  fs.writeFileSync(baseP(dir), JSON.stringify({ commit: 'NO_GIT', lease_start_ms: 5, lease_pid: foreign }));
  const events = [];
  const r = run(dir, { events });
  assert.equal(r.candidate, 'SID_COLLISION');
  // live lease must be untouched
  assert.equal(readJson(leaseP(dir)).pid, foreign);
  // §808: collision detail logged
  const col = events.find((e) => e.event === 'sid_collision');
  assert.ok(col && col.foreign_pid === foreign && col.current_pid === process.pid);
});

test('anchor mismatch with a LIVE lease pid → SID_COLLISION, no cleanup (branch 3)', () => {
  const dir = mkStateDir();
  const foreign = process.ppid;
  fs.writeFileSync(leaseP(dir), JSON.stringify({ schema_version: 1, pid: foreign, uid: process.getuid(), start_ms: 5, renewed_ms: 5 }));
  fs.writeFileSync(baseP(dir), JSON.stringify({ commit: 'NO_GIT', lease_start_ms: 999, lease_pid: 424242 }));
  const r = run(dir);
  assert.equal(r.candidate, 'SID_COLLISION');
  assert.ok(fs.existsSync(baseP(dir)));
});

test('dead lease pid (anchor match or not) → stale-cleanup preserves prior start_ms (branch 4 + iii)', () => {
  const dir = mkStateDir();
  fs.writeFileSync(leaseP(dir), JSON.stringify({ schema_version: 1, pid: deadPid(), uid: process.getuid(), start_ms: 777, renewed_ms: 777 }));
  fs.writeFileSync(baseP(dir), JSON.stringify({ commit: 'NO_GIT', lease_start_ms: 999, lease_pid: 424242 })); // mismatch
  // seed sid-scoped debris that the cleanup cascade must remove
  fs.mkdirSync(path.join(dir, 'pre', SID), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pre', SID, 'aa.toolu_A.write.json'), '{}');
  fs.writeFileSync(path.join(dir, 'failed', 'bb.json'), JSON.stringify({ origin_sid: SID, ts_ms: 1, reason: 'stale_read' }));
  const r = run(dir, { nowMs: 5000 });
  assert.equal(r.ok, true);
  const lease = readJson(leaseP(dir));
  assert.equal(lease.pid, process.pid);
  assert.equal(lease.start_ms, 777, 'prior start_ms must survive a clean cascade');
  assert.equal(readJson(baseP(dir)).lease_start_ms, 777);
  assert.ok(!fs.existsSync(path.join(dir, 'pre', SID)), 'sid pre/ debris cascaded');
  assert.ok(!fs.existsSync(path.join(dir, 'failed', 'bb.json')), 'own-origin key-scoped marker cascaded');
});

test('sessions file ABSENT but baseline present → stale-cleanup with start_ms = now (branch 4)', () => {
  const dir = mkStateDir();
  fs.writeFileSync(baseP(dir), JSON.stringify({ commit: 'NO_GIT', lease_start_ms: 5, lease_pid: 424242 }));
  const r = run(dir, { nowMs: 4242 });
  assert.equal(r.ok, true);
  assert.equal(readJson(leaseP(dir)).start_ms, 4242);
  assert.equal(readJson(baseP(dir)).lease_start_ms, 4242);
});

test('corrupt lease body → INFRA_NOT_READY lease_unavailable, lease untouched (precondition)', () => {
  const dir = mkStateDir();
  fs.writeFileSync(leaseP(dir), '{ not json');
  const r = run(dir);
  assert.equal(r.candidate, 'INFRA_NOT_READY');
  assert.equal(r.reason, 'lease_unavailable');
  assert.equal(fs.readFileSync(leaseP(dir), 'utf8'), '{ not json', 'corrupt lease must never be unlinked');
});

test('lease with insane start_ms (far future) → lease_unavailable, no unlink (precondition sanity)', () => {
  const dir = mkStateDir();
  fs.writeFileSync(
    leaseP(dir),
    JSON.stringify({ schema_version: 1, pid: deadPid(), uid: process.getuid(), start_ms: Date.now() + 999 * 86400000, renewed_ms: 1 })
  );
  fs.writeFileSync(baseP(dir), JSON.stringify({ commit: 'NO_GIT', lease_start_ms: 1, lease_pid: 2 }));
  const r = run(dir, { nowMs: Date.now() });
  assert.equal(r.candidate, 'INFRA_NOT_READY');
  assert.equal(r.reason, 'lease_unavailable');
  assert.ok(fs.existsSync(leaseP(dir)));
});

test('baseline parse fail + OWN live lease → lease_unavailable, nothing unlinked (branch 5)', () => {
  const dir = mkStateDir();
  fs.writeFileSync(leaseP(dir), JSON.stringify({ schema_version: 1, pid: process.pid, uid: process.getuid(), start_ms: 5, renewed_ms: 5 }));
  fs.writeFileSync(baseP(dir), '{ not json');
  const r = run(dir);
  assert.equal(r.candidate, 'INFRA_NOT_READY');
  assert.equal(r.reason, 'lease_unavailable');
  assert.ok(fs.existsSync(leaseP(dir)));
  assert.equal(fs.readFileSync(baseP(dir), 'utf8'), '{ not json');
});

test('baseline parse fail + FOREIGN live lease → SID_COLLISION (branch 6)', () => {
  const dir = mkStateDir();
  fs.writeFileSync(leaseP(dir), JSON.stringify({ schema_version: 1, pid: process.ppid, uid: process.getuid(), start_ms: 5, renewed_ms: 5 }));
  fs.writeFileSync(baseP(dir), '{ not json');
  const r = run(dir);
  assert.equal(r.candidate, 'SID_COLLISION');
});

test('baseline parse fail + DEAD lease → stale-cleanup succeeds (branch 4 parse-fail arm)', () => {
  const dir = mkStateDir();
  fs.writeFileSync(leaseP(dir), JSON.stringify({ schema_version: 1, pid: deadPid(), uid: process.getuid(), start_ms: 42, renewed_ms: 42 }));
  fs.writeFileSync(baseP(dir), '{ not json');
  const r = run(dir, { nowMs: 5000 });
  assert.equal(r.ok, true);
  assert.equal(readJson(leaseP(dir)).start_ms, 42);
});

test('EPERM during cascade → start_ms falls back to max(now, prior+1) + eperm event (iii fallback)', () => {
  if (process.getuid && process.getuid() === 0) return;
  const dir = mkStateDir();
  fs.writeFileSync(leaseP(dir), JSON.stringify({ schema_version: 1, pid: deadPid(), uid: process.getuid(), start_ms: 9000, renewed_ms: 9000 }));
  fs.writeFileSync(baseP(dir), JSON.stringify({ commit: 'NO_GIT', lease_start_ms: 1, lease_pid: 2 }));
  fs.mkdirSync(path.join(dir, 'failed', SID), { recursive: true });
  fs.writeFileSync(path.join(dir, 'failed', SID, 'x.json'), '{}');
  fs.chmodSync(path.join(dir, 'failed', SID), 0o555);
  const events = [];
  let r;
  try {
    r = run(dir, { nowMs: 5000, events }); // nowMs < prior start_ms: clamp must pick prior+1
  } finally {
    fs.chmodSync(path.join(dir, 'failed', SID), 0o700);
  }
  assert.equal(r.ok, true);
  assert.equal(readJson(leaseP(dir)).start_ms, 9001);
  assert.ok(events.some((e) => e.event === 'eperm_start_ms_fallback'));
});
