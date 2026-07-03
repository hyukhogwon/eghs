#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { readStdin } = require('./lib/stdin');
const { resolveToolHookContext, isOutsideRepo } = require('./lib/tool-hook');
const { loadConfig } = require('./lib/config');
const { canonicalKey, canonicalKeyAllowMissing, keyHash, sha256File } = require('./lib/canonical');
const { isAlive } = require('./lib/proc');
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

// R4 2nd-pass pre-file search (PRD lines 443-453), P3-simplified: when this
// sid has no pre-record, look for orphaned write pre-files left by dead
// sessions (crashed before their PostToolUse). Live-lease sids are never
// touched. Deviation from the PRD's full fstat/re-stat TOCTOU dance is
// deliberate for record-only P3 — the worst case is a lost dead-sid marker,
// which cannot affect any gate decision.
// A sid is dead only when its lease is provably absent (ENOENT) or names a
// dead pid. A present-but-unreadable/unparseable lease is treated as LIVE
// (fail-closed): unlinking a live session's pre-file would poison its own
// PostToolUse pass.
function leaseIsDead(stateDir, sid) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(stateDir, 'sessions', `${sid}.json`), 'utf8');
  } catch (err) {
    return err.code === 'ENOENT';
  }
  try {
    return !isAlive(JSON.parse(raw).pid);
  } catch {
    return false;
  }
}

function handleMissingPre(ctx, key, nowMs) {
  const preRoot = path.join(ctx.stateDir, 'pre');
  const orphanName = `${keyHash(key)}.write.json`;
  let sids = [];
  try {
    sids = fs.readdirSync(preRoot);
  } catch {
    // pre/ unreadable: fall through to the current-sid marker below.
  }
  let orphanFound = false;
  for (const otherSid of sids) {
    if (otherSid === ctx.sid || otherSid === 'tmp') continue;
    const orphanPath = path.join(preRoot, otherSid, orphanName);
    if (!fs.existsSync(orphanPath)) continue;
    if (!leaseIsDead(ctx.stateDir, otherSid)) continue; // 활성 lease 보호: never touch a live session
    orphanFound = true;
    // Marker lands under the DEAD sid (origin preserved): it can never block
    // the current session, only document the dead one's unfinished edit.
    writeFailedMarker(ctx.stateDir, key, {
      sid: otherSid,
      tsMs: nowMs,
      reason: 'state_record_failed',
      sidScoped: true,
    });
    // Re-verify right before the destructive step (PRD R4 line 451): the sid
    // may have been revived since the check above. If so, leave the pre-file
    // for the revived session's own PostToolUse to consume.
    if (!leaseIsDead(ctx.stateDir, otherSid)) continue;
    try {
      fs.unlinkSync(orphanPath);
    } catch {
      // raced with GC: fine
    }
  }
  if (!orphanFound) {
    // PreToolUse never ran (or was GC'd): the root cause is this sid's own
    // record chain, so the marker is scoped to it (PRD R4 step 5).
    writeFailedMarker(ctx.stateDir, key, {
      sid: ctx.sid,
      tsMs: nowMs,
      reason: 'state_record_failed',
      sidScoped: true,
    });
  }
}

// R4 processing matrix (PRD lines 457-468) — gate off, records only.
function handleWrite(ctx, input, lease, nowMs) {
  const resolved = canonicalKeyAllowMissing(input.tool_input.file_path, { caseless: ctx.caseless });
  if (!resolved.ok) {
    skipLog(ctx, input, nowMs, 'FILE_UNREADABLE');
    return;
  }
  const key = resolved.key;
  if (isOutsideRepo(key, ctx.repoRoot, ctx.caseless)) {
    skipLog(ctx, input, nowMs, null);
    return;
  }

  // post_sha: disk truth after the tool ran; null = file absent (PRD R4).
  // Exists-but-unreadable is NOT null — treating it as a clean absence would
  // swallow a real disk change, so it skips instead.
  const post = sha256File(key);
  if (!post.ok && !post.missing) {
    skipLog(ctx, input, nowMs, 'FILE_UNREADABLE');
    return;
  }
  const postSha = post.ok ? post.sha : null;

  const pre = readPreFile(ctx.stateDir, ctx.sid, key, 'write');
  if (pre !== null && pre.pretool_sid !== ctx.sid) {
    // MVP #17: pretool_sid/posttool_sid invariant broken — poisoned record.
    // Marker BEFORE deleting the pre-file: if the marker write fails, the
    // pre-file must survive as the only remaining trace of the poisoning.
    writeFailedMarker(ctx.stateDir, key, { sid: ctx.sid, tsMs: nowMs, reason: 'state_record_failed', sidScoped: true });
    deletePreFile(ctx.stateDir, ctx.sid, key, 'write');
    skipLog(ctx, input, nowMs, 'STATE_RECORD_FAILED');
    return;
  }
  if (pre === null) {
    handleMissingPre(ctx, key, nowMs);
    skipLog(ctx, input, nowMs, 'STATE_RECORD_FAILED');
    return;
  }
  const preSha = typeof pre.pre_sha === 'string' ? pre.pre_sha : null;

  const toolError = !!(input.tool_response && input.tool_response.error);
  const changed = postSha !== preSha;

  let evidence = null; // null → keep existing state untouched
  let markerReason = null;
  let warn = null;
  if (!toolError) {
    if (preSha === null && postSha !== null) evidence = 'post_edit_success'; // new file success (best-effort)
    else if (preSha === null && postSha === null) {
      markerReason = 'state_record_failed'; // unexpected: Write "succeeded" but nothing on disk
      warn = 'edit reported success but the file does not exist';
    } else if (changed) evidence = 'post_edit_success'; // edit success
    // else: no-op edit → state 유지
  } else {
    if (preSha === null && postSha !== null) {
      evidence = 'post_edit_partial';
      markerReason = 'overwrite_race'; // errored new-file Write left bytes behind
    } else if (preSha !== null && changed) {
      evidence = 'post_edit_partial';
      markerReason = 'post_edit_partial'; // partial apply
    }
    // else: clean failure → 변경 없음, state 유지
  }

  let recordFailed = false;
  if (evidence !== null) {
    const wrote = writeReadState(ctx.stateDir, key, {
      file: key,
      sha: postSha,
      size: post.ok ? post.size : 0,
      ts_ms: nowMs,
      sid: ctx.sid,
      evidence,
    });
    recordFailed = !wrote.ok;
  }
  if (recordFailed) {
    writeFailedMarker(ctx.stateDir, key, { sid: ctx.sid, tsMs: nowMs, reason: 'state_record_failed' });
  } else if (markerReason !== null) {
    writeFailedMarker(ctx.stateDir, key, { sid: ctx.sid, tsMs: nowMs, reason: markerReason });
  } else if (evidence === 'post_edit_success') {
    clearMarkersOnSuccess(ctx.stateDir, key, { sid: ctx.sid, leaseStartMs: lease.start_ms });
  }
  if (warn) process.stderr.write(`[eghs] post-tool-use: ${warn}: ${key}\n`);

  deletePreFile(ctx.stateDir, ctx.sid, key, 'write'); // PRD R4: consumed last
  appendDebugLog(ctx.stateDir, ctx.sid, {
    ts_ms: nowMs,
    hook: 'PostToolUse',
    tool: input.tool_name,
    decision: evidence || markerReason ? 'record' : 'skip',
    // STATE_RECORD_FAILED only when no evidence landed — matrix rows that
    // record post_edit_partial alongside their marker are not record failures.
    deny_code: recordFailed || markerReason === 'state_record_failed' ? 'STATE_RECORD_FAILED' : null,
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
  } else {
    handleWrite(ctx, input, lease, nowMs);
  }
}

try {
  main();
} catch (err) {
  // Fail-soft backstop: record-only hooks must never surface as tool errors.
  process.stderr.write(`[eghs] post-tool-use hook error (fail-soft): ${err.stack || err.message}\n`);
}
process.exitCode = 0;
