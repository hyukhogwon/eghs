'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureSessionLease, gcSessions, sweepOrphanTombstones, SidCollisionError } = require('../hooks/lib/session');

function writeLease(stateDir, sid, body) {
  fs.mkdirSync(path.join(stateDir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'sessions', `${sid}.json`), JSON.stringify(body));
}

function mkStateDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-session-'));
  fs.mkdirSync(path.join(dir, 'sessions', 'tmp'), { recursive: true });
  return dir;
}

test('ensureSessionLease creates a new lease when absent', () => {
  const stateDir = mkStateDir();
  const lease = ensureSessionLease(stateDir, 'sid-1', {
    pid: process.pid,
    uid: process.getuid(),
    nowMs: 1000,
  });
  assert.equal(lease.pid, process.pid);
  assert.equal(lease.start_ms, 1000);
  assert.equal(lease.renewed_ms, 1000);
});

test('ensureSessionLease renews (updates renewed_ms, keeps start_ms) for the same pid', () => {
  const stateDir = mkStateDir();
  ensureSessionLease(stateDir, 'sid-2', { pid: process.pid, uid: process.getuid(), nowMs: 1000 });
  const renewed = ensureSessionLease(stateDir, 'sid-2', {
    pid: process.pid,
    uid: process.getuid(),
    nowMs: 5000,
  });
  assert.equal(renewed.start_ms, 1000);
  assert.equal(renewed.renewed_ms, 5000);
});

test('ensureSessionLease throws SidCollisionError when a different, live pid holds the lease', () => {
  const stateDir = mkStateDir();
  fs.writeFileSync(
    path.join(stateDir, 'sessions', 'sid-3.json'),
    JSON.stringify({ pid: process.pid, uid: process.getuid(), start_ms: 1, renewed_ms: 1 })
  );
  assert.throws(
    () =>
      ensureSessionLease(stateDir, 'sid-3', {
        pid: process.pid + 1,
        uid: process.getuid(),
        nowMs: 2000,
      }),
    SidCollisionError
  );
});

test('ensureSessionLease recreates the lease for the current pid when the old lease pid is dead', () => {
  const stateDir = mkStateDir();
  fs.writeFileSync(
    path.join(stateDir, 'sessions', 'sid-dead-lease.json'),
    JSON.stringify({ pid: 999999, uid: process.getuid(), start_ms: 1, renewed_ms: 1 })
  );
  const lease = ensureSessionLease(stateDir, 'sid-dead-lease', {
    pid: process.pid,
    uid: process.getuid(),
    nowMs: 2000,
  });
  assert.equal(lease.pid, process.pid);
  assert.equal(lease.start_ms, 2000);
});

test('ensureSessionLease does not clobber a live lease that appears mid-reclaim (simulated TOCTOU race)', () => {
  const stateDir = mkStateDir();
  const filePath = path.join(stateDir, 'sessions', 'sid-race.json');
  const deadBody = JSON.stringify({ pid: 999999, uid: process.getuid(), start_ms: 1, renewed_ms: 1 });
  // pid 1 (init/launchd) is always alive and guaranteed different from ours.
  const liveBody = JSON.stringify({ pid: 1, uid: process.getuid(), start_ms: 500, renewed_ms: 500 });
  fs.writeFileSync(filePath, deadBody);

  const originalReadFileSync = fs.readFileSync;
  let callCount = 0;
  fs.readFileSync = function (p, ...args) {
    if (p === filePath) {
      callCount += 1;
      // 1st read: ensureSessionLease's initial existing-check sees the dead
      // lease. 2nd read: claimLease's re-verify-before-unlink — simulate a
      // concurrent claimant having replaced it with a live lease by then.
      if (callCount === 2) {
        originalReadFileSync !== fs.readFileSync && fs.writeFileSync(filePath, liveBody);
        return liveBody;
      }
    }
    return originalReadFileSync.call(fs, p, ...args);
  };

  try {
    assert.throws(
      () =>
        ensureSessionLease(stateDir, 'sid-race', {
          pid: process.pid,
          uid: process.getuid(),
          nowMs: 2000,
        }),
      SidCollisionError
    );
  } finally {
    fs.readFileSync = originalReadFileSync;
  }

  // The racing writer's live lease must survive untouched — the fixed code
  // must re-verify before unlinking rather than deleting blindly.
  assert.equal(fs.readFileSync(filePath, 'utf8'), liveBody);
});

test('gcSessions removes leases whose pid is dead and past staleness window', () => {
  const stateDir = mkStateDir();
  fs.writeFileSync(
    path.join(stateDir, 'sessions', 'sid-dead.json'),
    JSON.stringify({ pid: 999999, uid: process.getuid(), start_ms: 0, renewed_ms: 0 })
  );
  gcSessions(stateDir, { nowMs: 999_999_999, uid: process.getuid(), sessionStaleSeconds: 86400 });
  assert.ok(!fs.existsSync(path.join(stateDir, 'sessions', 'sid-dead.json')));
});

test('gcSessions keeps leases for live pids even if renewed_ms is old', () => {
  const stateDir = mkStateDir();
  fs.writeFileSync(
    path.join(stateDir, 'sessions', 'sid-live.json'),
    JSON.stringify({ pid: process.pid, uid: process.getuid(), start_ms: 0, renewed_ms: 0 })
  );
  gcSessions(stateDir, { nowMs: 999_999_999, uid: process.getuid(), sessionStaleSeconds: 86400 });
  assert.ok(fs.existsSync(path.join(stateDir, 'sessions', 'sid-live.json')));
});

test('gcSessions keeps leases that are dead but not yet past the staleness window', () => {
  const stateDir = mkStateDir();
  fs.writeFileSync(
    path.join(stateDir, 'sessions', 'sid-recent-dead.json'),
    JSON.stringify({ pid: 999999, uid: process.getuid(), start_ms: 0, renewed_ms: 900_000 })
  );
  gcSessions(stateDir, { nowMs: 1_000_000, uid: process.getuid(), sessionStaleSeconds: 86400 });
  assert.ok(fs.existsSync(path.join(stateDir, 'sessions', 'sid-recent-dead.json')));
});

test('gcSessions keeps a stale dead-pid lease belonging to a different uid', () => {
  const stateDir = mkStateDir();
  fs.writeFileSync(
    path.join(stateDir, 'sessions', 'sid-foreign-uid.json'),
    JSON.stringify({ pid: 999999, uid: process.getuid() + 1, start_ms: 0, renewed_ms: 0 })
  );
  gcSessions(stateDir, { nowMs: 999_999_999, uid: process.getuid(), sessionStaleSeconds: 86400 });
  assert.ok(fs.existsSync(path.join(stateDir, 'sessions', 'sid-foreign-uid.json')));
});

test('gcSessions does not delete a lease that was reclaimed (became live) mid-scan (simulated TOCTOU race)', () => {
  const stateDir = mkStateDir();
  const filePath = path.join(stateDir, 'sessions', 'sid-gc-race.json');
  const deadBody = JSON.stringify({ pid: 999999, uid: process.getuid(), start_ms: 0, renewed_ms: 0 });
  const liveBody = JSON.stringify({ pid: 1, uid: process.getuid(), start_ms: 500, renewed_ms: 500 });
  fs.writeFileSync(filePath, deadBody);

  const originalReadFileSync = fs.readFileSync;
  let callCount = 0;
  fs.readFileSync = function (p, ...args) {
    if (p === filePath) {
      callCount += 1;
      // 1st read: gcSessions' staleness/liveness evaluation sees the dead
      // lease. 2nd read: the re-verify-before-unlink — simulate a
      // concurrent reclaim having replaced it with a live lease by then.
      if (callCount === 2) {
        fs.writeFileSync(filePath, liveBody);
        return liveBody;
      }
    }
    return originalReadFileSync.call(fs, p, ...args);
  };

  try {
    gcSessions(stateDir, { nowMs: 999_999_999, uid: process.getuid(), sessionStaleSeconds: 86400 });
  } finally {
    fs.readFileSync = originalReadFileSync;
  }

  assert.equal(fs.readFileSync(filePath, 'utf8'), liveBody);
});

// ---- P4 unit 7: cascade GC (PRD R6 #5b, R2.5 §238-240) ----

const DEAD_SID_C = '77777777-7777-4777-8777-777777777777';

function seedSidState(stateDir, sid) {
  for (const d of ['sessions', 'baselines', 'debug', 'locks', path.join('verify-logs', sid), path.join('pre', sid), path.join('failed', sid)]) {
    fs.mkdirSync(path.join(stateDir, d), { recursive: true });
  }
  fs.writeFileSync(path.join(stateDir, 'baselines', `${sid}.txt`), '{}');
  fs.writeFileSync(path.join(stateDir, 'verify-logs', sid, 'typecheck.log'), 'x');
  fs.writeFileSync(path.join(stateDir, 'debug', `${sid}.jsonl`), '{}');
  fs.writeFileSync(path.join(stateDir, 'pre', sid, 'aa.toolu_A.write.json'), '{}');
  fs.writeFileSync(path.join(stateDir, 'failed', sid, 'bb.json'), '{}');
  fs.writeFileSync(path.join(stateDir, 'locks', `stop-${sid}.lock`), '{}');
  fs.writeFileSync(path.join(stateDir, 'locks', `stop-${sid}.recover.lock`), '{}');
  fs.writeFileSync(path.join(stateDir, 'sessions', `${sid}.guard.lock`), '');
}

test('gcSessions cascades every sid-scoped artifact before removing the lease', () => {
  const stateDir = mkStateDir();
  seedSidState(stateDir, DEAD_SID_C);
  const deadPid = require('child_process').spawnSync('node', ['-e', '']).pid;
  writeLease(stateDir, DEAD_SID_C, { pid: deadPid, uid: process.getuid(), start_ms: 1, renewed_ms: 1 });
  gcSessions(stateDir, { nowMs: 999_999_999, uid: process.getuid(), sessionStaleSeconds: 86400 });
  assert.ok(!fs.existsSync(path.join(stateDir, 'sessions', `${DEAD_SID_C}.json`)));
  assert.ok(!fs.existsSync(path.join(stateDir, 'sessions', `${DEAD_SID_C}.guard.lock`)));
  assert.ok(!fs.existsSync(path.join(stateDir, 'baselines', `${DEAD_SID_C}.txt`)));
  assert.ok(!fs.existsSync(path.join(stateDir, 'verify-logs', DEAD_SID_C)));
  assert.ok(!fs.existsSync(path.join(stateDir, 'debug', `${DEAD_SID_C}.jsonl`)));
  assert.ok(!fs.existsSync(path.join(stateDir, 'pre', DEAD_SID_C)));
  assert.ok(!fs.existsSync(path.join(stateDir, 'failed', DEAD_SID_C)));
  assert.ok(!fs.existsSync(path.join(stateDir, 'locks', `stop-${DEAD_SID_C}.lock`)));
  assert.ok(!fs.existsSync(path.join(stateDir, 'locks', `stop-${DEAD_SID_C}.recover.lock`)));
});

test('gcSessions keeps the lease when a cascade target fails with EPERM (retry next pass)', () => {
  if (process.getuid && process.getuid() === 0) return; // root bypasses modes
  const stateDir = mkStateDir();
  seedSidState(stateDir, DEAD_SID_C);
  const deadPid = require('child_process').spawnSync('node', ['-e', '']).pid;
  writeLease(stateDir, DEAD_SID_C, { pid: deadPid, uid: process.getuid(), start_ms: 1, renewed_ms: 1 });
  const lockedDir = path.join(stateDir, 'failed', DEAD_SID_C);
  fs.chmodSync(lockedDir, 0o555); // entries become non-unlinkable → real failure
  const events = [];
  try {
    gcSessions(stateDir, {
      nowMs: 999_999_999,
      uid: process.getuid(),
      sessionStaleSeconds: 86400,
      onEvent: (e) => events.push(e),
    });
  } finally {
    fs.chmodSync(lockedDir, 0o700);
  }
  assert.ok(fs.existsSync(path.join(stateDir, 'sessions', `${DEAD_SID_C}.json`)), 'lease must survive a partial cascade');
  assert.ok(events.some((e) => e.event === 'sessions_gc_partial' && e.sid === DEAD_SID_C));
});

test('sweepOrphanTombstones removes only aged, sibling-free, own-uid tombstones', () => {
  const stateDir = mkStateDir();
  fs.mkdirSync(path.join(stateDir, 'sessions'), { recursive: true });
  const mk = (sid, body) =>
    fs.writeFileSync(path.join(stateDir, 'sessions', `${sid}.tombstone`), JSON.stringify(body));
  const uid = process.getuid();
  const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'; // aged orphan (goes)
  const B = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'; // fresh orphan (stays)
  const C = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'; // has sibling lease (stays)
  const D = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4'; // foreign uid (stays)
  const nowMs = 10_000_000;
  mk(A, { cleared_by_pid: 1, cleared_by_uid: uid, ts_ms: nowMs - 3700_000, reason: 'clear-sid' });
  mk(B, { cleared_by_pid: 1, cleared_by_uid: uid, ts_ms: nowMs - 1000, reason: 'clear-sid' });
  mk(C, { cleared_by_pid: 1, cleared_by_uid: uid, ts_ms: nowMs - 3700_000, reason: 'clear-sid' });
  writeLease(stateDir, C, { pid: process.pid, uid, start_ms: 1, renewed_ms: 1 });
  mk(D, { cleared_by_pid: 1, cleared_by_uid: uid + 1, ts_ms: nowMs - 3700_000, reason: 'clear-sid' });
  sweepOrphanTombstones(stateDir, { nowMs, uid, tombstoneStaleSeconds: 3600 });
  assert.ok(!fs.existsSync(path.join(stateDir, 'sessions', `${A}.tombstone`)));
  assert.ok(fs.existsSync(path.join(stateDir, 'sessions', `${B}.tombstone`)));
  assert.ok(fs.existsSync(path.join(stateDir, 'sessions', `${C}.tombstone`)));
  assert.ok(fs.existsSync(path.join(stateDir, 'sessions', `${D}.tombstone`)));
});
