'use strict';
const fs = require('fs');
const path = require('path');
const { atomicWriteFile } = require('./atomic-write');
const { exclusiveLinkCreate } = require('./exclusive-link');
const { getHeadCommit } = require('./git');
const { isAlive } = require('./proc');

// PRD §R6 #6.3 (R16-R20 normative decision tree): session lease create/renew
// plus the anchor-bound baseline. This supersedes P1's session.js/baseline.js
// pair for precedence use — the tree below is transcribed branch-for-branch
// from §786-808.
//
// Returns:
//   {ok:true, lease}
//   {candidate:'SID_COLLISION'}
//   {candidate:'INFRA_NOT_READY', reason:'lease_unavailable'}

const FAR_FUTURE_GRACE_MS = 86400000; // start_ms sanity ceiling (24h clock-skew allowance)

function leasePath(stateDir, sid) {
  return path.join(stateDir, 'sessions', `${sid}.json`);
}
function baselinePath(stateDir, sid) {
  return path.join(stateDir, 'baselines', `${sid}.txt`);
}

// null = absent; the string 'corrupt' = present but unparseable (fail-closed
// everywhere: a corrupt lease is never unlinked by a hook — --clear-sid is
// the only escape hatch).
function readLease(p) {
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    return err.code === 'ENOENT' ? null : 'corrupt';
  }
  try {
    const body = JSON.parse(raw);
    return body !== null && typeof body === 'object' && typeof body.pid === 'number' ? body : 'corrupt';
  } catch {
    return 'corrupt';
  }
}

// null = absent; 'corrupt' = present but unparseable (routes to branches
// 4/5/6 depending on the lease pid's liveness).
function readBaseline(p) {
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    return err.code === 'ENOENT' ? null : 'corrupt';
  }
  try {
    const body = JSON.parse(raw);
    return body !== null && typeof body === 'object' ? body : 'corrupt';
  } catch {
    return 'corrupt';
  }
}

function saneStartMs(startMs, nowMs) {
  return (
    typeof startMs === 'number' &&
    Number.isInteger(startMs) &&
    startMs >= 0 &&
    startMs <= Number.MAX_SAFE_INTEGER &&
    startMs <= nowMs + FAR_FUTURE_GRACE_MS
  );
}

const INFRA = { candidate: 'INFRA_NOT_READY', reason: 'lease_unavailable' };
const COLLISION = { candidate: 'SID_COLLISION' };

// Stale-cleanup cascade (§799 i): everything sid-scoped EXCEPT the lease
// (kept until start_ms is decided) and the guard.lock (the running hook
// holds it shared — unlike the #5b dead-sid cascade, this sid is OURS).
function staleCascade(stateDir, sid) {
  const targets = [
    { p: baselinePath(stateDir, sid), dir: false },
    { p: path.join(stateDir, 'verify-logs', sid), dir: true },
    { p: path.join(stateDir, 'debug', `${sid}.jsonl`), dir: false },
    { p: path.join(stateDir, 'pre', sid), dir: true },
    { p: path.join(stateDir, 'failed', sid), dir: true },
    { p: path.join(stateDir, 'locks', `stop-${sid}.lock`), dir: false },
    { p: path.join(stateDir, 'locks', `stop-${sid}.recover.lock`), dir: false },
  ];
  let realFailure = false;
  for (const t of targets) {
    try {
      if (t.dir) fs.rmSync(t.p, { recursive: true, force: true });
      else fs.unlinkSync(t.p);
    } catch (err) {
      if (err.code !== 'ENOENT') realFailure = true;
    }
  }
  // Key-scoped markers whose origin_sid is this sid (full failed/ scan).
  let names = [];
  try {
    names = fs.readdirSync(path.join(stateDir, 'failed')).filter((n) => n.endsWith('.json'));
  } catch {
    // failed/ unreadable: not fatal, markers age out via their own GC
  }
  for (const name of names) {
    const p = path.join(stateDir, 'failed', name);
    try {
      if (JSON.parse(fs.readFileSync(p, 'utf8')).origin_sid === sid) fs.unlinkSync(p);
    } catch (err) {
      if (err && err.code && err.code !== 'ENOENT' && err.code !== 'EISDIR') realFailure = true;
    }
  }
  return { realFailure };
}

function writeLeaseExclusive(stateDir, sid, body) {
  return exclusiveLinkCreate(leasePath(stateDir, sid), JSON.stringify(body));
}

function establishLeaseAndBaseline(stateDir, sid, { pid, uid, nowMs, repoRoot, onEvent }, retriesLeft = 2) {
  if (retriesLeft <= 0) return INFRA;
  const lp = leasePath(stateDir, sid);

  // §808: every SID_COLLISION logs the collision detail (current pid, foreign
  // pid, both start_ms) before returning — the sole diagnostic for a sid
  // uniqueness fault.
  const collision = (foreignPid, foreignStartMs) => {
    if (onEvent) {
      onEvent({ event: 'sid_collision', current_pid: pid, foreign_pid: foreignPid, current_start_ms: nowMs, foreign_start_ms: foreignStartMs });
    }
    return COLLISION;
  };

  // --- lease create/renew (§780-783) ---
  let lease = readLease(lp);
  if (lease === 'corrupt') return INFRA; // corrupt lease: only --clear-sid may touch it

  const leaseWasAbsent = lease === null;
  if (leaseWasAbsent) {
    const body = { schema_version: 1, pid, uid, start_ms: nowMs, renewed_ms: nowMs };
    if (writeLeaseExclusive(stateDir, sid, body).ok) {
      lease = body;
    } else {
      // Concurrent create won the link race: re-enter with what's there now.
      return establishLeaseAndBaseline(stateDir, sid, { pid, uid, nowMs, repoRoot, onEvent }, retriesLeft - 1);
    }
  } else if (lease.pid === pid) {
    // Renew: own lease, plain atomic overwrite is safe. start_ms immutable.
    lease = { ...lease, renewed_ms: nowMs };
    atomicWriteFile(lp, JSON.stringify(lease));
  }
  // lease.pid !== pid: body preserved untouched; the baseline tree decides.

  // --- baseline (§784-808) ---
  const bp = baselinePath(stateDir, sid);
  const baseline = readBaseline(bp);

  if (baseline === null) {
    // A fresh lease is always ours: anchor and go.
    if (leaseWasAbsent) {
      const body = { commit: getHeadCommit(repoRoot), lease_start_ms: lease.start_ms, lease_pid: lease.pid };
      if (exclusiveLinkCreate(bp, JSON.stringify(body)).ok) return { ok: true, lease };
      return establishLeaseAndBaseline(stateDir, sid, { pid, uid, nowMs, repoRoot, onEvent }, retriesLeft - 1);
    }
    // Pre-existing lease, baseline missing: never anchor to a live foreign
    // lease; a dead one goes through stale-cleanup like every other branch-4.
    if (lease.pid !== pid && isAlive(lease.pid)) return collision(lease.pid, lease.start_ms);
    if (lease.pid !== pid) return staleCleanup();
    const body = { commit: getHeadCommit(repoRoot), lease_start_ms: lease.start_ms, lease_pid: lease.pid };
    if (exclusiveLinkCreate(bp, JSON.stringify(body)).ok) return { ok: true, lease };
    return establishLeaseAndBaseline(stateDir, sid, { pid, uid, nowMs, repoRoot, onEvent }, retriesLeft - 1);
  }

  // Lease was absent (fresh) but a stale baseline survives (PRD §6.3b.4
  // "sessions 부재" branch): that baseline is orphaned debris — clean it up
  // and re-anchor. start_ms was just set to now, which staleCleanup keeps.
  if (leaseWasAbsent) return staleCleanup();

  const leaseAlive = isAlive(lease.pid);
  if (baseline === 'corrupt') {
    // §6.3b.4-6 (parse-fail arms).
    if (!leaseAlive) return staleCleanup(); // branch 4: dead → cleanup
    if (lease.pid === pid) return INFRA; // branch 5: own live lease + corrupt baseline
    return collision(lease.pid, lease.start_ms); // branch 6: live foreign lease
  }

  const anchorMatch = baseline.lease_start_ms === lease.start_ms && baseline.lease_pid === lease.pid;
  if (anchorMatch && lease.pid === pid) return { ok: true, lease }; // branch 1: reuse OK
  if (anchorMatch && leaseAlive) return collision(lease.pid, lease.start_ms); // branch 2 (pid != current, alive)
  if (!anchorMatch && leaseAlive) return collision(lease.pid, lease.start_ms); // branch 3
  return staleCleanup(); // branch 4: dead lease, any anchor state

  // --- stale-cleanup (§794-807 i-vi) ---
  function staleCleanup() {
    // Precondition: prior_start_ms sanity from the surviving lease file.
    const prior = readLease(lp);
    if (prior === 'corrupt') return INFRA;
    let priorStartMs = null;
    if (prior !== null) {
      if (!saneStartMs(prior.start_ms, nowMs)) return INFRA; // corrupt lease: no unlink, --clear-sid only
      priorStartMs = prior.start_ms;
    }

    // i. cascade first, lease kept.
    const { realFailure } = staleCascade(stateDir, sid);

    // iii. start_ms decision.
    let startMs;
    if (priorStartMs === null) {
      startMs = nowMs;
    } else if (!realFailure) {
      startMs = priorStartMs;
    } else {
      startMs = Math.max(nowMs, priorStartMs + 1); // clock-skew clamp
      if (onEvent) {
        onEvent({ event: 'eperm_start_ms_fallback', prior_start_ms: priorStartMs, now_ms: nowMs, chosen_start_ms: startMs });
      }
    }

    // iv. now the stale lease may go.
    try {
      fs.unlinkSync(lp);
    } catch {
      // ENOENT: already gone
    }

    // v. lease re-create (same link-exclusive contract as the normal branch).
    const body = { schema_version: 1, pid, uid, start_ms: startMs, renewed_ms: nowMs };
    if (!writeLeaseExclusive(stateDir, sid, body).ok) {
      const raced = readLease(lp);
      if (raced === 'corrupt') return INFRA;
      if (raced && raced.pid === pid) {
        // Another hook of OUR process recreated it: renew semantics.
        return establishLeaseAndBaseline(stateDir, sid, { pid, uid, nowMs, repoRoot, onEvent }, retriesLeft - 1);
      }
      if (raced && isAlive(raced.pid)) return collision(raced.pid, raced.start_ms);
      return establishLeaseAndBaseline(stateDir, sid, { pid, uid, nowMs, repoRoot, onEvent }, retriesLeft - 1);
    }

    // vi. baseline write, one shot + the outer retry.
    const baseBody = { commit: getHeadCommit(repoRoot), lease_start_ms: startMs, lease_pid: pid };
    if (!exclusiveLinkCreate(baselinePath(stateDir, sid), JSON.stringify(baseBody)).ok) {
      return establishLeaseAndBaseline(stateDir, sid, { pid, uid, nowMs, repoRoot, onEvent }, retriesLeft - 1);
    }
    return { ok: true, lease: body };
  }
}

module.exports = { establishLeaseAndBaseline };
