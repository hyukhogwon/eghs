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
