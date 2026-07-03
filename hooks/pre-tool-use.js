#!/usr/bin/env node
'use strict';
const { readStdin } = require('./lib/stdin');
const { resolveToolHookContext, isOutsideRepo } = require('./lib/tool-hook');
const { canonicalKey, canonicalKeyAllowMissing, sha256File } = require('./lib/canonical');
const { writePreFile, gcPreFiles } = require('./lib/pre-file');
const { appendDebugLog } = require('./lib/debug-log');

// P3 PreToolUse is RECORD-ONLY: the R3 gate is off, so this hook ALWAYS
// exits 0 — an exit 2 here would deny the tool call itself. Every abnormal
// path degrades to "skip recording", optionally with a stderr note.
process.stdout.on('error', () => {});

const TOOL_KINDS = { Read: 'read', Write: 'write', Edit: 'write', MultiEdit: 'write' };

function main() {
  let input;
  try {
    const raw = readStdin();
    input = raw ? JSON.parse(raw) : {};
  } catch (err) {
    process.stderr.write(`[eghs] pre-tool-use: stdin parse failed (skip): ${err.message}\n`);
    return;
  }

  const kind = TOOL_KINDS[input.tool_name];
  const filePath = input.tool_input && input.tool_input.file_path;
  if (!kind || typeof filePath !== 'string') return;

  const ctx = resolveToolHookContext(input, {
    env: process.env,
    cwd: process.cwd(),
    hookName: 'pre-tool-use',
  });
  if (ctx.skip) return;

  const nowMs = Date.now();
  gcPreFiles(ctx.stateDir, { nowMs });

  const resolved =
    kind === 'write'
      ? canonicalKeyAllowMissing(filePath, { caseless: ctx.caseless })
      : canonicalKey(filePath, { caseless: ctx.caseless });
  if (!resolved.ok) {
    appendDebugLog(ctx.stateDir, ctx.sid, { ts_ms: nowMs, hook: 'PreToolUse', tool: input.tool_name, decision: 'skip', deny_code: 'FILE_UNREADABLE' });
    return;
  }

  if (isOutsideRepo(resolved.key, ctx.repoRoot, ctx.caseless)) {
    appendDebugLog(ctx.stateDir, ctx.sid, { ts_ms: nowMs, hook: 'PreToolUse', tool: input.tool_name, decision: 'skip', deny_code: null });
    return;
  }

  if (kind === 'read') {
    const hashed = sha256File(resolved.key);
    if (!hashed.ok) {
      appendDebugLog(ctx.stateDir, ctx.sid, { ts_ms: nowMs, hook: 'PreToolUse', tool: input.tool_name, decision: 'skip', deny_code: 'FILE_UNREADABLE' });
      return;
    }
    writePreFile(ctx.stateDir, ctx.sid, resolved.key, 'read', { sha: hashed.sha, ts_ms: nowMs, pretool_sid: ctx.sid });
  } else {
    let preSha = null;
    if (!resolved.missing) {
      const hashed = sha256File(resolved.key);
      if (!hashed.ok) {
        // Existing-but-unhashable file: recording pre_sha null would make R4
        // misclassify the edit as a new-file success. Skip instead.
        appendDebugLog(ctx.stateDir, ctx.sid, { ts_ms: nowMs, hook: 'PreToolUse', tool: input.tool_name, decision: 'skip', deny_code: 'FILE_UNREADABLE' });
        return;
      }
      preSha = hashed.sha;
    }
    writePreFile(ctx.stateDir, ctx.sid, resolved.key, 'write', { pre_sha: preSha, ts_ms: nowMs, pretool_sid: ctx.sid });
  }
  appendDebugLog(ctx.stateDir, ctx.sid, { ts_ms: nowMs, hook: 'PreToolUse', tool: input.tool_name, decision: 'record', deny_code: null });
}

try {
  main();
} catch (err) {
  // Fail-soft backstop: record-only hooks must never block a tool call.
  process.stderr.write(`[eghs] pre-tool-use hook error (fail-soft): ${err.stack || err.message}\n`);
}
process.exitCode = 0;
