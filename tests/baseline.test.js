'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureBaseline } = require('../hooks/lib/baseline');
const { SidCollisionError } = require('../hooks/lib/session');

function mkStateDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-baseline-'));
  fs.mkdirSync(path.join(dir, 'baselines', 'tmp'), { recursive: true });
  return dir;
}

test('ensureBaseline creates a new baseline anchored to the current lease', () => {
  const stateDir = mkStateDir();
  const lease = { pid: process.pid, start_ms: 1000 };
  const result = ensureBaseline(stateDir, 'sid-1', { lease, repoRoot: '/tmp/no-git-here' });
  assert.equal(result.commit, 'NO_GIT');
  const body = JSON.parse(
    fs.readFileSync(path.join(stateDir, 'baselines', 'sid-1.txt'), 'utf8')
  );
  assert.equal(body.lease_start_ms, 1000);
  assert.equal(body.lease_pid, process.pid);
});

test('ensureBaseline reuses an existing baseline when the anchor matches the lease', () => {
  const stateDir = mkStateDir();
  const lease = { pid: process.pid, start_ms: 1000 };
  const first = ensureBaseline(stateDir, 'sid-2', { lease, repoRoot: '/tmp/no-git-here' });
  const second = ensureBaseline(stateDir, 'sid-2', { lease, repoRoot: '/tmp/no-git-here' });
  assert.equal(second.commit, first.commit);
});

test('ensureBaseline runs stale-cleanup and rewrites the anchor when the lease pid is dead', () => {
  const stateDir = mkStateDir();
  fs.writeFileSync(
    path.join(stateDir, 'baselines', 'sid-3.txt'),
    JSON.stringify({ commit: 'deadbeef', lease_start_ms: 1, lease_pid: 999999 })
  );
  const lease = { pid: process.pid, start_ms: 2000 };
  const result = ensureBaseline(stateDir, 'sid-3', { lease, repoRoot: '/tmp/no-git-here' });
  const body = JSON.parse(
    fs.readFileSync(path.join(stateDir, 'baselines', 'sid-3.txt'), 'utf8')
  );
  assert.equal(body.lease_start_ms, 2000);
  assert.equal(body.lease_pid, process.pid);
  assert.equal(result.commit, 'NO_GIT');
});

test('ensureBaseline throws SidCollisionError when anchor mismatches a live foreign pid', () => {
  const stateDir = mkStateDir();
  // pid 1 (init/launchd) is always alive on macOS/Linux and guaranteed
  // different from this test process's own pid.
  fs.writeFileSync(
    path.join(stateDir, 'baselines', 'sid-4.txt'),
    JSON.stringify({ commit: 'deadbeef', lease_start_ms: 1, lease_pid: 1 })
  );
  const lease = { pid: process.pid, start_ms: 999 };
  assert.throws(
    () => ensureBaseline(stateDir, 'sid-4', { lease, repoRoot: '/tmp/no-git-here' }),
    SidCollisionError
  );
});

test('ensureBaseline does not clobber a live anchor that appears mid-reclaim (simulated TOCTOU race)', () => {
  const stateDir = mkStateDir();
  const filePath = path.join(stateDir, 'baselines', 'sid-6.txt');
  const deadBody = JSON.stringify({ commit: 'deadbeef', lease_start_ms: 1, lease_pid: 999999 });
  // pid 1 (init/launchd) is always alive and guaranteed different from ours.
  const liveBody = JSON.stringify({ commit: 'cafef00d', lease_start_ms: 500, lease_pid: 1 });
  fs.writeFileSync(filePath, deadBody);

  const originalReadFileSync = fs.readFileSync;
  let callCount = 0;
  fs.readFileSync = function (p, ...args) {
    if (p === filePath) {
      callCount += 1;
      // 1st read: ensureBaseline's initial anchor check sees the dead
      // entry. 2nd read: claimBaseline's re-verify-before-unlink —
      // simulate a concurrent claimant having replaced it with a live
      // anchor by then.
      if (callCount === 2) {
        fs.writeFileSync(filePath, liveBody);
        return liveBody;
      }
    }
    return originalReadFileSync.call(fs, p, ...args);
  };

  const lease = { pid: process.pid, start_ms: 2000 };
  try {
    assert.throws(
      () => ensureBaseline(stateDir, 'sid-6', { lease, repoRoot: '/tmp/no-git-here' }),
      SidCollisionError
    );
  } finally {
    fs.readFileSync = originalReadFileSync;
  }

  // The racing claimant's live anchor must survive untouched.
  assert.equal(fs.readFileSync(filePath, 'utf8'), liveBody);
});

test('ensureBaseline resolves the real HEAD commit inside an actual git repo', () => {
  const { execFileSync } = require('child_process');
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-baseline-git-'));
  execFileSync('git', ['init', '-q'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'eghs-test'], { cwd: repoRoot });
  fs.writeFileSync(path.join(repoRoot, 'a.txt'), 'hi\n');
  execFileSync('git', ['add', 'a.txt'], { cwd: repoRoot });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoRoot });

  const stateDir = mkStateDir();
  const lease = { pid: process.pid, start_ms: 1000 };
  const result = ensureBaseline(stateDir, 'sid-5', { lease, repoRoot });
  assert.match(result.commit, /^[0-9a-f]{40}$/);
});
