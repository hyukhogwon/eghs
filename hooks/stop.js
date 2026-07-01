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
  process.stdout.write(
    JSON.stringify({
      decision: decision.decision,
      deny_code: decision.deny_code || null,
      reason: decision.reason || null,
      extra: extra || {},
    })
  );
  process.exit(exitCode);
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
    emit(0, { decision: 'allow', reason: 'no valid session_id (NO_SESSION)' });
    return;
  }

  const nowMs = Date.now();
  const uid = process.getuid();
  const envPid = Number(process.env.CLAUDE_CODE_PID);
  const pid = Number.isInteger(envPid) && envPid > 0 ? envPid : process.ppid;

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

  const config = loadConfig(repoRoot);
  const lockResult = acquireStopLock(stateDir, sid, {
    pid,
    uid,
    timeoutMs: config.verification_timeout_seconds * 1000,
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

  // `emit()` calls process.exit(), which would skip a pending `finally` —
  // so build the outcome inside try/finally and only emit (and exit) after
  // the lock has actually been released.
  let outcome;
  try {
    const diffBase = config.diff_base === 'session_baseline' ? baseline.commit : config.diff_base;
    let result;
    try {
      result = await runVerification(config, {
        repoRoot,
        sid,
        stateDir,
        diffBase: diffBase === 'NO_GIT' ? 'HEAD' : diffBase,
        env: process.env,
      });
    } catch (err) {
      appendDebugLog(stateDir, sid, {
        ts_ms: nowMs,
        hook: 'Stop',
        decision: 'block',
        deny_code: 'INFRA_NOT_READY',
      });
      outcome = {
        exitCode: 2,
        decision: { decision: 'block', deny_code: 'INFRA_NOT_READY', reason: err.message },
        extra: {},
      };
      return;
    }

    appendDebugLog(stateDir, sid, {
      ts_ms: nowMs,
      hook: 'Stop',
      decision: result.passed ? 'allow' : 'block',
      deny_code: result.passed ? null : 'VERIFICATION_FAILED',
    });

    if (result.passed) {
      outcome = {
        exitCode: 0,
        decision: { decision: 'allow', reason: result.skipped ? 'skipped (docs-only change)' : null },
        extra: { failedChecks: [] },
      };
    } else {
      outcome = {
        exitCode: 2,
        decision: {
          decision: 'block',
          deny_code: 'VERIFICATION_FAILED',
          reason: `verification failed: ${result.failedChecks.join(', ')}`,
        },
        extra: { results: result.results.map((r) => ({ name: r.name, exitCode: r.exitCode, timedOut: r.timedOut })) },
      };
    }
  } finally {
    lockResult.release();
  }
  emit(outcome.exitCode, outcome.decision, outcome.extra);
}

main().catch((err) => {
  process.stderr.write(`[eghs] stop hook crashed: ${err.stack || err.message}\n`);
  process.exit(1);
});
