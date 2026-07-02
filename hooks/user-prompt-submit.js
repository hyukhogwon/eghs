#!/usr/bin/env node
'use strict';
const fs = require('fs');
const { resolveStateDir } = require('./lib/state-dir');
const { readSchemaVersion } = require('./lib/schema');
const { checkKillSwitch } = require('./lib/kill-switch');
const { isCI } = require('./lib/ci');
const {
  DISCIPLINE_PRINCIPLES,
  INIT_GUIDANCE,
  buildAdditionalContext,
} = require('./lib/prompt-discipline');

// A dying host can close the stdout pipe before we write; the resulting EPIPE
// arrives as an async 'error' event that no sync try/catch can intercept —
// swallow it so the fail-soft exit-0 guarantee holds even then.
process.stdout.on('error', () => {});

// Duplicated from hooks/stop.js on purpose — see plan Global Constraints.
function readStdin() {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  while (true) {
    let bytesRead;
    try {
      bytesRead = fs.readSync(0, buf, 0, buf.length, null);
    } catch (err) {
      if (err.code === 'EAGAIN') continue;
      if (err.code === 'EOF') break;
      throw err;
    }
    if (bytesRead === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Emit additionalContext (or nothing) and exit 0. UserPromptSubmit is fail-soft:
// the exit code is ALWAYS 0 — a non-zero (2) exit would erase the user's prompt.
// Use process.exitCode (not process.exit) so the stdout write flushes on a pipe.
function emitContext(text) {
  if (text) process.stdout.write(buildAdditionalContext(text));
  process.exitCode = 0;
}

function main() {
  // Drain stdin so the writer never sees a broken pipe. P2 uses no input field,
  // and the principles are input-independent, so parse failure is irrelevant.
  try {
    readStdin();
  } catch {
    // ignore — fall through to injection
  }

  const repoRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // Kill switch: EGHS fully off -> inject nothing.
  const killSwitch = checkKillSwitch({ repoRoot, env: process.env });
  if (killSwitch.active) {
    process.stderr.write(`[eghs] kill-switch active: ${killSwitch.reason}\n`);
    emitContext(null);
    return;
  }

  // CI: no interactive model to nudge (PRD §6) -> inject nothing.
  if (isCI(process.env)) {
    emitContext(null);
    return;
  }

  // Schema stat (fail-soft): not initialized / corrupt -> one-line init nudge.
  const schema = readSchemaVersion(resolveStateDir(repoRoot));
  if (schema.status !== 'ok') {
    process.stderr.write(`[eghs] state ${schema.status}; injecting init guidance\n`);
    emitContext(INIT_GUIDANCE);
    return;
  }

  emitContext(DISCIPLINE_PRINCIPLES);
}

// Fail-soft backstop: a crash must never block the prompt (exit 0, not 1).
try {
  main();
} catch (err) {
  process.stderr.write(
    `[eghs] user-prompt-submit hook error (fail-soft): ${err.stack || err.message}\n`
  );
  process.exitCode = 0;
}
