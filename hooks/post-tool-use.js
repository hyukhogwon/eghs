#!/usr/bin/env node
'use strict';
const fs = require('fs');
const { readStdin } = require('./lib/stdin');
const { resolveToolHookContext, isOutsideRepo } = require('./lib/tool-hook');
const { loadConfig } = require('./lib/config');
const { canonicalKey, canonicalKeyAllowMissing, sha256File } = require('./lib/canonical');
const { writeReadState, writeFailedMarker, clearMarkersOnSuccess } = require('./lib/read-state');
const { readPreFile, deletePreFile, gcPreFiles } = require('./lib/pre-file');
const { ensureSessionLease } = require('./lib/session');
const { appendDebugLog } = require('./lib/debug-log');

// P3 PostToolUse is RECORD-ONLY: the gate is off, so this hook ALWAYS exits
// 0 — the tool call already ran, and P3's job is only to write evidence.
// Every abnormal path degrades to "skip recording".
process.stdout.on('error', () => {});

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

function skipLog(ctx, input, nowMs, denyCode) {
  appendDebugLog(ctx.stateDir, ctx.sid, {
    ts_ms: nowMs,
    hook: 'PostToolUse',
    tool: input.tool_name,
    decision: 'skip',
    deny_code: denyCode,
  });
}

// R2 Read handler: classify the evidence grade and record it.
function handleRead(ctx, input, config, lease, nowMs) {
  const resolved = canonicalKey(input.tool_input.file_path, { caseless: ctx.caseless });
  if (!resolved.ok) {
    // Vanished or unreadable after the Read ran: nothing provable to record.
    skipLog(ctx, input, nowMs, 'FILE_UNREADABLE');
    return;
  }
  const key = resolved.key;
  if (isOutsideRepo(key, ctx.repoRoot, ctx.caseless)) {
    skipLog(ctx, input, nowMs, null);
    return;
  }

  let size;
  try {
    size = fs.statSync(key).size;
  } catch {
    skipLog(ctx, input, nowMs, 'FILE_UNREADABLE');
    return;
  }

  function recordPartial(observedSize) {
    writeReadState(ctx.stateDir, key, {
      file: key,
      sha: null,
      size: observedSize,
      ts_ms: nowMs,
      sid: ctx.sid,
      evidence: 'partial_read',
    });
    deletePreFile(ctx.stateDir, ctx.sid, key, 'read');
    appendDebugLog(ctx.stateDir, ctx.sid, { ts_ms: nowMs, hook: 'PostToolUse', tool: 'Read', decision: 'record', deny_code: null, evidence: 'partial_read' });
  }

  // partial_read (PRD §R2): explicit offset/limit, or a file too large for
  // the Read tool to have plausibly returned in full. sha stays null — it
  // must never satisfy the R3 gate. The stat check is the cheap fast path
  // that avoids hashing multi-GB files at all.
  const { offset, limit } = input.tool_input;
  if (offset !== undefined || limit !== undefined || size > config.max_full_read_bytes) {
    recordPartial(size);
    return;
  }

  const hashed = sha256File(key);
  if (!hashed.ok) {
    skipLog(ctx, input, nowMs, 'FILE_UNREADABLE');
    return;
  }
  // Re-check with the hash's own byte count: a file that grew past the cap
  // between statSync and the streamed hash must still classify as partial —
  // otherwise a concurrent writer could smuggle an oversized full_read in.
  if (hashed.size > config.max_full_read_bytes) {
    recordPartial(hashed.size);
    return;
  }

  // TOCTOU (PRD §R2): compare against the PreToolUse-time sha when present.
  // A mismatch means the disk changed between the Read tool and this hook —
  // the model may have seen either version, so the evidence is poisoned.
  const pre = readPreFile(ctx.stateDir, ctx.sid, key, 'read');
  const stale = pre !== null && typeof pre.sha === 'string' && pre.sha !== hashed.sha;
  const evidence = stale ? 'stale_read' : 'full_read';

  const wrote = writeReadState(ctx.stateDir, key, {
    file: key,
    sha: hashed.sha,
    size: hashed.size,
    ts_ms: nowMs,
    sid: ctx.sid,
    evidence,
  });

  if (!wrote.ok) {
    writeFailedMarker(ctx.stateDir, key, { sid: ctx.sid, tsMs: nowMs, reason: 'state_record_failed' });
  } else if (stale) {
    writeFailedMarker(ctx.stateDir, key, { sid: ctx.sid, tsMs: nowMs, reason: 'stale_read' });
  } else {
    clearMarkersOnSuccess(ctx.stateDir, key, { sid: ctx.sid, leaseStartMs: lease.start_ms });
  }

  deletePreFile(ctx.stateDir, ctx.sid, key, 'read');
  appendDebugLog(ctx.stateDir, ctx.sid, {
    ts_ms: nowMs,
    hook: 'PostToolUse',
    tool: 'Read',
    decision: wrote.ok ? 'record' : 'skip',
    deny_code: wrote.ok ? null : 'STATE_RECORD_FAILED',
    evidence,
  });
}

function main() {
  let input;
  try {
    const raw = readStdin();
    input = raw ? JSON.parse(raw) : {};
  } catch (err) {
    process.stderr.write(`[eghs] post-tool-use: stdin parse failed (skip): ${err.message}\n`);
    return;
  }

  const isRead = input.tool_name === 'Read';
  const isWrite = WRITE_TOOLS.has(input.tool_name);
  const filePath = input.tool_input && input.tool_input.file_path;
  if ((!isRead && !isWrite) || typeof filePath !== 'string') return;

  const ctx = resolveToolHookContext(input, {
    env: process.env,
    cwd: process.cwd(),
    hookName: 'post-tool-use',
  });
  if (ctx.skip) return;

  let config;
  try {
    config = loadConfig(ctx.repoRoot);
  } catch (err) {
    process.stderr.write(`[eghs] post-tool-use: ${err.message} (recording skipped)\n`);
    return;
  }

  const nowMs = Date.now();
  gcPreFiles(ctx.stateDir, { nowMs });

  // Lease create/renew (PRD §R6 #6): marker policies compare against the
  // session's start_ms, so evidence writes require a live lease.
  let lease;
  try {
    lease = ensureSessionLease(ctx.stateDir, ctx.sid, {
      pid: process.ppid,
      uid: process.getuid(),
      nowMs,
    });
  } catch (err) {
    // R6: lease failure surfaces as a sid-scoped lease_unavailable marker —
    // this sid's evidence for the file is unprovable, but no other session
    // is affected. allowMissing covers new-file Write intents too.
    const resolved = canonicalKeyAllowMissing(filePath, { caseless: ctx.caseless });
    if (resolved.ok) {
      writeFailedMarker(ctx.stateDir, resolved.key, {
        sid: ctx.sid,
        tsMs: nowMs,
        reason: 'lease_unavailable',
        sidScoped: true,
      });
    }
    process.stderr.write(`[eghs] post-tool-use: session lease unavailable (skip): ${err.message}\n`);
    return;
  }

  if (isRead) {
    handleRead(ctx, input, config, lease, nowMs);
  }
  // Write|Edit|MultiEdit: R4 matrix lands in the next unit.
}

try {
  main();
} catch (err) {
  // Fail-soft backstop: record-only hooks must never surface as tool errors.
  process.stderr.write(`[eghs] post-tool-use hook error (fail-soft): ${err.stack || err.message}\n`);
}
process.exitCode = 0;
