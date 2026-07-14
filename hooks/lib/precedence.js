'use strict';
const path = require('path');
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

module.exports = { earlyPrecedence };
