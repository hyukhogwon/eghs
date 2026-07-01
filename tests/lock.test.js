'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { acquireStopLock } = require('../hooks/lib/lock');

function mkStateDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-lock-'));
  for (const sub of ['locks', path.join('locks', 'tmp')]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

test('acquireStopLock succeeds when no lock exists, and release() removes it', () => {
  const stateDir = mkStateDir();
  const result = acquireStopLock(stateDir, 'sid-1', {
    pid: process.pid,
    uid: process.getuid(),
    timeoutMs: 45000,
    nowMs: 1000,
  });
  assert.equal(result.ok, true);
  const lockPath = path.join(stateDir, 'locks', 'stop-sid-1.lock');
  assert.ok(fs.existsSync(lockPath));
  result.release();
  assert.ok(!fs.existsSync(lockPath));
});

test('acquireStopLock fails (fail-closed) when a live same-pid lock already exists', () => {
  const stateDir = mkStateDir();
  const first = acquireStopLock(stateDir, 'sid-2', {
    pid: process.pid,
    uid: process.getuid(),
    timeoutMs: 45000,
    nowMs: 1000,
  });
  assert.equal(first.ok, true);
  const second = acquireStopLock(stateDir, 'sid-2', {
    pid: process.pid,
    uid: process.getuid(),
    timeoutMs: 45000,
    nowMs: 1500,
  });
  assert.equal(second.ok, false);
  first.release();
});

test('acquireStopLock reclaims a lock held by a dead pid past grace, then succeeds', () => {
  const stateDir = mkStateDir();
  const deadPid = 999999; // astronomically unlikely to be alive
  const lockPath = path.join(stateDir, 'locks', 'stop-sid-3.lock');
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: deadPid, uid: process.getuid(), start_ms: 0, timeout_ms: 100 })
  );
  const result = acquireStopLock(stateDir, 'sid-3', {
    pid: process.pid,
    uid: process.getuid(),
    timeoutMs: 45000,
    nowMs: 10_000, // well past start_ms(0) + timeout_ms(100) + graceMs
  });
  assert.equal(result.ok, true);
  result.release();
});

test('acquireStopLock does not reclaim a lock owned by a different uid (fail-closed)', () => {
  const stateDir = mkStateDir();
  const lockPath = path.join(stateDir, 'locks', 'stop-sid-4.lock');
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: 999999, uid: process.getuid() + 1, start_ms: 0, timeout_ms: 100 })
  );
  const result = acquireStopLock(stateDir, 'sid-4', {
    pid: process.pid,
    uid: process.getuid(),
    timeoutMs: 45000,
    nowMs: 999_999,
  });
  assert.equal(result.ok, false);
});

test('release() is a no-op (does not throw) if called twice', () => {
  const stateDir = mkStateDir();
  const result = acquireStopLock(stateDir, 'sid-5', {
    pid: process.pid,
    uid: process.getuid(),
    timeoutMs: 45000,
    nowMs: 1000,
  });
  result.release();
  assert.doesNotThrow(() => result.release());
});

test('acquireStopLock does not reclaim a live same-uid lock even if grace elapsed', () => {
  const stateDir = mkStateDir();
  const lockPath = path.join(stateDir, 'locks', 'stop-sid-6.lock');
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, uid: process.getuid(), start_ms: 0, timeout_ms: 100 })
  );
  const result = acquireStopLock(stateDir, 'sid-6', {
    pid: process.pid,
    uid: process.getuid(),
    timeoutMs: 45000,
    nowMs: 999_999,
  });
  assert.equal(result.ok, false);
});

test('release() does not remove a lock that was reclaimed by someone else in the meantime', () => {
  const stateDir = mkStateDir();
  const result = acquireStopLock(stateDir, 'sid-7', {
    pid: process.pid,
    uid: process.getuid(),
    timeoutMs: 45000,
    nowMs: 1000,
  });
  assert.equal(result.ok, true);
  const lockPath = path.join(stateDir, 'locks', 'stop-sid-7.lock');
  // Simulate a different owner overwriting the lock file after reclaim.
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 424242, uid: process.getuid(), start_ms: 2000, timeout_ms: 45000 }));
  result.release();
  assert.ok(fs.existsSync(lockPath));
});
