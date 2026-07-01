'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureSessionLease, gcSessions, SidCollisionError } = require('../hooks/lib/session');

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
