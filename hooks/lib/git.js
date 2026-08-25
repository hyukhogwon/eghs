'use strict';
const { execFileSync } = require('child_process');
const picomatch = require('picomatch');

function git(args, cwd) {
  // core.quotePath defaults to true, which C-quotes non-ASCII filenames
  // ("\355\225\234...") in diff/ls-files output — those strings never match
  // any glob, silently disabling skip/gate matching for e.g. Korean names.
  return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd,
    encoding: 'utf8',
    // execFileSync inherits the child's stderr by default, so git's own
    // "fatal: not a git repository" / "ambiguous argument 'HEAD'" text reached
    // the hook's stderr even on the paths that catch and handle those cases.
    // On a deny that matters: exit 2 makes stderr the ONLY channel Claude Code
    // relays to the model (PRD §MVP item 7), so unrelated git chatter would be
    // read as part of the block reason. Callers use err.message, which the
    // pipe preserves.
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
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
function hasCommits(repoRoot) {
  try {
    git(['rev-parse', '--verify', 'HEAD'], repoRoot);
    return true;
  } catch {
    return false;
  }
}

function getChangedFiles(repoRoot, diffBase) {
  if (getRepoRoot(repoRoot) === null) {
    return [];
  }

  let tracked = [];
  // A repo with zero commits has no resolvable diff base at all (the session
  // baseline records NO_GIT, and `git diff HEAD` fails with "ambiguous
  // argument"). Every file is new by definition, so report untracked only
  // instead of throwing INFRA_NOT_READY at the user — verification still runs
  // unless the untracked set is entirely skip-globbed.
  if (hasCommits(repoRoot)) {
    try {
      const out = git(['diff', '--name-only', diffBase, '--', '.'], repoRoot);
      tracked = out ? out.split('\n').filter(Boolean) : [];
    } catch (err) {
      throw new Error(`[eghs] git diff --name-only ${diffBase} failed: ${err.message}`);
    }
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
  // picomatch throws on empty/non-string patterns; a bad config entry must
  // degrade to "run verification" (fail-safe), not crash the Stop hook —
  // a crash exits 1, which Claude Code treats as non-blocking (fail-open).
  const globs = skipGlobs.filter((g) => typeof g === 'string' && g.length > 0);
  if (changedFiles.length === 0 || globs.length === 0) return false;
  const isMatch = picomatch(globs, { dot: true });
  return changedFiles.every((f) => isMatch(f));
}

module.exports = { getRepoRoot, getHeadCommit, getChangedFiles, shouldSkipVerification };
