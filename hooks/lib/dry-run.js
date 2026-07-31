'use strict';
const path = require('path');
const { runPrecedence } = require('./precedence');
const { evaluateGate } = require('./gate');
const { preFilePath, normalizeToolUseId } = require('./pre-file');
const { readsPath } = require('./read-state');
const { canonicalKeyAllowMissing } = require('./canonical');

// PRD §R6 dry-run 모드 (lines 853-859) + MVP item 7: every hook accepts
// `--dry-run < input.json` and prints ONE line of decision JSON
//   {decision, deny_code?, reason?, would_write: [...]}
// with the same exit code the real run would use (0 = allow/skip/kill_switch,
// 2 = block). No state is written: the precedence chain suppresses its own
// mutations, and #8 below only computes what it WOULD have written.
//
// decision enum matches the §5 debug schema: allow | block | skip | kill_switch.

const BLOCKING_HOOKS = new Set(['pre-write', 'pre-read', 'stop']);

function resolveKey(ctx, input) {
  const filePath = input.tool_input && input.tool_input.file_path;
  if (typeof filePath !== 'string') return null;
  const resolved = canonicalKeyAllowMissing(filePath, { caseless: ctx.caseless });
  return resolved.ok ? resolved.key : null;
}

// #8 simulation per hook kind. The tool hooks' record paths are derived
// exactly as the live hooks derive them; the PostToolUse R4 matrix itself is
// NOT re-simulated (its branches depend on the tool_response of a call that
// never ran), so its row reports the record paths it may touch.
function simulateHookLogic(hookKind, ctx, input, nowMs) {
  const { stateDir, sid, wouldWrite } = ctx;
  const toolUseId = normalizeToolUseId(input.tool_use_id);

  if (hookKind === 'stop') {
    wouldWrite.push(path.join(stateDir, 'locks', `stop-${sid}.lock`));
    wouldWrite.push(path.join(stateDir, 'verify-logs', sid));
    return { decision: 'allow', reason: 'verification not executed in dry-run' };
  }
  if (hookKind === 'ups') return { decision: 'allow' };

  const key = resolveKey(ctx, input);
  if (key === null) return { decision: 'skip', denyCode: 'FILE_UNREADABLE' };

  if (hookKind === 'pre-read') {
    wouldWrite.push(preFilePath(stateDir, sid, key, toolUseId, 'read'));
    return { decision: 'allow' };
  }
  if (hookKind === 'post-read' || hookKind === 'post-write') {
    wouldWrite.push(readsPath(stateDir, key));
    wouldWrite.push(preFilePath(stateDir, sid, key, toolUseId, hookKind === 'post-read' ? 'read' : 'write'));
    return { decision: 'allow' };
  }

  // pre-write: the R3 gate decides for real (it is read-only).
  const gate = evaluateGate(ctx, input.tool_input.file_path, { nowMs });
  if (gate.allow || gate.skip === 'not_applicable') {
    wouldWrite.push(preFilePath(stateDir, sid, gate.key, toolUseId, 'write'));
    return { decision: gate.allow ? 'allow' : 'skip' };
  }
  if (gate.skip) return { decision: 'skip' };
  return { decision: 'block', denyCode: gate.denyCode, reason: gate.reason };
}

// hookKind null = the hook would not have run at all (unmatched tool, or an
// unparseable payload): `skipReason` names which.
function evaluateDryRun(hookKind, input, { env, cwd, nowMs, skipReason = 'not_applicable' }) {
  if (!hookKind) return { decision: 'skip', reason: skipReason, wouldWrite: [], exitCode: 0 };

  const result = runPrecedence(hookKind, input, { env, cwd, nowMs, dryRun: true });
  const wouldWrite = result.wouldWrite || [];
  const blocking = BLOCKING_HOOKS.has(hookKind);

  if (result.outcome === 'exit0') {
    const passthrough = result.reason === 'kill_switch' || result.reason === 'ci';
    return {
      decision: passthrough ? 'kill_switch' : 'skip',
      reason: result.reason,
      wouldWrite,
      exitCode: 0,
    };
  }
  if (result.outcome === 'marker_exit0') {
    // PostToolUse fail-closed row: the marker path depends on state the
    // settled chain no longer carries (ctx is gone), so only the reason shows.
    return { decision: 'skip', reason: result.markerReason, wouldWrite, exitCode: 0 };
  }
  if (result.outcome === 'deny') {
    return {
      decision: 'block',
      denyCode: result.denyCode,
      reason: result.reason,
      wouldWrite,
      exitCode: blocking ? 2 : 0,
    };
  }

  const logic = simulateHookLogic(hookKind, result.ctx, input, nowMs);
  return {
    ...logic,
    wouldWrite,
    exitCode: logic.decision === 'block' && blocking ? 2 : 0,
  };
}

// The CLI half: one line of JSON on stdout, the no-mutation notice on stderr.
function runDryRunCli(hookKind, input, { env = process.env, cwd = process.cwd(), nowMs = Date.now(), skipReason } = {}) {
  const r = evaluateDryRun(hookKind, input, { env, cwd, nowMs, skipReason });
  const out = { decision: r.decision };
  if (r.denyCode) out.deny_code = r.denyCode;
  if (r.reason) out.reason = r.reason;
  out.would_write = r.wouldWrite;
  process.stdout.write(JSON.stringify(out) + '\n');
  process.stderr.write('[eghs] dry-run: no state writes performed\n');
  process.exitCode = r.exitCode;
}

module.exports = { evaluateDryRun, runDryRunCli };
