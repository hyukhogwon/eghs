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

test('P4: uninitialized state injects the R6 #7 init nudge as additionalContext, exit 0', () => {
  const repo = mkRepo(); // no initRepo()
  const { stdout, stderr, code } = run(repo, { input: { session_id: SID } });
  assert.equal(code, 0);
  const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /eghs-init/);
  assert.match(stderr, /state not ready/); // PRD §824: stderr warning too
});

test('P4: invalid schema_version injects the init nudge (fail-soft), exit 0', () => {
  const repo = mkRepo();
  initRepo(repo);
  fs.writeFileSync(path.join(repo, '.claude', 'state', 'eghs', 'schema_version'), '01\n');
  const { stdout, code } = run(repo, { input: { session_id: SID } });
  assert.equal(code, 0);
  assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /eghs-init/);
});

test('P4: malformed stdin degrades to NO_SESSION fail-soft — exit 0, NO injection (PRD §690)', () => {
  const repo = mkRepo();
  initRepo(repo);
  const { stdout, code } = run(repo, { rawInput: '{ not json' });
  assert.equal(code, 0);
  assert.equal(stdout, '');
});

test('P4: missing session_id → exit 0 with NO additionalContext (R6 #3.5 UPS row)', () => {
  const repo = mkRepo();
  initRepo(repo);
  const { stdout, code } = run(repo, { input: {} });
  assert.equal(code, 0);
  assert.equal(stdout, '');
});

test('P4: live migrate.lock injects a migrate-in-progress notice instead of principles', () => {
  const repo = mkRepo();
  initRepo(repo);
  fs.writeFileSync(
    path.join(repo, '.claude', 'state', 'eghs', 'migrate.lock'),
    JSON.stringify({ pid: process.pid, uid: process.getuid(), start_ms: Date.now() })
  );
  const { stdout, code } = run(repo, { input: { session_id: SID } });
  assert.equal(code, 0);
  const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /migrate in progress/);
  assert.ok(!/Read it first/.test(ctx), 'discipline principles are skipped on this row');
});

test('P4: schema MISMATCH injects a migrate nudge (fail-soft), exit 0', () => {
  const repo = mkRepo();
  initRepo(repo);
  fs.writeFileSync(path.join(repo, '.claude', 'state', 'eghs', 'schema_version'), '999\n');
  const { stdout, code } = run(repo, { input: { session_id: SID } });
  assert.equal(code, 0);
  assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /eghs-migrate/);
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

// ---- P4 unit 14: carried item 3 (CLAUDE_PROJECT_DIR unset → cwd fallback) ----

test('falls back to cwd when CLAUDE_PROJECT_DIR is unset', () => {
  const repo = mkRepo();
  initRepo(repo);
  const env = { ...process.env, CI: '', GITHUB_ACTIONS: '', GITLAB_CI: '', BUILDKITE: '', EGHS_DISABLED: '' };
  delete env.CLAUDE_PROJECT_DIR;
  const res = spawnSync('node', [HOOK], {
    input: JSON.stringify({ session_id: SID, user_input: 'hi' }),
    encoding: 'utf8',
    cwd: repo,
    env,
  });
  assert.equal(res.status, 0);
  assert.match(JSON.parse(res.stdout).hookSpecificOutput.additionalContext, /Read it first/);
});

test('an unset CLAUDE_PROJECT_DIR still honors the cwd repo kill switch', () => {
  const repo = mkRepo();
  initRepo(repo);
  fs.writeFileSync(path.join(repo, '.claude', 'eghs-off'), '');
  const env = { ...process.env, CI: '', GITHUB_ACTIONS: '', GITLAB_CI: '', BUILDKITE: '', EGHS_DISABLED: '' };
  delete env.CLAUDE_PROJECT_DIR;
  const res = spawnSync('node', [HOOK], {
    input: JSON.stringify({ session_id: SID }),
    encoding: 'utf8',
    cwd: repo,
    env,
  });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
});
