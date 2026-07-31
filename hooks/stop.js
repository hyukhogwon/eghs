#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { readStdin } = require('./lib/stdin');
const { runPrecedence } = require('./lib/precedence');
const { resolveStateDir } = require('./lib/state-dir');
const { getRepoRoot } = require('./lib/git');
const { acquireStopLock } = require('./lib/lock');
const { runVerification } = require('./lib/verify');
const { logDecision } = require('./lib/debug-log');
const { runDryRunCli } = require('./lib/dry-run');
const { formatBlock } = require('./lib/deny');

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

// #8 Stop hook logic (verification), entered only on a precedence 'continue'.
// PRD §826: the MISMATCH/FS_INFO_MISSING continue rows carry no lease or
// baseline — verification is state-independent there, so the diff base falls
// back to HEAD when baselines/<sid>.txt is unreadable.
async function runStopLogic(ctx, nowMs) {
  const { stateDir, sid, repoRoot, config } = ctx;

  let baselineCommit = null;
  try {
    baselineCommit = JSON.parse(fs.readFileSync(path.join(stateDir, 'baselines', `${sid}.txt`), 'utf8')).commit;
  } catch {
    // MISMATCH/FS_INFO_MISSING continue rows: no baseline exists by design.
  }
  const diffBase =
    config.diff_base === 'session_baseline' ? baselineCommit || 'NO_GIT' : config.diff_base;

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
    pid: process.ppid,
    uid: process.getuid(),
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

  // Every branch below ASSIGNS `outcome` and falls through to the end of the
  // try block rather than `return`ing early — an early `return` here
  // previously skipped the single `emit()` call after the `finally`,
  // silently exiting 0 instead of reporting the intended block decision.
  let outcome;
  try {
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
      logDecision(stateDir, sid, {
        tsMs: nowMs,
        hook: 'Stop',
        decision: 'block',
        denyCode: 'INFRA_NOT_READY',
      });
      outcome = {
        exitCode: 2,
        decision: { decision: 'block', deny_code: 'INFRA_NOT_READY', reason: verifyError.message },
        extra: {},
      };
    } else {
      logDecision(stateDir, sid, {
        tsMs: nowMs,
        hook: 'Stop',
        decision: result.passed ? 'allow' : 'block',
        denyCode: result.passed ? null : 'VERIFICATION_FAILED',
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

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  // Recursion guard — checked before anything else touches disk (PRD §R5).
  if (process.env.STOP_HOOK_ACTIVE === '1') {
    if (dryRun) return runDryRunCli(null, {}, { skipReason: 'recursion_guard' });
    emit(0, { decision: 'allow', reason: 'recursion guard (env)' });
    return;
  }

  let input;
  try {
    const raw = readStdin();
    input = raw ? JSON.parse(raw) : {};
  } catch {
    if (dryRun) return runDryRunCli(null, {}, { skipReason: 'input_parse' });
    emit(2, { decision: 'block', deny_code: 'INPUT_PARSE', reason: 'malformed stdin JSON' });
    return;
  }

  if (input.stop_hook_active === true) {
    if (dryRun) return runDryRunCli(null, input, { skipReason: 'recursion_guard' });
    emit(0, { decision: 'allow', reason: 'recursion guard (input field)' });
    return;
  }

  // Dry-run stops here: the chain runs mutation-free and #8 verification is
  // NOT executed (it would spawn typecheck/lint and write verify-logs).
  if (dryRun) return runDryRunCli('stop', input);

  // PRD §R6 precedence chain #1-#7. Stop is fail-closed: every deny is a real
  // exit 2 block, and CI passthrough does NOT apply (G3, PRD §688) — the
  // chain itself skips #3 for hookKind 'stop'.
  const nowMs = Date.now();
  const result = runPrecedence('stop', input, { env: process.env, cwd: process.cwd(), nowMs });

  if (result.outcome === 'exit0') {
    // Kill switch (the only exit0 row for Stop): allow with EMPTY stdout.
    emit(0, { decision: 'allow', reason: result.reason });
    return;
  }

  if (result.outcome === 'deny') {
    // R6 #4 Stop row: MIGRATE_IN_PROGRESS is masked as INFRA_NOT_READY
    // (auto-unblock=No — nothing may auto-pass when verification did not
    // run); the ORIGINAL candidate goes to the debug log only. NO_SESSION
    // has no sid, hence no debug path and sid=none in the block line.
    const sid = result.denyCode === 'NO_SESSION' ? null : input.session_id;
    if (typeof sid === 'string') {
      const stateDir = resolveStateDir(getRepoRoot(process.cwd()) || process.cwd());
      logDecision(stateDir, sid, {
        tsMs: nowMs,
        hook: 'Stop',
        decision: 'block',
        denyCode: result.denyCode,
        ...(result.maskedFrom ? { masked_from: result.maskedFrom } : {}),
      });
    }
    process.stderr.write(formatBlock(result.denyCode, { reason: result.reason, sid }));
    process.exitCode = 2;
    return;
  }

  // continue: ctx carries config, a lease when the schema was healthy, and
  // the shared guard (held open through all #8 state mutation).
  const ctx = result.ctx;
  try {
    await runStopLogic(ctx, nowMs);
  } finally {
    if (typeof ctx.guardFd === 'number') fs.closeSync(ctx.guardFd);
  }
}

main().catch((err) => {
  // exit(1) right after an async pipe write can truncate the diagnostic —
  // the same flush window emit() avoids. Waiting for natural exit is not an
  // option here (a crash may leave open handles, e.g. a hung verification
  // child), so exit from the write callback, which fires after the flush.
  process.stderr.write(`[eghs] stop hook crashed: ${err.stack || err.message}\n`, () => process.exit(1));
});
