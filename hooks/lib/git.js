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

// Deliberately does NOT swallow every `git diff` failure to []: a bad
// diffBase (e.g. a shallow clone missing the baseline commit) must not be
// silently mistaken for "no changes" — that would make skip_if_only_changed
// fail open. Only "not a git repository at all" degrades softly, matching
// PRD §R5 "git이 없으면... 항상 verification 실행" (never skip on missing git).
// git's own error text for a missing repo differs by subcommand (`git diff`
// says "Could not access 'HEAD'", `git rev-parse` says "not a git
// repository"), so this checks repo-ness explicitly via getRepoRoot instead
// of pattern-matching stderr.
function getChangedFiles(repoRoot, diffBase) {
  if (getRepoRoot(repoRoot) === null) {
    return [];
  }

  let tracked;
  try {
    const out = git(['diff', '--name-only', diffBase, '--', '.'], repoRoot);
    tracked = out ? out.split('\n').filter(Boolean) : [];
  } catch (err) {
    throw new Error(`[eghs] git diff --name-only ${diffBase} failed: ${err.message}`);
  }

  let untracked = [];
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
