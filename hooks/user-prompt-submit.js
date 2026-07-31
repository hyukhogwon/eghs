#!/usr/bin/env node
'use strict';
const fs = require('fs');
const { readStdin } = require('./lib/stdin');
const { runPrecedence } = require('./lib/precedence');
const { DISCIPLINE_PRINCIPLES, buildAdditionalContext } = require('./lib/prompt-discipline');
const { logDecision } = require('./lib/debug-log');
const { runDryRunCli } = require('./lib/dry-run');

// A dying host can close the stdout pipe before we write; the resulting EPIPE
// arrives as an async 'error' event that no sync try/catch can intercept —
// swallow it so the fail-soft exit-0 guarantee holds even then. (EPIPE
// regression guard: DO NOT REMOVE.)
process.stdout.on('error', () => {});

// Emit additionalContext (or nothing) and exit 0. UserPromptSubmit is fail-soft:
// the exit code is ALWAYS 0 — a non-zero (2) exit would erase the user's prompt.
// Use process.exitCode (not process.exit) so the stdout write flushes on a pipe.
function emitContext(text) {
  if (text) process.stdout.write(buildAdditionalContext(text));
  process.exitCode = 0;
}

function main() {
  // Best-effort parse: malformed stdin leaves input {}, which the chain's
  // #3.5 classifies as the UPS NO_SESSION row (exit 0, no additionalContext
  // per PRD §690) — parse failure must never block the prompt (R1).
  let input = {};
  try {
    const raw = readStdin();
    input = raw ? JSON.parse(raw) : {};
  } catch {
    // fall through with input = {}
  }

  // Claude Code exports the project dir explicitly for UPS; honor it before
  // cwd (P2 behavior preserved — cwd is wherever the host launched us).
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (process.argv.includes('--dry-run')) return runDryRunCli('ups', input, { cwd });

  const nowMs = Date.now();
  const result = runPrecedence('ups', input, { env: process.env, cwd, nowMs });

  if (result.outcome === 'continue') {
    // #8: healthy state — inject the discipline principles.
    try {
      logDecision(result.ctx.stateDir, result.ctx.sid, { tsMs: nowMs, hook: 'UserPromptSubmit', decision: 'allow' });
      emitContext(DISCIPLINE_PRINCIPLES);
    } finally {
      if (typeof result.ctx.guardFd === 'number') fs.closeSync(result.ctx.guardFd);
    }
    return;
  }

  // R1 fail-soft: every non-continue outcome degrades to exit 0. The chain
  // never returns deny/marker_exit0 for 'ups' (R6 #3.5/#4/#7 UPS rows are all
  // exit0), and even if it ever did, exit 0 is the only prompt-safe answer.
  if (result.outcome === 'exit0' && result.reason === 'kill_switch') {
    process.stderr.write('[eghs] kill-switch active\n');
  }
  if (result.additionalContext) {
    // R6 #4/#7 UPS rows (PRD §753/§824): stderr warning + the one-line notice
    // as additionalContext; the discipline principles are skipped.
    // additionalContext carries its own "eghs: " source tag for the model;
    // strip it here so the stderr line is not double-prefixed.
    process.stderr.write(`[eghs] ${result.additionalContext.replace(/^eghs: /, '')}\n`);
    emitContext(result.additionalContext);
  } else {
    emitContext(null);
  }
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
