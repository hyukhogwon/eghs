'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync, spawn } = require('child_process');

const HOOK = path.join(__dirname, '..', 'hooks', 'user-prompt-submit.js');
const INIT = path.join(__dirname, '..', 'hooks', 'init.js');

function mkRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-ups-'));
}

function initRepo(repo) {
  // init.js falls back to cwd when not a git repo, so cwd must be the repo root.
  execFileSync('node', [INIT], { cwd: repo, encoding: 'utf8' });
}

// Neutralize host CI / kill-switch env so tests are deterministic on developer
// machines AND inside CI. rawInput lets a test send deliberately malformed JSON.
function run(repo, { input = {}, env = {}, rawInput } = {}) {
  const res = spawnSync('node', [HOOK], {
    input: rawInput !== undefined ? rawInput : JSON.stringify(input),
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: repo,
      CI: '',
      GITHUB_ACTIONS: '',
      GITLAB_CI: '',
      BUILDKITE: '',
      EGHS_DISABLED: '',
      ...env,
    },
  });
  return { stdout: res.stdout, stderr: res.stderr, code: res.status };
}

const SID = '11111111-1111-4111-8111-111111111111';

test('healthy state injects all three principles as additionalContext, exit 0', () => {
  const repo = mkRepo();
  initRepo(repo);
  const { stdout, code } = run(repo, { input: { session_id: SID, user_input: 'hi' } });
  assert.equal(code, 0);
  const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /Read it first/);
  assert.match(ctx, /out-of-band/);
  assert.match(ctx, /verification/);
});

test('kill switch file suppresses injection, exit 0', () => {
  const repo = mkRepo();
  initRepo(repo);
  fs.writeFileSync(path.join(repo, '.claude', 'eghs-off'), '');
  const { stdout, stderr, code } = run(repo, { input: { session_id: SID } });
  assert.equal(code, 0);
  assert.equal(stdout, '');
  assert.match(stderr, /kill-switch active/);
});

test('kill switch env (EGHS_DISABLED=1) suppresses injection, exit 0', () => {
  const repo = mkRepo();
  initRepo(repo);
  const { stdout, code } = run(repo, { input: { session_id: SID }, env: { EGHS_DISABLED: '1' } });
  assert.equal(code, 0);
  assert.equal(stdout, '');
});

test('CI passthrough (CI=1) suppresses injection, exit 0', () => {
  const repo = mkRepo();
  initRepo(repo);
  const { stdout, code } = run(repo, { input: { session_id: SID }, env: { CI: '1' } });
  assert.equal(code, 0);
  assert.equal(stdout, '');
});

test('uninitialized state injects the init-guidance one-liner, exit 0', () => {
  const repo = mkRepo(); // no initRepo()
  const { stdout, code } = run(repo, { input: { session_id: SID } });
  assert.equal(code, 0);
  const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /not initialized/);
  assert.match(ctx, /hooks\/init\.js/);
});

test('invalid schema_version injects the init-guidance one-liner, exit 0', () => {
  const repo = mkRepo();
  initRepo(repo);
  fs.writeFileSync(path.join(repo, '.claude', 'state', 'eghs', 'schema_version'), '01\n');
  const { stdout, code } = run(repo, { input: { session_id: SID } });
  assert.equal(code, 0);
  assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /not initialized/);
});

test('malformed stdin still injects principles (best-effort parse), exit 0', () => {
  const repo = mkRepo();
  initRepo(repo);
  const { stdout, code } = run(repo, { rawInput: '{ not json' });
  assert.equal(code, 0);
  assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /Read it first/);
});

test('missing session_id still injects principles (P2 needs no sid), exit 0', () => {
  const repo = mkRepo();
  initRepo(repo);
  const { stdout, code } = run(repo, { input: {} });
  assert.equal(code, 0);
  assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /Read it first/);
});

test('EPIPE on stdout (reader gone) still exits 0 (fail-soft)', async () => {
  const repo = mkRepo();
  initRepo(repo);
  const child = spawn('node', [HOOK], {
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: repo,
      CI: '',
      GITHUB_ACTIONS: '',
      GITLAB_CI: '',
      BUILDKITE: '',
      EGHS_DISABLED: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.destroy(); // reader disappears before the hook writes
  child.stdin.end(JSON.stringify({ session_id: SID, user_input: 'hi' }));
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0);
});
