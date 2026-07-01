'use strict';
const fs = require('fs');
const path = require('path');
const { atomicWriteFile } = require('./atomic-write');
const { exclusiveLinkCreate } = require('./exclusive-link');
const { isAlive } = require('./proc');

class SidCollisionError extends Error {
  constructor(msg) {
    super(`SID_COLLISION: ${msg}`);
    this.name = 'SidCollisionError';
  }
}

function leasePath(stateDir, sid) {
  return path.join(stateDir, 'sessions', `${sid}.json`);
}

function readLease(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function sameEntry(a, b) {
  return !!a && !!b && a.pid === b.pid && a.start_ms === b.start_ms;
}

// Claim (create or reclaim) the lease via link(2) exclusivity rather than a
// blind rename-overwrite, so a lease that a concurrent claimant creates in
// the TOCTOU window is detected (EEXIST) instead of silently clobbered.
// `expectedDead` is the entry we last observed as safe to replace (or null
// for "no lease existed") — re-verified immediately before any unlink so we
// never delete a lease that changed out from under us. PRD §R6 6.3: lease
// body must never overwrite a live foreign pid.
function claimLease(filePath, expectedDead, { sid, pid, uid, nowMs }, attemptsLeft) {
  if (attemptsLeft <= 0) {
    throw new Error(`INFRA_NOT_READY: could not establish session lease for sid ${sid}`);
  }

  if (expectedDead) {
    const stillThere = readLease(filePath);
    if (!sameEntry(stillThere, expectedDead)) {
      // Content changed since we decided it was safe to reclaim — re-derive
      // the decision from what's actually there now rather than unlinking
      // blindly.
      if (stillThere && stillThere.pid === pid) return stillThere;
      if (stillThere && isAlive(stillThere.pid)) {
        throw new SidCollisionError(
          `sid ${sid} claimed by live pid ${stillThere.pid} during reclaim race (current pid ${pid})`
        );
      }
      return claimLease(filePath, stillThere, { sid, pid, uid, nowMs }, attemptsLeft - 1);
    }
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ENOENT: someone else already cleaned it up; fall through to create.
    }
  }

  const lease = { pid, uid, start_ms: nowMs, renewed_ms: nowMs };
  const created = exclusiveLinkCreate(filePath, JSON.stringify(lease));
  if (created.ok) return lease;

  // Lost the race: re-evaluate whoever claimed it instead of overwriting.
  const raced = readLease(filePath);
  if (raced && raced.pid === pid) return raced;
  if (raced && isAlive(raced.pid)) {
    throw new SidCollisionError(
      `sid ${sid} claimed by live pid ${raced.pid} during reclaim race (current pid ${pid})`
    );
  }
  return claimLease(filePath, raced, { sid, pid, uid, nowMs }, attemptsLeft - 1);
}

// PRD §R6 6.3: create-or-renew. Never overwrites a live foreign-pid lease.
function ensureSessionLease(stateDir, sid, { pid, uid, nowMs }) {
  const filePath = leasePath(stateDir, sid);
  const existing = readLease(filePath);

  if (existing && existing.pid === pid) {
    // Renew: only the same pid ever mutates its own lease this way, so a
    // plain overwrite is safe — there is no foreign owner to clobber.
    const lease = { ...existing, renewed_ms: nowMs };
    atomicWriteFile(filePath, JSON.stringify(lease));
    return lease;
  }

  if (existing && isAlive(existing.pid)) {
    throw new SidCollisionError(
      `sid ${sid} already leased by live pid ${existing.pid} (current pid ${pid})`
    );
  }

  return claimLease(filePath, existing, { sid, pid, uid, nowMs }, 5);
}

// PRD §R2.5 sessions/ GC: only delete when ALL of (stale by time, same uid
// as the current GC caller, dead pid) hold. A foreign-uid dead lease is left
// alone — only `eghs-migrate --force-foreign-cleanup` (not built in P1) may
// remove those.
function gcSessions(stateDir, { nowMs, uid, sessionStaleSeconds = 86400 }) {
  const sessionsDir = path.join(stateDir, 'sessions');
  let entries = [];
  try {
    entries = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }

  for (const entry of entries) {
    const filePath = path.join(sessionsDir, entry);
    const body = readLease(filePath);
    if (!body) continue; // vanished mid-scan or corrupt -> leave for a later pass

    const staleByTime = nowMs - body.renewed_ms > sessionStaleSeconds * 1000;
    if (!staleByTime || body.uid !== uid || isAlive(body.pid)) continue;

    // Re-verify immediately before deleting: only remove the exact stale
    // entry we just evaluated, in case a new (live) lease replaced it
    // between the read above and now.
    const stillStale = readLease(filePath);
    if (!sameEntry(stillStale, body)) continue;
    try {
      fs.unlinkSync(filePath);
    } catch {
      // already gone -> fine
    }
  }
}

module.exports = { ensureSessionLease, gcSessions, SidCollisionError };
