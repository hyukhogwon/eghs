'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { runVerification } = require('../hooks/lib/verify');

function mkGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-verify-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'eghs-test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export {};\n');
  execFileSync('git', ['add', 'a.ts'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  fs.mkdirSync(path.join(dir, '.claude', 'state', 'eghs', 'verify-logs', 'sid-1'), {
    recursive: true,
  });
  return dir;
}

const baseConfig = (overrides) => ({
  verification_commands: {},
  verification_parallel: true,
  verification_timeout_seconds: 5,
  verification_shell: ['/bin/sh', '-c'],
  verification_env: {},
  skip_if_only_changed: [],
  matcher_engine: 'picomatch',
  ...overrides,
});

test('runVerification passes when all commands exit 0', async () => {
  const repoRoot = mkGitRepo();
  const stateDir = path.join(repoRoot, '.claude', 'state', 'eghs');
  const result = await runVerification(baseConfig({ verification_commands: { typecheck: 'true' } }), {
    repoRoot,
    sid: 'sid-1',
    stateDir,
    diffBase: 'HEAD',
    env: process.env,
  });
  assert.equal(result.skipped, false);
  assert.equal(result.passed, true);
  assert.deepEqual(result.failedChecks, []);
});

test('runVerification fails and reports the failing check name when a command exits non-zero', async () => {
  const repoRoot = mkGitRepo();
  const stateDir = path.join(repoRoot, '.claude', 'state', 'eghs');
  const result = await runVerification(baseConfig({ verification_commands: { lint: 'false' } }), {
    repoRoot,
    sid: 'sid-1',
    stateDir,
    diffBase: 'HEAD',
    env: process.env,
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.failedChecks, ['lint']);
});

test('runVerification writes a log file per command under verify-logs/<sid>/', async () => {
  const repoRoot = mkGitRepo();
  const stateDir = path.join(repoRoot, '.claude', 'state', 'eghs');
  await runVerification(baseConfig({ verification_commands: { typecheck: 'echo hello' } }), {
    repoRoot,
    sid: 'sid-1',
    stateDir,
    diffBase: 'HEAD',
    env: process.env,
  });
  const log = fs.readFileSync(path.join(stateDir, 'verify-logs', 'sid-1', 'typecheck.log'), 'utf8');
  assert.match(log, /hello/);
});

test('runVerification skips entirely when all changed files match skip_if_only_changed', async () => {
  const repoRoot = mkGitRepo();
  fs.writeFileSync(path.join(repoRoot, 'README.md'), 'hi\n');
  const stateDir = path.join(repoRoot, '.claude', 'state', 'eghs');
  const result = await runVerification(
    baseConfig({ verification_commands: { typecheck: 'false' }, skip_if_only_changed: ['**/*.md'] }),
    { repoRoot, sid: 'sid-1', stateDir, diffBase: 'HEAD', env: process.env }
  );
  assert.equal(result.skipped, true);
  assert.equal(result.passed, true);
});

test('runVerification forces STOP_HOOK_ACTIVE=1 for child processes regardless of verification_env', async () => {
  const repoRoot = mkGitRepo();
  const stateDir = path.join(repoRoot, '.claude', 'state', 'eghs');
  await runVerification(
    baseConfig({
      verification_commands: { typecheck: 'echo $STOP_HOOK_ACTIVE' },
      verification_env: { STOP_HOOK_ACTIVE: '' },
    }),
    { repoRoot, sid: 'sid-1', stateDir, diffBase: 'HEAD', env: process.env }
  );
  const log = fs.readFileSync(path.join(stateDir, 'verify-logs', 'sid-1', 'typecheck.log'), 'utf8');
  assert.match(log, /^1/m);
});

test('runVerification marks a timed-out command as failed', async () => {
  const repoRoot = mkGitRepo();
  const stateDir = path.join(repoRoot, '.claude', 'state', 'eghs');
  const result = await runVerification(
    baseConfig({ verification_commands: { test: 'sleep 5' }, verification_timeout_seconds: 1 }),
    { repoRoot, sid: 'sid-1', stateDir, diffBase: 'HEAD', env: process.env }
  );
  assert.equal(result.passed, false);
  assert.equal(result.results[0].timedOut, true);
});

test('runVerification runs commands in parallel when verification_parallel is true', async () => {
  const repoRoot = mkGitRepo();
  const stateDir = path.join(repoRoot, '.claude', 'state', 'eghs');
  const start = process.hrtime.bigint();
  await runVerification(
    baseConfig({
      verification_commands: { a: 'sleep 0.3', b: 'sleep 0.3' },
      verification_parallel: true,
    }),
    { repoRoot, sid: 'sid-1', stateDir, diffBase: 'HEAD', env: process.env }
  );
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(elapsedMs < 550, `expected parallel run under 550ms, took ${elapsedMs}ms`);
});

test('runVerification propagates a bad diff_base as a thrown error instead of silently skipping', async () => {
  const repoRoot = mkGitRepo();
  const stateDir = path.join(repoRoot, '.claude', 'state', 'eghs');
  await assert.rejects(
    () =>
      runVerification(baseConfig({ verification_commands: { lint: 'false' } }), {
        repoRoot,
        sid: 'sid-1',
        stateDir,
        diffBase: 'nonexistent-ref-xyz',
        env: process.env,
      }),
    /git diff/
  );
});
