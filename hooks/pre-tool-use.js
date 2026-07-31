#!/usr/bin/env node
'use strict';
const fs = require('fs');
const { readStdin } = require('./lib/stdin');
const { runPrecedence } = require('./lib/precedence');
const { evaluateGate } = require('./lib/gate');
const { canonicalKey, sha256File } = require('./lib/canonical');
const { writePreFile, deletePreFile, normalizeToolUseId } = require('./lib/pre-file');
const { logDecision } = require('./lib/debug-log');
const { runDryRunCli } = require('./lib/dry-run');
const { formatBlock } = require('./lib/deny');

// P4 PreToolUse GATES Write/Edit/MultiEdit (PRD §R3): a deny is exit 2, which
// Claude Code turns into a blocked tool call + the stderr reason relayed to
// the model. Read is not gated but still fails closed on NO_SESSION (G1).
process.stdout.on('error', () => {});

const TOOL_KINDS = { Read: 'pre-read', Write: 'pre-write', Edit: 'pre-write', MultiEdit: 'pre-write' };

function block(denyCode, { reason, sid }) {
  process.stderr.write(formatBlock(denyCode, { reason, sid }));
  process.exitCode = 2;
}

// PreToolUse Read: record the pre-edit SHA for R2 TOCTOU comparison. Not
// gated — this only ever produces evidence.
function recordRead(ctx, input, nowMs, toolUseId) {
  const resolved = canonicalKey(input.tool_input.file_path, { caseless: ctx.caseless });
  if (!resolved.ok) {
    logPre(ctx, input, nowMs, { decision: 'skip', denyCode: 'FILE_UNREADABLE' });
    return;
  }
  const hashed = sha256File(resolved.key);
  if (!hashed.ok) {
    logPre(ctx, input, nowMs, { decision: 'skip', denyCode: 'FILE_UNREADABLE', path: resolved.key });
    return;
  }
  writePreFile(ctx.stateDir, ctx.sid, resolved.key, toolUseId, 'read', { sha: hashed.sha, ts_ms: nowMs, pretool_sid: ctx.sid });
  // Read is never gated: recording its pre-SHA is an allow (PRD §5 enum).
  logPre(ctx, input, nowMs, { decision: 'allow', path: resolved.key });
}

function logPre(ctx, input, nowMs, fields) {
  logDecision(ctx.stateDir, ctx.sid, { tsMs: nowMs, hook: 'PreToolUse', tool: input.tool_name, ...fields });
}

// PreToolUse Write/Edit/MultiEdit: the R3 gate. Returns a deny descriptor
// {denyCode, reason} to block, or null to allow (having recorded pre_sha).
// evaluateGate resolves the canonical key once and hands it back.
function handleWriteGate(ctx, input, nowMs, toolUseId) {
  const gate = evaluateGate(ctx, input.tool_input.file_path, { nowMs });

  if (gate.skip === 'outside_repo') {
    logPre(ctx, input, nowMs, { decision: 'skip', path: gate.key });
    return null; // out of EGHS scope: allow, record nothing
  }

  if (gate.allow) {
    // Matched-and-passed (preSha=state.sha) OR new-file Write (preSha=null).
    writePreFile(ctx.stateDir, ctx.sid, gate.key, toolUseId, 'write', { pre_sha: gate.preSha, ts_ms: nowMs, pretool_sid: ctx.sid });
    logPre(ctx, input, nowMs, {
      decision: 'allow',
      path: gate.key,
      gateApplicable: true,
      hasGatePassingState: gate.preSha !== null,
      evidenceKind: gate.evidence || null, // null on the new-file Write row
    });
    return null;
  }

  if (gate.skip === 'not_applicable') {
    // In-repo, non-gated path: record-only (like P3). pre_sha from disk, or
    // null for a not-yet-existing file.
    let preSha = null;
    if (!gate.missing) {
      const hashed = sha256File(gate.key);
      if (!hashed.ok) {
        logPre(ctx, input, nowMs, { decision: 'skip', denyCode: 'FILE_UNREADABLE', path: gate.key });
        return null;
      }
      preSha = hashed.sha;
    }
    writePreFile(ctx.stateDir, ctx.sid, gate.key, toolUseId, 'write', { pre_sha: preSha, ts_ms: nowMs, pretool_sid: ctx.sid });
    logPre(ctx, input, nowMs, { decision: 'skip', path: gate.key });
    return null;
  }

  // Deny. Delete any pre-file left by a prior invocation so no stale pre_sha
  // survives (PRD §496).
  if (gate.key) deletePreFile(ctx.stateDir, ctx.sid, gate.key, toolUseId, 'write');
  logPre(ctx, input, nowMs, { decision: 'block', denyCode: gate.denyCode, path: gate.key || null, gateApplicable: true });
  return { denyCode: gate.denyCode, reason: gate.reason };
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  let input;
  try {
    const raw = readStdin();
    input = raw ? JSON.parse(raw) : {};
  } catch (err) {
    // INPUT_PARSE (auto-unblock=Yes): a malformed hook payload is a harness
    // fault, not a gate-bypass — fail soft rather than brick every tool call.
    if (dryRun) return runDryRunCli(null, {}, { skipReason: 'input_parse' });
    process.stderr.write(`[eghs] pre-tool-use: stdin parse failed (allow): ${err.message}\n`);
    return;
  }

  const hookKind = TOOL_KINDS[input.tool_name];
  const filePath = input.tool_input && input.tool_input.file_path;
  if (dryRun) return runDryRunCli(hookKind && typeof filePath === 'string' ? hookKind : null, input);
  if (!hookKind || typeof filePath !== 'string') return; // not our tool: allow

  const nowMs = Date.now();
  const toolUseId = normalizeToolUseId(input.tool_use_id);
  const result = runPrecedence(hookKind, input, { env: process.env, cwd: process.cwd(), nowMs });

  if (result.outcome === 'exit0') return; // kill switch / CI / fail-soft skip
  if (result.outcome === 'deny') {
    // NO_SESSION has no valid sid to surface for --clear-sid → sid=none.
    const sid = result.denyCode === 'NO_SESSION' ? null : input.session_id;
    block(result.denyCode, { reason: result.reason, sid });
    return;
  }

  // continue: ctx carries a live lease and the shared guard (held open).
  const ctx = result.ctx;
  try {
    if (hookKind === 'pre-read') {
      recordRead(ctx, input, nowMs, toolUseId);
    } else {
      const deny = handleWriteGate(ctx, input, nowMs, toolUseId);
      if (deny) block(deny.denyCode, { reason: deny.reason, sid: ctx.sid });
    }
  } finally {
    if (typeof ctx.guardFd === 'number') fs.closeSync(ctx.guardFd);
  }
}

try {
  main();
} catch (err) {
  // Fail-soft backstop: an unexpected crash must not brick the tool call.
  process.stderr.write(`[eghs] pre-tool-use hook error (fail-soft, allow): ${err.stack || err.message}\n`);
  process.exitCode = 0;
}
