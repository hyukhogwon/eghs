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
  merged.STOP_HOOK_ACTIVE = '1'; // forced regardless of overlay — PRD §R5
  return merged;
}

function runOne(name, command, config, { cwd, env, logPath }) {
  return new Promise((resolve) => {
    const [shellCmd, ...shellArgs] = config.verification_shell;
    const child = spawn(shellCmd, [...shellArgs, command], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));

    let timedOut = false;
    const timeoutMs = config.verification_timeout_seconds * 1000;
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      const killTimer2 = setTimeout(() => child.kill('SIGKILL'), 5000);
      killTimer2.unref?.();
    }, timeoutMs);
    killTimer.unref?.();

    child.on('close', (exitCode) => {
      clearTimeout(killTimer);
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, output);
      resolve({ name, exitCode: timedOut ? null : exitCode, timedOut, logPath });
    });
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
  const cwd = config.verification_cwd || repoRoot;
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
