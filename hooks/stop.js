#!/usr/bin/env node
'use strict';
const fs = require('fs');
const { resolveStateDir } = require('./lib/state-dir');
const { readSchemaVersion } = require('./lib/schema');
const { checkKillSwitch } = require('./lib/kill-switch');
const { loadConfig } = require('./lib/config');
const { getRepoRoot } = require('./lib/git');
const { acquireStopLock } = require('./lib/lock');
const { ensureSessionLease, gcSessions, SidCollisionError } = require('./lib/session');
const { ensureBaseline } = require('./lib/baseline');
const { runVerification } = require('./lib/verify');
const { appendDebugLog } = require('./lib/debug-log');

const SID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

function emit(exitCode, decision, extra) {
  // Claude Code's Stop-hook contract: exit 0 + EMPTY stdout allows the stop
  // (its zod output schema only accepts decision "approve"|"block", so any
  // {"decision":"allow"} JSON fails validation), and on exit 2 stdout is not
  // parsed at all — the model receives STDERR as the blocking reason.
  if (exitCode === 2) {
    const lines = [`[eghs] block ${decision.deny_code || 'UNKNOWN'}: ${decision.reason || ''}`];
    for (const r of (extra && extra.results) || []) {
      lines.push(`  - ${r.name}: exit=${r.exitCode}${r.timedOut ? ' (timed out)' : ''}`);
    }
    process.stderr.write(lines.join('\n') + '\n');
  }
  // Not process.exit(): on a pipe (the normal hook-invocation channel),
  // Node does not guarantee a pending write completes before exit() returns,
  // which could truncate the reason. Setting exitCode and returning lets the
  // event loop drain (flushing stderr) before the process exits naturally —
  // main() has no other open handles by this point.
  process.exitCode = exitCode;
}

async function main() {
  // Recursion guard — checked before anything else touches disk (PRD §R5).
  if (process.env.STOP_HOOK_ACTIVE === '1') {
    emit(0, { decision: 'allow', reason: 'recursion guard (env)' });
    return;
  }

  let input;
  try {
    const raw = readStdin();
    input = raw ? JSON.parse(raw) : {};
  } catch {
    emit(2, { decision: 'block', deny_code: 'INPUT_PARSE', reason: 'malformed stdin JSON' });
    return;
  }

  if (input.stop_hook_active === true) {
    emit(0, { decision: 'allow', reason: 'recursion guard (input field)' });
    return;
  }

  const repoRoot = getRepoRoot(process.cwd()) || process.cwd();
  const stateDir = resolveStateDir(repoRoot);

  // Precedence #2: kill switch (stat/env only, no mutation).
  const killSwitch = checkKillSwitch({ repoRoot, env: process.env });
  if (killSwitch.active) {
    process.stderr.write(`[eghs] kill-switch active: ${killSwitch.reason}\n`);
    emit(0, { decision: 'allow', reason: `kill-switch:${killSwitch.reason}` });
    return;
  }

  // Precedence #1/#7 (P1 scope: no eghs-migrate CLI exists, so migrate.lock
  // is never written — only NOT_INITIALIZED/INVALID block Stop; PRD §R6 #7,
  // MISMATCH/FS_INFO_MISSING are treated identically to healthy for Stop).
  const schema = readSchemaVersion(stateDir);
  if (schema.status === 'not_initialized' || schema.status === 'invalid') {
    emit(2, {
      decision: 'block',
      deny_code: 'INFRA_NOT_READY',
      reason: 'eghs state dir missing or corrupt — run `node hooks/init.js`',
    });
    return;
  }

  const sid = input.session_id;
  if (typeof sid !== 'string' || !SID_REGEX.test(sid)) {
    // NO_SESSION signal (PRD §R2.5): allow, but skip all state work.
    // This is a fail-open path, and Claude Code only guarantees session_id
    // is a string (not UUIDv4) — keep it observable on stderr so a host-side
    // format change doesn't silently disable gating forever.
    process.stderr.write(`[eghs] NO_SESSION: missing/invalid session_id — verification gating skipped\n`);
    emit(0, { decision: 'allow', reason: 'no valid session_id (NO_SESSION)' });
    return;
  }

  const nowMs = Date.now();
  const uid = process.getuid();
  // The direct parent is the closest thing to a host pid we get: no
  // CLAUDE_CODE_PID-style env var exists (verified against Claude Code
  // v2.1.198, 2026-07-02 spec audit). Lease staleness detection only needs
  // a pid whose death implies the invoking session is gone.
  const pid = process.ppid;

  let lease;
  let baseline;
  try {
    gcSessions(stateDir, { nowMs, uid });
    lease = ensureSessionLease(stateDir, sid, { pid, uid, nowMs });
    baseline = ensureBaseline(stateDir, sid, { lease, repoRoot });
  } catch (err) {
    const denyCode = err instanceof SidCollisionError ? 'SID_COLLISION' : 'INFRA_NOT_READY';
    appendDebugLog(stateDir, sid, { ts_ms: nowMs, hook: 'Stop', decision: 'block', deny_code: denyCode });
    emit(2, { decision: 'block', deny_code: denyCode, reason: err.message });
    return;
  }

  let config;
  try {
    config = loadConfig(repoRoot);
  } catch (err) {
    emit(2, { decision: 'block', deny_code: 'INFRA_NOT_READY', reason: err.message });
    return;
  }

  // Lock staleness budget must cover the worst-case verification runtime,
  // not a single command's timeout — sequential mode can legitimately run
  // N commands back-to-back (PRD §R5: "60s 목표는 보장하지 않음" for
  // verification_parallel:false). Undercounting here would let a second
  // invocation reclaim a lock still held by a genuinely-running verification.
  const commandCount = Object.values(config.verification_commands).filter(Boolean).length;
  const lockTimeoutMs = config.verification_parallel
    ? config.verification_timeout_seconds * 1000
    : config.verification_timeout_seconds * 1000 * Math.max(commandCount, 1);

  const lockResult = acquireStopLock(stateDir, sid, {
    pid,
    uid,
    timeoutMs: lockTimeoutMs,
    nowMs,
  });
  if (!lockResult.ok) {
    emit(2, {
      decision: 'block',
      deny_code: 'INFRA_NOT_READY',
      reason: 'stop lock held by another active hook invocation (fail-closed)',
    });
    return;
  }

  // `emit()` used to call process.exit(), which would skip a pending
  // `finally` — build the outcome inside try/finally and only emit after
  // the lock has actually been released. Every branch below ASSIGNS
  // `outcome` and falls through to the end of the try block rather than
  // `return`ing early — an early `return` here previously skipped the
  // single `emit()` call after the `finally`, silently exiting 0 instead
  // of reporting the intended block decision.
  let outcome;
  try {
    const diffBase = config.diff_base === 'session_baseline' ? baseline.commit : config.diff_base;
    let result = null;
    let verifyError = null;
    try {
      result = await runVerification(config, {
        repoRoot,
        sid,
        stateDir,
        diffBase: diffBase === 'NO_GIT' ? 'HEAD' : diffBase,
        env: process.env,
      });
    } catch (err) {
      verifyError = err;
    }

    if (verifyError) {
      appendDebugLog(stateDir, sid, {
        ts_ms: nowMs,
        hook: 'Stop',
        decision: 'block',
        deny_code: 'INFRA_NOT_READY',
      });
      outcome = {
        exitCode: 2,
        decision: { decision: 'block', deny_code: 'INFRA_NOT_READY', reason: verifyError.message },
        extra: {},
      };
    } else {
      appendDebugLog(stateDir, sid, {
        ts_ms: nowMs,
        hook: 'Stop',
        decision: result.passed ? 'allow' : 'block',
        deny_code: result.passed ? null : 'VERIFICATION_FAILED',
      });

      outcome = result.passed
        ? {
            exitCode: 0,
            decision: { decision: 'allow', reason: result.skipped ? 'skipped (docs-only change)' : null },
            extra: { failedChecks: [] },
          }
        : {
            exitCode: 2,
            decision: {
              decision: 'block',
              deny_code: 'VERIFICATION_FAILED',
              reason: `verification failed: ${result.failedChecks.join(', ')}`,
            },
            extra: {
              results: result.results.map((r) => ({ name: r.name, exitCode: r.exitCode, timedOut: r.timedOut })),
            },
          };
    }
  } finally {
    lockResult.release();
  }
  emit(outcome.exitCode, outcome.decision, outcome.extra);
}

main().catch((err) => {
  // exit(1) right after an async pipe write can truncate the diagnostic —
  // the same flush window emit() avoids. Waiting for natural exit is not an
  // option here (a crash may leave open handles, e.g. a hung verification
  // child), so exit from the write callback, which fires after the flush.
  process.stderr.write(`[eghs] stop hook crashed: ${err.stack || err.message}\n`, () => process.exit(1));
});
