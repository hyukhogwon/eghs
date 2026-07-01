'use strict';
const fs = require('fs');
const path = require('path');
const { exclusiveLinkCreate } = require('./exclusive-link');

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH'; // EPERM etc. => treat as alive (fail-closed)
  }
}

function readLockBody(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

// PRD §R2.5 "Exclusive lock 획득 절차" + stale recovery, scoped to what P1's
// single-writer (Stop hook) needs. The full recover-lock TOCTOU dance from
// the spec is collapsed here because only one process type ever contends
// for this lock in P1 (no PreToolUse/PostToolUse hooks exist yet).
function acquireStopLock(stateDir, sid, { pid, uid, timeoutMs, nowMs, graceMs = 5000 }) {
  const lockPath = path.join(stateDir, 'locks', `stop-${sid}.lock`);
  const body = JSON.stringify({ pid, uid, start_ms: nowMs, timeout_ms: timeoutMs });

  let result = exclusiveLinkCreate(lockPath, body);
  if (result.ok) return { ok: true, release: () => releaseOwn(lockPath, pid, nowMs) };

  // EEXIST: check staleness once, reclaim if safe, retry exactly once.
  const existing = readLockBody(lockPath);
  if (existing && existing.uid === uid) {
    const dead = !isAlive(existing.pid);
    const expired = nowMs > existing.start_ms + existing.timeout_ms + graceMs;
    if (dead && expired) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // ENOENT: someone else already reclaimed it; fall through to retry.
      }
      result = exclusiveLinkCreate(lockPath, body);
      if (result.ok) return { ok: true, release: () => releaseOwn(lockPath, pid, nowMs) };
    }
  }

  return { ok: false };
}

function releaseOwn(lockPath, pid, startMs) {
  const body = readLockBody(lockPath);
  // Not ours (e.g. reclaimed by someone else since acquisition) -> no-op.
  if (!body || body.pid !== pid || body.start_ms !== startMs) return;
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // already gone -> no-op
  }
}

module.exports = { acquireStopLock };
