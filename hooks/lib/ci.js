'use strict';

// CI passthrough (PRD §6). UserPromptSubmit honors these (unlike the Stop hook,
// which enforces verification even in CI). CI accepts "true" or "1"; the vendor
// flags are only ever the string "true".
function isCI(env) {
  return (
    env.CI === 'true' ||
    env.CI === '1' ||
    env.GITHUB_ACTIONS === 'true' ||
    env.GITLAB_CI === 'true' ||
    env.BUILDKITE === 'true'
  );
}

module.exports = { isCI };
