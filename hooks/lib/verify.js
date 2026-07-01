'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getChangedFiles, shouldSkipVerification } = require('./git');

function buildEnv(parentEnv, overlay) {
  const merged = { ...parentEnv };
  for (const [key, value] of Object.entries(overlay || {})) {
    if (value === '') delete merged[key];
    else merged[key] = value;
  }
  if (Object.prototype.hasOwnProperty.call(overlay || {}, 'STOP_HOOK_ACTIVE')) {
    process.stderr.write(
      '[eghs] verification_env attempted to set STOP_HOOK_ACTIVE — ignored, forcing "1"\n'
    );
  }
  merged.STOP_HOOK_ACTIVE = '1'; // forced regardless of overlay — PRD §R5
  return merged;
}

// PRD §R5: verification_cwd defaults to repo_root; if the *configured* path
// doesn't exist on disk, fall back to the hook process's own cwd (not
// repo_root again).
function resolveCwd(config, repoRoot) {
  if (!config.verification_cwd) return repoRoot;
  try {
    if (fs.statSync(config.verification_cwd).isDirectory()) return config.verification_cwd;
  } catch {
    // ENOENT or similar -> fall through to process cwd
  }
  return process.cwd();
}

function runOne(name, command, config, { cwd, env, logPath }) {
  return new Promise((resolve) => {
    const [shellCmd, ...shellArgs] = config.verification_shell;
    // detached (POSIX only) puts the child in its own process group so the
    // timeout escalation below can kill descendants it spawns, not just the
    // shell itself. Windows has no process-group kill here — out of PRD
    // scope (§3 non-goal: "Windows 지원").
    const child = spawn(shellCmd, [...shellArgs, command], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));

    function killTree(signal) {
      try {
        if (process.platform !== 'win32' && child.pid) {
          process.kill(-child.pid, signal); // negative pid = whole process group (POSIX)
        } else {
          child.kill(signal);
        }
      } catch {
        // process (group) may already be gone
      }
    }

    let timedOut = false;
    let settled = false;
    let killTimer2 = null;
    const timeoutMs = config.verification_timeout_seconds * 1000;
    const killTimer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      killTimer2 = setTimeout(() => killTree('SIGKILL'), 5000);
      killTimer2.unref?.();
    }, timeoutMs);
    killTimer.unref?.();

    function finish(exitCode, extraOutput) {
      if (settled) return; // 'error' and 'close' can both fire; only resolve once
      settled = true;
      clearTimeout(killTimer);
      if (killTimer2) clearTimeout(killTimer2);
      fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(logPath, output + (extraOutput || ''));
      resolve({ name, exitCode: timedOut ? null : exitCode, timedOut, logPath });
    }

    // A spawn failure (bad verification_shell, ENOENT, EACCES, ...) emits
    // 'error' instead of 'close'. Without this handler Node treats it as an
    // uncaught exception, crashing past the caller's `finally` (lock
    // release) — surface it as a failed check instead (exitCode stays null,
    // which the caller already treats as failing, same as a timeout).
    child.on('error', (err) => finish(null, `[eghs] failed to spawn: ${err.message}`));
    child.on('close', (exitCode) => finish(exitCode));
  });
}

// diffBase failures (e.g. a bad `diff_base` config value) deliberately
// propagate rather than being treated as "no changes" — see hooks/lib/git.js
// getChangedFiles for why silently swallowing would fail open here.
async function runVerification(config, { repoRoot, sid, stateDir, diffBase, env }) {
  const changedFiles = getChangedFiles(repoRoot, diffBase);
  if (shouldSkipVerification(changedFiles, config.skip_if_only_changed)) {
    return { skipped: true, passed: true, failedChecks: [], results: [] };
  }

  const commands = Object.entries(config.verification_commands).filter(([, cmd]) => cmd);
  const cwd = resolveCwd(config, repoRoot);
  const childEnv = buildEnv(env, config.verification_env);
  const logDir = path.join(stateDir, 'verify-logs', sid);

  const runOneCommand = ([name, command]) =>
    runOne(name, command, config, { cwd, env: childEnv, logPath: path.join(logDir, `${name}.log`) });

  let results;
  if (config.verification_parallel) {
    results = await Promise.all(commands.map(runOneCommand));
  } else {
    results = [];
    for (const entry of commands) {
      results.push(await runOneCommand(entry));
    }
  }

  const failedChecks = results.filter((r) => r.timedOut || r.exitCode !== 0).map((r) => r.name);

  return { skipped: false, passed: failedChecks.length === 0, failedChecks, results };
}

module.exports = { runVerification };
