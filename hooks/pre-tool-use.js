#!/usr/bin/env node
'use strict';
const path = require('path');
const { readStdin } = require('./lib/stdin');
const { resolveStateDir } = require('./lib/state-dir');
const { readSchemaVersion } = require('./lib/schema');
const { checkKillSwitch } = require('./lib/kill-switch');
const { isCI } = require('./lib/ci');
const { getRepoRoot } = require('./lib/git');
const { readFsInfo } = require('./lib/fs-info');
const { isValidSid } = require('./lib/sid');
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

  const repoRoot = getRepoRoot(process.cwd()) || process.cwd();

  const killSwitch = checkKillSwitch({ repoRoot, env: process.env });
  if (killSwitch.active) return;
  if (isCI(process.env)) return;

  const sid = input.session_id;
  if (!isValidSid(sid)) {
    // NO_SESSION signal: fail-open by design, but keep it observable so a
    // host-side session_id format change can't silently disable recording.
    process.stderr.write('[eghs] pre-tool-use NO_SESSION: missing/invalid session_id — recording skipped\n');
    return;
  }

  const stateDir = resolveStateDir(repoRoot);
  if (readSchemaVersion(stateDir).status !== 'ok') return; // not initialized: UPS nudges, we skip
  const fsInfo = readFsInfo(stateDir);
  if (fsInfo.status !== 'ok') {
    // FS_INFO_MISSING is a deny only when the gate is on (P4). Record-only skips.
    process.stderr.write(`[eghs] pre-tool-use: fs-info ${fsInfo.status} — run \`node hooks/init.js --repair\`; recording skipped\n`);
    return;
  }

  const nowMs = Date.now();
  gcPreFiles(stateDir, { nowMs });

  const caseless = fsInfo.caseless;
  const resolved =
    kind === 'write'
      ? canonicalKeyAllowMissing(filePath, { caseless })
      : canonicalKey(filePath, { caseless });
  if (!resolved.ok) {
    appendDebugLog(stateDir, sid, { ts_ms: nowMs, hook: 'PreToolUse', tool: input.tool_name, decision: 'skip', deny_code: 'FILE_UNREADABLE' });
    return;
  }

  // Out-of-repo canonical keys are out of EGHS scope (PRD §R3): skip, not deny.
  const repoKey = canonicalKey(repoRoot, { caseless });
  if (!repoKey.ok || !(resolved.key + path.sep).startsWith(repoKey.key + path.sep)) {
    appendDebugLog(stateDir, sid, { ts_ms: nowMs, hook: 'PreToolUse', tool: input.tool_name, decision: 'skip', deny_code: null });
    return;
  }

  if (kind === 'read') {
    const hashed = sha256File(resolved.key);
    if (!hashed.ok) {
      appendDebugLog(stateDir, sid, { ts_ms: nowMs, hook: 'PreToolUse', tool: input.tool_name, decision: 'skip', deny_code: 'FILE_UNREADABLE' });
      return;
    }
    writePreFile(stateDir, sid, resolved.key, 'read', { sha: hashed.sha, ts_ms: nowMs, pretool_sid: sid });
  } else {
    let preSha = null;
    if (!resolved.missing) {
      const hashed = sha256File(resolved.key);
      if (!hashed.ok) {
        // Existing-but-unhashable file: recording pre_sha null would make R4
        // misclassify the edit as a new-file success. Skip instead.
        appendDebugLog(stateDir, sid, { ts_ms: nowMs, hook: 'PreToolUse', tool: input.tool_name, decision: 'skip', deny_code: 'FILE_UNREADABLE' });
        return;
      }
      preSha = hashed.sha;
    }
    writePreFile(stateDir, sid, resolved.key, 'write', { pre_sha: preSha, ts_ms: nowMs, pretool_sid: sid });
  }
  appendDebugLog(stateDir, sid, { ts_ms: nowMs, hook: 'PreToolUse', tool: input.tool_name, decision: 'record', deny_code: null });
}

try {
  main();
} catch (err) {
  // Fail-soft backstop: record-only hooks must never block a tool call.
  process.stderr.write(`[eghs] pre-tool-use hook error (fail-soft): ${err.stack || err.message}\n`);
}
process.exitCode = 0;
