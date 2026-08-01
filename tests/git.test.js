'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
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
