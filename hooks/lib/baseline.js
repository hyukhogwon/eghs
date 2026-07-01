'use strict';
const fs = require('fs');
const path = require('path');
const { exclusiveLinkCreate } = require('./exclusive-link');
const { getHeadCommit } = require('./git');
const { SidCollisionError } = require('./session');
const { isAlive } = require('./proc');

function baselinePath(stateDir, sid) {
  return path.join(stateDir, 'baselines', `${sid}.txt`);
}

// A corrupt/unparseable baseline is treated the same as a missing one — PRD
// §R6 6.3b.4 explicitly routes "baseline JSON parse 실패" into stale-cleanup.
function readBody(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function matchesAnchor(body, lease) {
  return !!body && body.lease_start_ms === lease.start_ms && body.lease_pid === lease.pid;
}

function sameEntry(a, b) {
  return !!a && !!b && a.lease_pid === b.lease_pid && a.lease_start_ms === b.lease_start_ms;
}

// PRD §R6 6.3a/b/c, scoped to P1's single writer (only Stop leases sessions,
// so baseline anchors only ever contend with a prior Stop invocation).
function ensureBaseline(stateDir, sid, { lease, repoRoot }) {
  const filePath = baselinePath(stateDir, sid);

  // Cheap path first: if our own anchor is already there, skip the git
  // subprocess and write entirely (this is the common case on every Stop
  // invocation after the first one in a session).
  const existing = readBody(filePath);
  if (matchesAnchor(existing, lease)) return { commit: existing.commit };
  if (existing && existing.lease_pid !== lease.pid && isAlive(existing.lease_pid)) {
    throw new SidCollisionError(
      `baseline for sid ${sid} anchored to live foreign pid ${existing.lease_pid}`
    );
  }

  const commit = getHeadCommit(repoRoot); // computed once, reused across retries
  return claimBaseline(filePath, existing, { sid, lease, commit }, 5);
}

// `expectedStale` is the entry we last observed as safe to replace (or null
// for "no baseline existed") — re-verified immediately before any unlink so
// a live anchor a concurrent claimant just wrote is never deleted.
function claimBaseline(filePath, expectedStale, { sid, lease, commit }, attemptsLeft) {
  if (attemptsLeft <= 0) {
    throw new Error(`INFRA_NOT_READY: could not establish baseline anchor for sid ${sid}`);
  }

  if (expectedStale) {
    const stillThere = readBody(filePath);
    if (!sameEntry(stillThere, expectedStale)) {
      // Content changed since we decided it was safe to reclaim — re-derive
      // the decision from what's actually there now rather than unlinking
      // blindly.
      if (matchesAnchor(stillThere, lease)) return { commit: stillThere.commit };
      if (stillThere && stillThere.lease_pid !== lease.pid && isAlive(stillThere.lease_pid)) {
        throw new SidCollisionError(
          `baseline for sid ${sid} anchored to live foreign pid ${stillThere.lease_pid}`
        );
      }
      return claimBaseline(filePath, stillThere, { sid, lease, commit }, attemptsLeft - 1);
    }
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ENOENT: another process already cleaned it up; fall through to retry.
    }
  }

  const body = { commit, lease_start_ms: lease.start_ms, lease_pid: lease.pid };
  const created = exclusiveLinkCreate(filePath, JSON.stringify(body));
  if (created.ok) return { commit: body.commit };

  // Lost the race: re-evaluate whoever claimed it instead of overwriting.
  const raced = readBody(filePath);
  if (matchesAnchor(raced, lease)) return { commit: raced.commit };
  if (raced && raced.lease_pid !== lease.pid && isAlive(raced.lease_pid)) {
    throw new SidCollisionError(
      `baseline for sid ${sid} claimed by live pid ${raced.lease_pid} during reclaim race`
    );
  }
  return claimBaseline(filePath, raced, { sid, lease, commit }, attemptsLeft - 1);
}

module.exports = { ensureBaseline };
