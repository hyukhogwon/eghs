'use strict';
const fs = require('fs');
const path = require('path');
const { isAlive } = require('./proc');
const { resolveStateDir, STATE_SUBDIRS } = require('./state-dir');
const { readSchemaVersion, HOOK_SCHEMA_VERSION } = require('./schema');
const { checkKillSwitch } = require('./kill-switch');
const { isCI } = require('./ci');
const { readFsInfo } = require('./fs-info');
const { isValidSid } = require('./sid');
const { getRepoRoot } = require('./git');
const { acquireSidGuard } = require('./guard');
const { gcSessions, sweepOrphanTombstones } = require('./session');
const { gcPreFiles } = require('./pre-file');
const { appendDebugLog } = require('./debug-log');
const { loadConfig } = require('./config');
const { establishLeaseAndBaseline } = require('./lease');

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

// ---------------------------------------------------------------------------
// #5 — GC pass + state subdir validation (PRD §R6 lines 761-775). The ONLY
// place any GC happens (G5: no GC at hook start). Returns a candidate or
// null to continue.

const RECOVERY_GRACE_MS = 60000;

// #5a: reclaim own-uid stale recover.lock leftovers (a crashed Stop reclaim).
function gcRecoverLocks(stateDir, { uid, nowMs }) {
  const locksDir = path.join(stateDir, 'locks');
  let names = [];
  try {
    names = fs.readdirSync(locksDir).filter((n) => n.endsWith('.recover.lock'));
  } catch {
    return;
  }
  for (const name of names) {
    const p = path.join(locksDir, name);
    let body;
    try {
      body = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      continue; // unreadable: not provably stale, leave it
    }
    if (!body || body.uid !== uid) continue; // foreign: never touch
    if (isAlive(body.pid)) continue;
    const graceMs = typeof body.recovery_grace_ms === 'number' ? body.recovery_grace_ms : RECOVERY_GRACE_MS;
    if (nowMs - body.start_ms < graceMs) continue;
    try {
      fs.unlinkSync(p);
    } catch {
      // raced -> fine
    }
  }
}

// #5b+#5c. Mutating GC only runs when the state dir is actually live
// (diskSchema present); the subdir check classifies what's missing.
function gcPass(ctx, config) {
  const { stateDir, diskSchema, nowMs } = ctx;
  const uid = process.getuid();

  if (diskSchema !== null) {
    gcRecoverLocks(stateDir, { uid, nowMs });
    gcSessions(stateDir, {
      nowMs,
      uid,
      sessionStaleSeconds: config.session_stale_seconds,
      onEvent: (e) => appendDebugLog(stateDir, ctx.sid, { ts_ms: nowMs, ...e }),
    });
    sweepOrphanTombstones(stateDir, {
      nowMs,
      uid,
      tombstoneStaleSeconds: config.tombstone_stale_seconds,
    });
    gcPreFiles(stateDir, { nowMs }); // 24h pre/ GC lives HERE, not at hook start
  }

  // #5c: state subdir validation.
  const missing = STATE_SUBDIRS.some((sub) => {
    try {
      return !fs.statSync(path.join(stateDir, sub)).isDirectory();
    } catch {
      return true;
    }
  });
  if (!missing) return null;
  if (diskSchema === null) return null; // clean install: #7 handles NOT_INITIALIZED
  // Partial init / hand-deleted subdir (schema ok) and INVALID/MISMATCH
  // cases alike: infra fault, eghs-init --repair. Never mkdir here.
  process.stderr.write('[eghs] state subdir missing; run: eghs-init --repair\n');
  return { candidate: 'INFRA_NOT_READY', reason: 'infra_not_ready' };
}

// ---------------------------------------------------------------------------
// #6 — session lease + baseline (PRD §R6 lines 776-813). Runs only when the
// schema is healthy; a re-check of migrate.lock + on-disk schema closes the
// #1↔#6 TOCTOU (a migrate that completed mid-chain). Returns:
//   {ok:true, lease}
//   {candidate, reason?}          — SID_COLLISION / INFRA lease_unavailable /
//                                    MIGRATE_IN_PROGRESS (TOCTOU)
//   {skip:true}                   — schema not healthy; #7 classifies
function establishLease(ctx) {
  const { stateDir, sid, diskSchema, nowMs, repoRoot, fsInfo } = ctx;

  // #6.1/#6.2 TOCTOU: migrate may have finished between #1 and now.
  if (fs.existsSync(path.join(stateDir, 'migrate.lock'))) {
    return { candidate: 'MIGRATE_IN_PROGRESS' };
  }
  const now = readSchemaVersion(stateDir);
  const diskSchemaNow = now.status === 'not_initialized' ? null : now.status === 'invalid' ? 'INVALID' : now.version;
  if (diskSchemaNow !== diskSchema) return { candidate: 'MIGRATE_IN_PROGRESS' };

  // #6.3/#6.4: lease only when schema matches the hook version and fs-info ok.
  if (diskSchemaNow !== HOOK_SCHEMA_VERSION || fsInfo.status !== 'ok') return { skip: true };

  const result = establishLeaseAndBaseline(stateDir, sid, {
    pid: process.ppid,
    uid: process.getuid(),
    nowMs,
    repoRoot,
    onEvent: (e) => appendDebugLog(stateDir, sid, { ts_ms: nowMs, ...e }),
  });
  return result.ok ? { ok: true, lease: result.lease } : result; // candidate passthrough
}

// #7 — schema / fs-info status classification, per hook (PRD §R6 lines
// 814-838). Only reached when the schema was NOT healthy (or fs-info missing);
// the healthy path returns {outcome:'continue'} from runPrecedence directly.
function classifySchemaState(ctx) {
  const { diskSchema, fsInfo } = ctx;
  if (diskSchema === null) return 'NOT_INITIALIZED';
  if (diskSchema === 'INVALID') return 'INVALID';
  if (diskSchema !== HOOK_SCHEMA_VERSION) return 'MISMATCH';
  if (fsInfo.status !== 'ok') return 'FS_INFO_MISSING';
  return 'OK';
}

function classifySchemaForHook(hookKind, state) {
  switch (hookKind) {
    case 'ups':
      // R1 fail-soft: never block the user's prompt.
      return {
        action: 'exit0',
        additionalContext:
          state === 'MISMATCH' ? 'eghs: schema mismatch — run eghs-migrate' : 'eghs: state not ready — run eghs-init',
      };
    case 'stop':
      // MISMATCH/FS_INFO_MISSING: state dir exists, verification is
      // state-independent → proceed. NOT_INITIALIZED/INVALID → fail-closed.
      if (state === 'MISMATCH' || state === 'FS_INFO_MISSING') return { action: 'continue' };
      return { action: 'deny', denyCode: 'INFRA_NOT_READY', autoUnblock: false, reason: 'infra_not_ready' };
    case 'post-write':
      // INVALID never fail-OPEN: leave a sid-scoped schema_invalid marker.
      if (state === 'INVALID') return { action: 'marker_exit0', markerReason: 'schema_invalid' };
      return { action: 'exit0' };
    case 'post-read':
      return { action: 'exit0' };
    case 'pre-write':
    case 'pre-read':
      switch (state) {
        case 'NOT_INITIALIZED':
          return { action: 'deny', denyCode: 'SCHEMA_NOT_INITIALIZED', autoUnblock: true };
        case 'MISMATCH':
          return { action: 'deny', denyCode: 'SCHEMA_MISMATCH', autoUnblock: false };
        case 'FS_INFO_MISSING':
          return { action: 'deny', denyCode: 'FS_INFO_MISSING', autoUnblock: true };
        default: // INVALID
          return { action: 'deny', denyCode: 'INFRA_NOT_READY', autoUnblock: false, reason: 'infra_not_ready' };
      }
    default:
      throw new Error(`unreachable hook kind: ${hookKind}`);
  }
}

// A #4/#5/#6 candidate → the entrypoint-facing outcome, via the #4 matrix.
function candidateToOutcome(hookKind, candidate) {
  const a = classifyCandidate(hookKind, candidate);
  switch (a.action) {
    case 'exit0':
      return { outcome: 'exit0', reason: 'candidate', additionalContext: a.additionalContext };
    case 'marker_exit0':
      return { outcome: 'marker_exit0', markerReason: a.markerReason };
    case 'deny':
      return { outcome: 'deny', denyCode: a.denyCode, autoUnblock: a.autoUnblock, reason: a.reason, maskedFrom: a.maskedFrom };
    default:
      throw new Error(`unreachable action: ${a.action}`);
  }
}

// A #7 schema-state action → the entrypoint-facing outcome (with ctx when
// it says continue).
function schemaActionToOutcome(action, ctx) {
  switch (action.action) {
    case 'continue':
      return { outcome: 'continue', ctx };
    case 'exit0':
      return { outcome: 'exit0', reason: 'schema', additionalContext: action.additionalContext };
    case 'marker_exit0':
      return { outcome: 'marker_exit0', markerReason: action.markerReason };
    case 'deny':
      return { outcome: 'deny', denyCode: action.denyCode, autoUnblock: action.autoUnblock, reason: action.reason };
    default:
      throw new Error(`unreachable schema action: ${action.action}`);
  }
}

// Full PRD §R6 precedence chain #1-#8. The single entrypoint every hook calls.
// Returns one of:
//   {outcome:'continue', ctx}                 — run hook logic (#8)
//   {outcome:'exit0', reason, additionalContext?}
//   {outcome:'marker_exit0', markerReason}    — PostToolUse fail-closed marker
//   {outcome:'deny', denyCode, autoUnblock?, reason?, maskedFrom?}
function runPrecedence(hookKind, input, { env, cwd, nowMs }) {
  const early = earlyPrecedence(hookKind, input, { env, cwd, nowMs });
  if (early.outcome === 'exit0') return early;
  if (early.outcome === 'deny') return early; // NO_SESSION (final)
  if (early.outcome === 'candidate') {
    if (early.ctx && typeof early.ctx.guardFd === 'number') fs.closeSync(early.ctx.guardFd);
    return candidateToOutcome(hookKind, early);
  }

  const ctx = early.ctx;
  let config;
  try {
    config = loadConfig(ctx.repoRoot);
  } catch (err) {
    // A malformed eghs.config.json is an infra fault, not a bypass.
    process.stderr.write(`[eghs] ${err.message}\n`);
    if (typeof ctx.guardFd === 'number') fs.closeSync(ctx.guardFd);
    return candidateToOutcome(hookKind, { candidate: 'INFRA_NOT_READY', reason: 'infra_not_ready' });
  }
  ctx.config = config;

  const settle = (result) => {
    // A non-continue result means this hook is done — release the guard now.
    if (result.outcome !== 'continue' && typeof ctx.guardFd === 'number') {
      fs.closeSync(ctx.guardFd);
      ctx.guardFd = null;
    }
    return result;
  };

  // #4 migrate.lock.
  const mig = checkMigrateLock(ctx.stateDir, { uid: process.getuid(), nowMs });
  if (mig) return settle(candidateToOutcome(hookKind, mig));

  // #5 GC + subdir validation.
  const gc = gcPass(ctx, config);
  if (gc) return settle(candidateToOutcome(hookKind, gc));

  // #6 lease/baseline (healthy schema only).
  const lease = establishLease(ctx);
  if (lease.candidate) return settle(candidateToOutcome(hookKind, lease));
  if (lease.ok) ctx.lease = lease.lease;

  // #7 schema/fs-info classification.
  const state = classifySchemaState(ctx);
  if (state === 'OK') return { outcome: 'continue', ctx }; // → #8 hook logic
  return settle(schemaActionToOutcome(classifySchemaForHook(hookKind, state), ctx));
}

module.exports = {
  earlyPrecedence,
  checkMigrateLock,
  classifyCandidate,
  gcPass,
  runPrecedence,
};
