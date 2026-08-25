'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const {
  getRepoRoot,
  getHeadCommit,
  getChangedFiles,
  shouldSkipVerification,
} = require('../hooks/lib/git');

function sh(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: 'ignore' });
}

function mkGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-git-'));
  sh('git', ['init', '-q'], dir);
  sh('git', ['config', 'user.email', 'a@b.c'], dir);
  sh('git', ['config', 'user.name', 'eghs-test'], dir);
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export {};\n');
  sh('git', ['add', 'a.ts'], dir);
  sh('git', ['commit', '-q', '-m', 'init'], dir);
  return dir;
}

test('getRepoRoot resolves the toplevel for a git repo', () => {
  const dir = mkGitRepo();
  assert.equal(fs.realpathSync(getRepoRoot(dir)), fs.realpathSync(dir));
});

test('getRepoRoot returns null outside a git repo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-nogit-'));
  assert.equal(getRepoRoot(dir), null);
});

test('getHeadCommit returns the current HEAD sha', () => {
  const dir = mkGitRepo();
  const sha = getHeadCommit(dir);
  assert.match(sha, /^[0-9a-f]{40}$/);
});

test('getHeadCommit returns NO_GIT outside a git repo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-nogit2-'));
  assert.equal(getHeadCommit(dir), 'NO_GIT');
});

test('getChangedFiles includes modified tracked files and untracked files', () => {
  const dir = mkGitRepo();
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(dir, 'new.ts'), 'export const y = 1;\n');
  const changed = getChangedFiles(dir, 'HEAD').sort();
  assert.deepEqual(changed, ['a.ts', 'new.ts']);
});

test('getChangedFiles throws (does not silently report []) when diffBase is an invalid revision inside a real repo', () => {
  const dir = mkGitRepo();
  assert.throws(() => getChangedFiles(dir, 'nonexistent-ref-xyz'), /git diff/);
});

test('getChangedFiles degrades to [] (does not throw) when repoRoot is not a git repository at all', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-notrepo-'));
  assert.deepEqual(getChangedFiles(dir, 'HEAD'), []);
});

test('getChangedFiles returns non-ASCII filenames raw, not C-quoted (core.quotePath)', () => {
  const dir = mkGitRepo();
  fs.writeFileSync(path.join(dir, '한글문서.md'), 'hi\n');
  assert.deepEqual(getChangedFiles(dir, 'HEAD'), ['한글문서.md']);
});

test('shouldSkipVerification ignores empty/non-string glob entries instead of crashing (fail-safe)', () => {
  assert.equal(shouldSkipVerification(['a.md'], ['']), false);
  assert.equal(shouldSkipVerification(['a.md'], ['', null, '**/*.md']), true);
});

test('shouldSkipVerification is true when every changed file matches a skip glob', () => {
  assert.equal(
    shouldSkipVerification(['README.md', 'docs/x.md'], ['**/*.md', 'docs/**']),
    true
  );
});

test('shouldSkipVerification is false when any changed file does not match', () => {
  assert.equal(shouldSkipVerification(['README.md', 'src/a.ts'], ['**/*.md']), false);
});

test('shouldSkipVerification is false when there are no changed files and no globs configured', () => {
  assert.equal(shouldSkipVerification([], []), false);
});

// ---- P4 unit 14: carried item 2 (zero-commit repo edge) ----

function mkEmptyGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-git-empty-'));
  sh('git', ['init', '-q'], dir);
  sh('git', ['config', 'user.email', 'a@b.c'], dir);
  sh('git', ['config', 'user.name', 'eghs-test'], dir);
  return dir;
}

test('getChangedFiles reports untracked files in a repo with zero commits instead of throwing', () => {
  const dir = mkEmptyGitRepo();
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export {};\n');
  assert.deepEqual(getChangedFiles(dir, 'NO_GIT'), ['a.ts']);
});

test('getChangedFiles still throws on a bad diff base once the repo HAS commits', () => {
  const dir = mkGitRepo();
  assert.throws(() => getChangedFiles(dir, 'nonexistent-ref-xyz'), /git diff --name-only/);
});

test('a zero-commit repo does not skip verification (untracked file outside the skip globs)', () => {
  const dir = mkEmptyGitRepo();
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export {};\n');
  assert.equal(shouldSkipVerification(getChangedFiles(dir, 'NO_GIT'), ['**/*.md']), false);
});

// ---- git's own stderr must never reach the hook's stderr ----

// execFileSync inherits the child's stderr by default, so every *handled* git
// failure still printed "fatal: ..." to the hook's stderr. That matters most
// on a PreToolUse deny: exit 2 makes stderr the only channel Claude Code
// relays to the model, so stray git chatter is read as part of the block
// reason. Run the calls in a child process to capture what a real hook would
// have emitted.
function stderrOf(expression, cwd) {
  const lib = JSON.stringify(path.join(__dirname, '..', 'hooks', 'lib', 'git.js'));
  const r = spawnSync('node', ['-e', `const g=require(${lib});${expression}`], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `helper crashed: ${r.stderr}`);
  return r.stderr;
}

test('getRepoRoot stays silent outside a git repo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-git-quiet-none-'));
  assert.equal(stderrOf('g.getRepoRoot(process.cwd())', dir), '');
});

test('getHeadCommit stays silent in a repo with zero commits', () => {
  assert.equal(stderrOf('g.getHeadCommit(process.cwd())', mkEmptyGitRepo()), '');
});

test('getChangedFiles stays silent in a repo with zero commits', () => {
  const dir = mkEmptyGitRepo();
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export {};\n');
  assert.equal(stderrOf('g.getChangedFiles(process.cwd(), "NO_GIT")', dir), '');
});

test('a PreToolUse deny in a zero-commit repo emits ONLY the block reason', () => {
  const repo = mkEmptyGitRepo();
  execFileSync('node', [path.join(__dirname, '..', 'hooks', 'init.js')], { cwd: repo, stdio: 'ignore' });
  fs.writeFileSync(path.join(repo, '.claude', 'eghs.config.json'), JSON.stringify({ state_gate_paths: ['**/*.ts'] }));
  const file = path.join(repo, 'a.ts');
  fs.writeFileSync(file, 'export {};\n');
  const r = spawnSync('node', [path.join(__dirname, '..', 'hooks', 'pre-tool-use.js')], {
    cwd: repo,
    encoding: 'utf8',
    input: JSON.stringify({
      session_id: '99999999-9999-4999-8999-999999999999',
      tool_name: 'Edit',
      tool_input: { file_path: file },
      tool_use_id: 'quiet',
    }),
  });
  assert.equal(r.status, 2);
  assert.doesNotMatch(r.stderr, /fatal:/);
  for (const line of r.stderr.split('\n').filter((l) => l.trim() !== '')) {
    assert.match(line, /^(\[eghs\]|\s+→)/, `unexpected stderr line: ${line}`);
  }
});
