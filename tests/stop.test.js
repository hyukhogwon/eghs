'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const STOP_SCRIPT = path.join(__dirname, '..', 'hooks', 'stop.js');
const INIT_SCRIPT = path.join(__dirname, '..', 'hooks', 'init.js');
const SID_1 = '11111111-1111-4111-8111-111111111111';

function sh(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: 'ignore' });
}

function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-stop-'));
  sh('git', ['init', '-q'], dir);
  sh('git', ['config', 'user.email', 'a@b.c'], dir);
  sh('git', ['config', 'user.name', 'eghs-test'], dir);
  // Real projects gitignore .claude/state/ (as this repo's own .gitignore
  // does) — without it, the hook's own state writes show up as "changed
  // files" via `git ls-files --others`, which would break
  // skip_if_only_changed for any test fixture that doesn't do this.
  fs.writeFileSync(path.join(dir, '.gitignore'), '.claude/state/\n.claude/eghs-off\n');
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export {};\n');
  sh('git', ['add', 'a.ts', '.gitignore'], dir);
  sh('git', ['commit', '-q', '-m', 'init'], dir);
  return dir;
}

function writeConfig(repo, config) {
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'eghs.config.json'), JSON.stringify(config));
}

// Claude Code's Stop-hook output contract: exit 0 + EMPTY stdout allows the
// stop (any JSON with decision:"allow" fails Claude Code's output schema);
// exit 2 blocks, with the reason on STDERR (stdout is not parsed on exit 2).
function runStop(repo, input, extraEnv = {}) {
  try {
    const stdout = execFileSync('node', [STOP_SCRIPT], {
      cwd: repo,
      input: JSON.stringify(input),
      encoding: 'utf8',
      env: { ...process.env, ...extraEnv },
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err) {
    return { exitCode: err.status, stdout: err.stdout, stderr: err.stderr };
  }
}

test('allows (exit 0) with EMPTY stdout when verification commands all pass', () => {
  const repo = mkRepo();
  execFileSync('node', [INIT_SCRIPT], { cwd: repo });
  writeConfig(repo, { verification_commands: { typecheck: 'true' } });
  const { exitCode, stdout } = runStop(repo, { session_id: SID_1 });
  assert.equal(exitCode, 0);
  assert.equal(stdout, '');
});

test('blocks (exit 2) with the deny_code and failed check named on stderr', () => {
  const repo = mkRepo();
  execFileSync('node', [INIT_SCRIPT], { cwd: repo });
  writeConfig(repo, { verification_commands: { lint: 'false' } });
  const { exitCode, stdout, stderr } = runStop(repo, { session_id: SID_1 });
  assert.equal(exitCode, 2);
  assert.equal(stdout, '');
  assert.match(stderr, /VERIFICATION_FAILED/);
  assert.match(stderr, /lint/);
  // Per-check detail line so the model sees which command failed and how.
  assert.match(stderr, /lint: exit=1/);
});

test('kill switch (.claude/eghs-off) allows immediately without running verification', () => {
  const repo = mkRepo();
  execFileSync('node', [INIT_SCRIPT], { cwd: repo });
  writeConfig(repo, { verification_commands: { lint: 'false' } });
  fs.writeFileSync(path.join(repo, '.claude', 'eghs-off'), '');
  const { exitCode, stdout } = runStop(repo, { session_id: SID_1 });
  assert.equal(exitCode, 0);
  assert.equal(stdout, '');
});

test('EGHS_DISABLED=1 allows immediately even with a failing command', () => {
  const repo = mkRepo();
  execFileSync('node', [INIT_SCRIPT], { cwd: repo });
  writeConfig(repo, { verification_commands: { lint: 'false' } });
  const { exitCode, stdout } = runStop(repo, { session_id: SID_1 }, { EGHS_DISABLED: '1' });
  assert.equal(exitCode, 0);
  assert.equal(stdout, '');
});

test('STOP_HOOK_ACTIVE=1 recursion guard allows immediately', () => {
  const repo = mkRepo();
  execFileSync('node', [INIT_SCRIPT], { cwd: repo });
  writeConfig(repo, { verification_commands: { lint: 'false' } });
  const { exitCode, stdout } = runStop(repo, { session_id: SID_1 }, { STOP_HOOK_ACTIVE: '1' });
  assert.equal(exitCode, 0);
  assert.equal(stdout, '');
});

test('stop_hook_active:true in hook input is treated the same as the env recursion guard', () => {
  const repo = mkRepo();
  execFileSync('node', [INIT_SCRIPT], { cwd: repo });
  writeConfig(repo, { verification_commands: { lint: 'false' } });
  const { exitCode, stdout } = runStop(repo, { session_id: SID_1, stop_hook_active: true });
  assert.equal(exitCode, 0);
  assert.equal(stdout, '');
});

test('blocks with INFRA_NOT_READY on stderr when eghs-init was never run', () => {
  const repo = mkRepo();
  writeConfig(repo, { verification_commands: { lint: 'false' } });
  const { exitCode, stderr } = runStop(repo, { session_id: SID_1 });
  assert.equal(exitCode, 2);
  assert.match(stderr, /INFRA_NOT_READY/);
});

test('a second concurrent Stop invocation for the same sid fails closed (lock contention)', () => {
  const repo = mkRepo();
  execFileSync('node', [INIT_SCRIPT], { cwd: repo });
  writeConfig(repo, { verification_commands: { typecheck: 'sleep 3' } });
  const stateDir = path.join(repo, '.claude', 'state', 'eghs');
  fs.mkdirSync(path.join(stateDir, 'locks', 'tmp'), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'locks', `stop-${SID_1}.lock`),
    JSON.stringify({ pid: process.pid, uid: process.getuid(), start_ms: Date.now(), timeout_ms: 45000 })
  );
  const { exitCode, stderr } = runStop(repo, { session_id: SID_1 });
  assert.equal(exitCode, 2);
  assert.match(stderr, /INFRA_NOT_READY/);
});

test('malformed stdin JSON is reported as INPUT_PARSE, not a crash', () => {
  const repo = mkRepo();
  execFileSync('node', [INIT_SCRIPT], { cwd: repo });
  let result;
  try {
    execFileSync('node', [STOP_SCRIPT], { cwd: repo, input: '{ not json', encoding: 'utf8' });
    result = { threw: false };
  } catch (err) {
    result = { threw: true, status: err.status, stderr: err.stderr };
  }
  assert.equal(result.threw, true);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /INPUT_PARSE/);
});

test('missing/invalid session_id allows (NO_SESSION signal) without touching state', () => {
  const repo = mkRepo();
  execFileSync('node', [INIT_SCRIPT], { cwd: repo });
  writeConfig(repo, { verification_commands: { lint: 'false' } });
  const { exitCode, stdout } = runStop(repo, { session_id: 'not-a-uuid' });
  assert.equal(exitCode, 0);
  assert.equal(stdout, '');
  const stateDir = path.join(repo, '.claude', 'state', 'eghs');
  assert.ok(!fs.existsSync(path.join(stateDir, 'sessions', 'not-a-uuid.json')));
});

test('a second Stop run for the same sid reuses the same baseline (idempotent across renewal)', () => {
  const repo = mkRepo();
  execFileSync('node', [INIT_SCRIPT], { cwd: repo });
  writeConfig(repo, { verification_commands: { typecheck: 'true' } });
  const first = runStop(repo, { session_id: SID_1 });
  const second = runStop(repo, { session_id: SID_1 });
  assert.equal(first.exitCode, 0);
  assert.equal(second.exitCode, 0);
  const stateDir = path.join(repo, '.claude', 'state', 'eghs');
  const baseline = JSON.parse(
    fs.readFileSync(path.join(stateDir, 'baselines', `${SID_1}.txt`), 'utf8')
  );
  assert.equal(baseline.lease_pid, JSON.parse(
    fs.readFileSync(path.join(stateDir, 'sessions', `${SID_1}.json`), 'utf8')
  ).pid);
});

test('skip_if_only_changed skips verification entirely for a docs-only change', () => {
  const repo = mkRepo();
  execFileSync('node', [INIT_SCRIPT], { cwd: repo });
  // Config must already be committed — only README.md is the "change" under
  // test; an uncommitted config file would itself count as a changed file.
  writeConfig(repo, {
    verification_commands: { typecheck: 'false' },
    skip_if_only_changed: ['**/*.md'],
  });
  sh('git', ['add', '.claude/eghs.config.json'], repo);
  sh('git', ['commit', '-q', '-m', 'add config'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
  const { exitCode, stdout } = runStop(repo, { session_id: SID_1 });
  assert.equal(exitCode, 0);
  assert.equal(stdout, '');
});

test('a bad diff_base produces a real block with a stderr reason, not a silent exit 0', () => {
  const repo = mkRepo();
  execFileSync('node', [INIT_SCRIPT], { cwd: repo });
  writeConfig(repo, {
    verification_commands: { typecheck: 'true' },
    diff_base: 'nonexistent-ref-xyz',
  });
  const { exitCode, stderr } = runStop(repo, { session_id: SID_1 });
  assert.equal(exitCode, 2);
  assert.match(stderr, /INFRA_NOT_READY/);
});

test('a spawn failure (bad verification_shell) blocks with a classified deny_code instead of crashing', () => {
  const repo = mkRepo();
  execFileSync('node', [INIT_SCRIPT], { cwd: repo });
  writeConfig(repo, {
    verification_commands: { typecheck: 'true' },
    verification_shell: ['/no/such/shell/binary'],
  });
  const { exitCode, stderr } = runStop(repo, { session_id: SID_1 });
  assert.equal(exitCode, 2);
  assert.match(stderr, /VERIFICATION_FAILED/);
});

test('malformed eghs.config.json blocks with INFRA_NOT_READY instead of crashing with exit 1', () => {
  const repo = mkRepo();
  execFileSync('node', [INIT_SCRIPT], { cwd: repo });
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'eghs.config.json'), '{ not json');
  const { exitCode, stderr } = runStop(repo, { session_id: SID_1 });
  assert.equal(exitCode, 2);
  assert.match(stderr, /INFRA_NOT_READY/);
});

test('the recursion lock is released after a bad-diff_base block (a following run is not lock-contended)', () => {
  const repo = mkRepo();
  execFileSync('node', [INIT_SCRIPT], { cwd: repo });
  writeConfig(repo, {
    verification_commands: { typecheck: 'true' },
    diff_base: 'nonexistent-ref-xyz',
  });
  const first = runStop(repo, { session_id: SID_1 });
  assert.match(first.stderr, /INFRA_NOT_READY/);
  const stateDir = path.join(repo, '.claude', 'state', 'eghs');
  assert.ok(!fs.existsSync(path.join(stateDir, 'locks', `stop-${SID_1}.lock`)));
});
