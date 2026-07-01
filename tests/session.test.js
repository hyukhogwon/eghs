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

test('gcSessions removes leases whose pid is dead and past staleness window', () => {
  const stateDir = mkStateDir();
  fs.writeFileSync(
    path.join(stateDir, 'sessions', 'sid-dead.json'),
    JSON.stringify({ pid: 999999, uid: process.getuid(), start_ms: 0, renewed_ms: 0 })
  );
  gcSessions(stateDir, { nowMs: 999_999_999, sessionStaleSeconds: 86400 });
  assert.ok(!fs.existsSync(path.join(stateDir, 'sessions', 'sid-dead.json')));
});

test('gcSessions keeps leases for live pids even if renewed_ms is old', () => {
  const stateDir = mkStateDir();
  fs.writeFileSync(
    path.join(stateDir, 'sessions', 'sid-live.json'),
    JSON.stringify({ pid: process.pid, uid: process.getuid(), start_ms: 0, renewed_ms: 0 })
  );
  gcSessions(stateDir, { nowMs: 999_999_999, sessionStaleSeconds: 86400 });
  assert.ok(fs.existsSync(path.join(stateDir, 'sessions', 'sid-live.json')));
});

test('gcSessions keeps leases that are dead but not yet past the staleness window', () => {
  const stateDir = mkStateDir();
  fs.writeFileSync(
    path.join(stateDir, 'sessions', 'sid-recent-dead.json'),
    JSON.stringify({ pid: 999999, uid: process.getuid(), start_ms: 0, renewed_ms: 900_000 })
  );
  gcSessions(stateDir, { nowMs: 1_000_000, sessionStaleSeconds: 86400 });
  assert.ok(fs.existsSync(path.join(stateDir, 'sessions', 'sid-recent-dead.json')));
});
