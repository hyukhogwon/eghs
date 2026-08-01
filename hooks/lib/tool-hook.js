'use strict';
const path = require('path');
const { canonicalKey } = require('./canonical');

// P3 shipped a `resolveToolHookContext` prologue here; P4 units 9-10 replaced
// it with `lib/precedence.js` `runPrecedence`, which every entrypoint now
// calls. It was removed rather than left behind: its NO_SESSION row was
// fail-OPEN (record-only skip), which P4 inverted to fail-closed for
// PreToolUse — a future reader reaching for it would get the old contract.

// Out-of-repo canonical keys are out of EGHS scope (PRD §R3): skip, not deny.
// The trailing separator blocks sibling-prefix collisions (/repo2 vs /repo).
function isOutsideRepo(key, repoRoot, caseless) {
  const repoKey = canonicalKey(repoRoot, { caseless });
  return !repoKey.ok || !(key + path.sep).startsWith(repoKey.key + path.sep);
}

module.exports = { isOutsideRepo };
