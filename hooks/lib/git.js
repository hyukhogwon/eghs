'use strict';
const { execFileSync } = require('child_process');
const picomatch = require('picomatch');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function getRepoRoot(cwd) {
  try {
    return git(['rev-parse', '--show-toplevel'], cwd);
  } catch {
    return null;
  }
}

function getHeadCommit(repoRoot) {
  try {
    return git(['rev-parse', 'HEAD'], repoRoot);
  } catch {
    return 'NO_GIT';
  }
}

function getChangedFiles(repoRoot, diffBase) {
  let tracked = [];
  let untracked = [];
  try {
    const out = git(['diff', '--name-only', diffBase, '--', '.'], repoRoot);
    tracked = out ? out.split('\n').filter(Boolean) : [];
  } catch {
    tracked = [];
  }
  try {
    const out = git(['ls-files', '--others', '--exclude-standard'], repoRoot);
    untracked = out ? out.split('\n').filter(Boolean) : [];
  } catch {
    untracked = [];
  }
  return Array.from(new Set([...tracked, ...untracked]));
}

function shouldSkipVerification(changedFiles, skipGlobs) {
  if (changedFiles.length === 0 || skipGlobs.length === 0) return false;
  const isMatch = picomatch(skipGlobs, { dot: true });
  return changedFiles.every((f) => isMatch(f));
}

module.exports = { getRepoRoot, getHeadCommit, getChangedFiles, shouldSkipVerification };
