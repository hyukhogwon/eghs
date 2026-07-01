'use strict';
const fs = require('fs');
const path = require('path');
const { exclusiveLinkCreate } = require('./exclusive-link');
const { isAlive } = require('./proc');

const NOOP_RELEASE = () => {};

function readLockBody(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

function sameEntry(a, b) {
  return !!a && !!b && a.pid === b.pid && a.start_ms === b.start_ms;
}

function isStale(body, uid, nowMs, graceMs) {
  return (
    !!body &&
    body.uid === uid &&
    !isAlive(body.pid) &&
    nowMs > body.start_ms + body.timeout_ms + graceMs
  );
}

// PRD §R2.5 "Exclusive lock 획득 절차" + stale recovery, scoped to what P1's
// single-writer (Stop hook) needs. The full recover-lock TOCTOU dance from
// the spec is collapsed here because only one process type ever contends
// for this lock in P1 (no PreToolUse/PostToolUse hooks exist yet) — but a
// second concurrent Stop invocation for the same sid is still possible, so
// reclaim always re-verifies immediately before its destructive unlink
// rather than deleting whatever it read moments earlier.
function acquireStopLock(stateDir, sid, { pid, uid, timeoutMs, nowMs, graceMs = 5000 }) {
  const lockPath = path.join(stateDir, 'locks', `stop-${sid}.lock`);
  return claimLock(lockPath, null, { pid, uid, timeoutMs, nowMs, graceMs }, 5);
}

function claimLock(lockPath, expectedStale, opts, attemptsLeft) {
  const { pid, uid, timeoutMs, nowMs, graceMs } = opts;

  if (attemptsLeft <= 0) return { ok: false, release: NOOP_RELEASE };

  if (expectedStale) {
    const stillThere = readLockBody(lockPath);
    if (!sameEntry(stillThere, expectedStale)) {
      // Content changed since we decided it was safe to reclaim — never
      // unlink blindly. Re-derive the decision from what's there now.
      if (isStale(stillThere, uid, nowMs, graceMs)) {
        return claimLock(lockPath, stillThere, opts, attemptsLeft - 1);
      }
      return { ok: false, release: NOOP_RELEASE }; // now live/foreign/gone -> fail-closed
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // ENOENT: someone else already reclaimed it; fall through to retry.
    }
  }

  const body = JSON.stringify({ pid, uid, start_ms: nowMs, timeout_ms: timeoutMs });
  const created = exclusiveLinkCreate(lockPath, body);
  if (created.ok) return { ok: true, release: () => releaseOwn(lockPath, pid, nowMs) };

  const raced = readLockBody(lockPath);
  if (isStale(raced, uid, nowMs, graceMs)) {
    return claimLock(lockPath, raced, opts, attemptsLeft - 1);
  }
  return { ok: false, release: NOOP_RELEASE };
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
