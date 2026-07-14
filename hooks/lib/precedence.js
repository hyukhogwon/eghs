'use strict';
const fs = require('fs');
const path = require('path');
const { isAlive } = require('./proc');
const { resolveStateDir } = require('./state-dir');
const { readSchemaVersion } = require('./schema');
const { checkKillSwitch } = require('./kill-switch');
const { isCI } = require('./ci');
const { readFsInfo } = require('./fs-info');
const { isValidSid } = require('./sid');
const { getRepoRoot } = require('./git');
const { acquireSidGuard } = require('./guard');

// PRD §R6 precedence chain, stages #1-#3.7 (the mutation-free prefix; the
// single sanctioned exception is #3.7's guard.lock create). Later stages
// (#4 migrate.lock matrix, #5 GC, #6 lease, #7 classification) build on the
// ctx this returns.
//
// hookKind ∈ pre-write | pre-read | post-write | post-read | ups | stop
//
// Outcomes:
//   {outcome:'continue', ctx}                      — proceed to #4+
//   {outcome:'exit0', reason}                      — silent allow/skip
//   {outcome:'deny', denyCode:'NO_SESSION'}        — final (Pre*/Stop fail-closed)
//   {outcome:'candidate', candidate, reason}       — deny candidate; the #4
//     hook-type reclassification matrix decides the actual return per hook.

const HOOK_KINDS = new Set(['pre-write', 'pre-read', 'post-write', 'post-read', 'ups', 'stop']);

function earlyPrecedence(hookKind, input, { env, cwd, nowMs }) {
  if (!HOOK_KINDS.has(hookKind)) throw new Error(`unknown hook kind: ${hookKind}`);
  const repoRoot = getRepoRoot(cwd) || cwd;
  const stateDir = resolveStateDir(repoRoot);

  // #1 — on-disk schema, stat-only. null = NOT_INITIALIZED signal.
  const schema = readSchemaVersion(stateDir);
  const diskSchema =
    schema.status === 'not_initialized' ? null : schema.status === 'invalid' ? 'INVALID' : schema.version;

  // #2 — kill switch (G5: must win over everything, including broken fs-info).
  if (checkKillSwitch({ repoRoot, env }).active) return { outcome: 'exit0', reason: 'kill_switch' };

  // #3 — CI passthrough, non-Stop hooks only (G3 keeps Stop verifying in CI).
  if (hookKind !== 'stop' && isCI(env)) return { outcome: 'exit0', reason: 'ci' };

  // #3.3 — fs-info flock-capability validation. Skipped pre-bootstrap
  // (diskSchema null): #7 handles NOT_INITIALIZED. `missing` defers to
  // #4/#7 (FS_INFO_MISSING there); every unhealthy shape fails closed here —
  // trusting a legacy/corrupt cache would let a silent-noop flock through
  // and turn the #3.7 guard into theater.
  let fsInfo = { status: 'skipped' };
  if (diskSchema !== null) {
    fsInfo = readFsInfo(stateDir);
    if (fsInfo.status === 'unhealthy') {
      // Per-case stderr per PRD §R6 #3.3 (lines 681-683).
      if (fsInfo.reason === 'anchor_mismatch' || fsInfo.reason === 'anchor_unverifiable') {
        process.stderr.write('[eghs] fs-info.json FS anchor mismatch; run: eghs-init --repair to re-probe FS\n');
      } else if (fsInfo.reason === 'flock_not_ok') {
        process.stderr.write('[eghs] fs-info.json flock_ok not true; run: eghs-init --repair\n');
      } else {
        process.stderr.write('[eghs] fs-info.json corrupt; run: eghs-init --repair\n');
      }
      return { outcome: 'candidate', candidate: 'INFRA_NOT_READY', reason: 'infra_not_ready' };
    }
  }

  // #3.5 — strict NO_SESSION validation, per-hook outcome (PRD R6 #3.5).
  const sid = input.session_id;
  if (!isValidSid(sid)) {
    if (hookKind === 'ups') return { outcome: 'exit0', reason: 'no_session' };
    if (hookKind === 'post-write' || hookKind === 'post-read') {
      // Observable but silent: no state write is possible (no sid → no
      // debug/<sid>.jsonl path either).
      process.stderr.write(`[eghs] NO_SESSION: ${hookKind}\n`);
      return { outcome: 'exit0', reason: 'no_session' };
    }
    // pre-write / pre-read / stop: fail-closed (G1/G3).
    process.stderr.write(`[eghs] NO_SESSION: ${hookKind}\n`);
    return { outcome: 'deny', denyCode: 'NO_SESSION' };
  }

  // #3.7 — tombstone check + shared guard. Step 0 fast-path: clean install
  // (diskSchema null) has no sid state by definition; creating a guard would
  // ENOENT-crash on the missing sessions/ dir.
  let guardFd = null;
  if (diskSchema !== null) {
    const guard = acquireSidGuard(stateDir, sid);
    if (guard.outcome === 'sid_cleared') {
      return { outcome: 'candidate', candidate: 'INFRA_NOT_READY', reason: 'sid_cleared' };
    }
    if (guard.outcome === 'infra') {
      // Repair guidance only for ENOENT (sessions/ hand-deleted, PRD §706);
      // EACCES and the rest return silently per spec.
      if (guard.detail && guard.detail.includes('ENOENT')) {
        process.stderr.write('[eghs] sessions/ missing; run: eghs-init --repair\n');
      }
      return { outcome: 'candidate', candidate: 'INFRA_NOT_READY', reason: 'infra_not_ready' };
    }
    guardFd = guard.guardFd;
  }

  return {
    outcome: 'continue',
    ctx: {
      hookKind,
      nowMs,
      repoRoot,
      stateDir,
      sid,
      diskSchema,
      fsInfo,
      caseless: fsInfo.status === 'ok' ? fsInfo.caseless : null,
      guardFd,
    },
  };
}

// ---------------------------------------------------------------------------
// #4 — migrate.lock check (PRD §R6 lines 737-760). First stage allowed to
// mutate state (stale-lock deletion). Returns a candidate object or null.

const MIGRATE_LOCK_GRACE_MS = 600000; // same-uid dead-lock reclaim grace
const FOREIGN_MIGRATE_LOCK_GRACE_MS = 7200000; // 2h before a foreign lock reads as stale

function readMigrateLockBody(lockPath) {
  try {
    const body = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return body !== null && typeof body === 'object' && typeof body.uid === 'number' && typeof body.pid === 'number' && typeof body.start_ms === 'number'
      ? body
      : null;
  } catch {
    return null;
  }
}

function checkMigrateLock(stateDir, { uid, nowMs }) {
  const lockPath = path.join(stateDir, 'migrate.lock');
  let st;
  try {
    st = fs.lstatSync(lockPath);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return { candidate: 'INFRA_NOT_READY', reason: 'infra_not_ready' };
  }
  if (!st.isFile()) {
    // Non-regular type: infra fault, never FILE_UNREADABLE (no auto-bypass).
    process.stderr.write('[eghs] migrate.lock is not a regular file; run: eghs-migrate --clear-migrate-lock\n');
    return { candidate: 'INFRA_NOT_READY', reason: 'migrate_lock_corrupt' };
  }

  // Parse with one retry (an open/rename race can surface as a torn read).
  let body = readMigrateLockBody(lockPath);
  if (body === null) {
    if (!fs.existsSync(lockPath)) return null; // ENOENT race: migrate finished
    body = readMigrateLockBody(lockPath);
    if (body === null) {
      process.stderr.write('[eghs] migrate.lock body corrupt; run: eghs-migrate --clear-migrate-lock\n');
      return { candidate: 'INFRA_NOT_READY', reason: 'migrate_lock_corrupt' };
    }
  }

  if (body.uid !== uid) {
    if (nowMs - body.start_ms < FOREIGN_MIGRATE_LOCK_GRACE_MS) {
      return { candidate: 'MIGRATE_IN_PROGRESS' };
    }
    // Foreign-stale: never auto-delete another user's lock.
    process.stderr.write('[eghs] stale foreign migrate.lock; run: eghs-migrate --force-foreign-cleanup\n');
    return { candidate: 'INFRA_NOT_READY', reason: 'infra_not_ready' };
  }
  if (isAlive(body.pid)) {
    // Covers same-uid EPERM too (isAlive is fail-closed on non-ESRCH).
    return { candidate: 'MIGRATE_IN_PROGRESS' };
  }
  if (nowMs - body.start_ms < MIGRATE_LOCK_GRACE_MS) {
    return { candidate: 'MIGRATE_IN_PROGRESS' }; // fresh crash: protect the grace window
  }
  try {
    fs.unlinkSync(lockPath); // stale: same uid + dead + grace elapsed
  } catch {
    // raced with another hook's reclaim: either way it's gone or will be
  }
  return null;
}

// Hook-type reclassification matrix (PRD §R6 #4 table; #6 lease failures and
// #3.3/#3.7 candidates route through the same rows). Input: a candidate
// {candidate, reason?}; output: what the entrypoint must actually do.
const MARKER_REASONS = {
  MIGRATE_IN_PROGRESS: 'migrate_in_progress',
  SID_COLLISION: 'sid_collision',
};

function classifyCandidate(hookKind, { candidate, reason }) {
  if (!HOOK_KINDS.has(hookKind)) throw new Error(`unknown hook kind: ${hookKind}`);
  switch (hookKind) {
    case 'ups':
      return {
        action: 'exit0',
        additionalContext:
          candidate === 'MIGRATE_IN_PROGRESS'
            ? 'eghs: migrate in progress — state writes paused'
            : candidate === 'SID_COLLISION'
              ? 'eghs: sid collision detected, check Claude Code sid uniqueness'
              : 'eghs: state infrastructure not ready — run eghs-init --repair',
      };
    case 'stop':
      // G3: verification did not run, so nothing may auto-pass. MIGRATE is
      // masked as INFRA_NOT_READY (auto-unblock No); the original candidate
      // goes to the debug log only.
      return {
        action: 'deny',
        denyCode: candidate === 'SID_COLLISION' ? 'SID_COLLISION' : 'INFRA_NOT_READY',
        autoUnblock: false,
        reason,
        maskedFrom: candidate,
      };
    case 'post-write':
      return {
        action: 'marker_exit0',
        markerReason: MARKER_REASONS[candidate] || reason || 'infra_not_ready',
      };
    case 'post-read':
      return { action: 'exit0' };
    case 'pre-write':
    case 'pre-read':
      return {
        action: 'deny',
        denyCode: candidate,
        autoUnblock: candidate === 'MIGRATE_IN_PROGRESS',
        reason,
      };
    default:
      throw new Error(`unreachable hook kind: ${hookKind}`);
  }
}

module.exports = { earlyPrecedence, checkMigrateLock, classifyCandidate };
