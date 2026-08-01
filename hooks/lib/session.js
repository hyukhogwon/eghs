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

// Cascade targets for one sid (PRD §R2.5 §238 + R6 #5b, verbatim set).
// guard.lock is listed FIRST — the guard depends on the lease, so it must
// be gone before the lease is (a leaked guard after lease unlink would be a
// permanent orphan; UUIDv4 sids never repeat).
function cascadeTargets(stateDir, sid) {
  return [
    { p: path.join(stateDir, 'sessions', `${sid}.guard.lock`), dir: false },
    { p: path.join(stateDir, 'baselines', `${sid}.txt`), dir: false },
    { p: path.join(stateDir, 'verify-logs', sid), dir: true },
    { p: path.join(stateDir, 'debug', `${sid}.jsonl`), dir: false },
    { p: path.join(stateDir, 'pre', sid), dir: true },
    { p: path.join(stateDir, 'failed', sid), dir: true },
    { p: path.join(stateDir, 'locks', `stop-${sid}.lock`), dir: false },
    { p: path.join(stateDir, 'locks', `stop-${sid}.recover.lock`), dir: false },
    { p: path.join(stateDir, 'sessions', `${sid}.tombstone`), dir: false },
  ];
}

// Best-effort delete of one cascade target. ENOENT counts as success;
// EPERM/EACCES (and anything else) is a real failure the caller must react
// to by KEEPING the lease (retry next pass — the sid-scoped markers' only
// GC path is this cascade, so a lease deleted first would orphan them).
function deleteTarget({ p, dir }) {
  try {
    if (dir) fs.rmSync(p, { recursive: true, force: true });
    else fs.unlinkSync(p);
    return true;
  } catch (err) {
    return err.code === 'ENOENT';
  }
}

// GC candidate selection (PRD §R2.5 sessions/ GC): only leases with (stale by
// time, same uid, dead pid) qualify. A foreign-uid dead lease is left alone
// unless `foreignStaleSeconds` is set — that is `eghs-migrate
// --force-foreign-cleanup` only (PRD §241), and it is TTL-only on purpose:
// kill(0) against a foreign pid returns EPERM, so liveness is undecidable.
// Exported so eghs-migrate --dry-run can report the plan without deleting.
function selectStaleSids(stateDir, { nowMs, uid, sessionStaleSeconds = 86400, foreignStaleSeconds = null }) {
  const sessionsDir = path.join(stateDir, 'sessions');
  let entries = [];
  try {
    entries = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const selected = [];
  for (const entry of entries) {
    const filePath = path.join(sessionsDir, entry);
    const sid = entry.slice(0, -'.json'.length);
    let body;
    try {
      body = readLease(filePath);
    } catch {
      continue; // unparseable lease: unclassifiable, only --clear-sid may touch it
    }
    if (!body) continue; // vanished mid-scan -> leave for a later pass

    if (body.uid === uid) {
      const staleByTime = nowMs - body.renewed_ms > sessionStaleSeconds * 1000;
      if (!staleByTime || isAlive(body.pid)) continue;
    } else {
      if (foreignStaleSeconds === null) continue;
      if (nowMs - body.renewed_ms <= foreignStaleSeconds * 1000) continue;
    }

    // A tombstone means --clear-sid owns this sid right now; its cascade is
    // that command's job, not ours.
    if (fs.existsSync(path.join(sessionsDir, `${sid}.tombstone`))) continue;
    selected.push({ sid, filePath, body });
  }
  return selected;
}

// PRD §R2.5 sessions/ GC (R16-R20: cascade-before-lease). Cascade runs FIRST;
// the lease is unlinked only when every target succeeded, so a partial cascade
// stays retryable.
function gcSessions(stateDir, { nowMs, uid, sessionStaleSeconds = 86400, foreignStaleSeconds = null, onEvent }) {
  for (const { sid, filePath, body } of selectStaleSids(stateDir, {
    nowMs,
    uid,
    sessionStaleSeconds,
    foreignStaleSeconds,
  })) {
    const failedTargets = cascadeTargets(stateDir, sid)
      .filter((t) => !deleteTarget(t))
      .map((t) => t.p);
    if (failedTargets.length > 0) {
      if (onEvent) onEvent({ event: 'sessions_gc_partial', sid, failed_targets: failedTargets });
      continue; // keep the lease; next pass retries the cascade
    }

    // Re-verify immediately before deleting: only remove the exact stale
    // entry we just evaluated, in case a new (live) lease replaced it
    // between the read above and now.
    let stillStale;
    try {
      stillStale = readLease(filePath);
    } catch {
      continue; // replaced by something unreadable mid-scan: hands off
    }
    if (!sameEntry(stillStale, body)) continue;
    try {
      fs.unlinkSync(filePath);
    } catch {
      // already gone -> fine
    }
  }
}

// Orphan tombstone sweep (PRD R6 #5b): a --clear-sid crash can leak a
// tombstone with no surviving siblings. Own-uid, aged past
// tombstone_stale_seconds, and every sibling absent → unlink.
function sweepOrphanTombstones(stateDir, { nowMs, uid, tombstoneStaleSeconds = 3600 }) {
  const sessionsDir = path.join(stateDir, 'sessions');
  let names = [];
  try {
    names = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.tombstone'));
  } catch {
    return;
  }
  for (const name of names) {
    const sid = name.slice(0, -'.tombstone'.length);
    const p = path.join(sessionsDir, name);
    let body;
    try {
      body = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      continue; // unreadable/corrupt: leave for manual inspection
    }
    if (!body || body.cleared_by_uid !== uid) continue; // foreign: never touch
    if (nowMs - body.ts_ms < tombstoneStaleSeconds * 1000) continue;
    const lease = path.join(sessionsDir, `${sid}.json`);
    const siblings = cascadeTargets(stateDir, sid).filter((t) => !t.p.endsWith('.tombstone'));
    const anyLeft = fs.existsSync(lease) || siblings.some((t) => fs.existsSync(t.p));
    if (anyLeft) continue;
    try {
      fs.unlinkSync(p);
    } catch {
      // raced -> fine
    }
  }
}

// Orphan baseline sweep (#5b, P4 finale). A baseline is normally removed by
// the sessions cascade, so one whose lease is gone by any other route (a
// hand-deleted lease, a cascade that only later succeeded on the lease) would
// otherwise survive forever — §G5 says no unbounded disk growth. The lease is
// always written before its baseline, so "baseline without lease" can only
// mean debris; the mtime grace covers any interleaving we have not thought of.
function sweepOrphanBaselines(stateDir, { nowMs, staleSeconds = 3600 }) {
  const baselinesDir = path.join(stateDir, 'baselines');
  let names = [];
  try {
    names = fs.readdirSync(baselinesDir).filter((n) => n.endsWith('.txt'));
  } catch {
    return;
  }
  for (const name of names) {
    const sid = name.slice(0, -'.txt'.length);
    if (fs.existsSync(leasePath(stateDir, sid))) continue;
    const p = path.join(baselinesDir, name);
    try {
      if (nowMs - fs.statSync(p).mtimeMs < staleSeconds * 1000) continue;
      fs.unlinkSync(p);
    } catch {
      // vanished or unreadable -> nothing to do
    }
  }
}

module.exports = {
  ensureSessionLease,
  selectStaleSids,
  gcSessions,
  sweepOrphanTombstones,
  sweepOrphanBaselines,
  cascadeTargets, // eghs-migrate --clear-sid reuses the verbatim cascade set
  SidCollisionError,
};
