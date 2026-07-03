'use strict';
const path = require('path');
const { resolveStateDir } = require('./state-dir');
const { readSchemaVersion } = require('./schema');
const { checkKillSwitch } = require('./kill-switch');
const { isCI } = require('./ci');
const { getRepoRoot } = require('./git');
const { readFsInfo } = require('./fs-info');
const { isValidSid } = require('./sid');
const { canonicalKey } = require('./canonical');

// Shared guard prologue for the record-only tool hooks (PreToolUse and
// PostToolUse). Returns {skip: <reason>} when the hook must do nothing, or
// the resolved context. Ordering per PRD §R6: kill switch, then CI
// passthrough (non-Stop hooks only), then session/schema/fs-info — and no
// state mutation before every guard has passed.
function resolveToolHookContext(input, { env, cwd, hookName }) {
  const repoRoot = getRepoRoot(cwd) || cwd;
  if (checkKillSwitch({ repoRoot, env }).active) return { skip: 'kill_switch' };
  if (isCI(env)) return { skip: 'ci' };

  const sid = input.session_id;
  if (!isValidSid(sid)) {
    // NO_SESSION signal: fail-open by design, but keep it observable so a
    // host-side session_id format change can't silently disable recording.
    process.stderr.write(`[eghs] ${hookName} NO_SESSION: missing/invalid session_id — recording skipped\n`);
    return { skip: 'no_session' };
  }

  const stateDir = resolveStateDir(repoRoot);
  if (readSchemaVersion(stateDir).status !== 'ok') return { skip: 'schema' }; // uninitialized: UPS nudges, we skip

  const fsInfo = readFsInfo(stateDir);
  if (fsInfo.status !== 'ok') {
    // FS_INFO_MISSING denies only when the gate is on (P4). Record-only skips.
    process.stderr.write(`[eghs] ${hookName}: fs-info ${fsInfo.status} — run \`node hooks/init.js --repair\`; recording skipped\n`);
    return { skip: 'fs_info' };
  }

  return { repoRoot, sid, stateDir, caseless: fsInfo.caseless };
}

// Out-of-repo canonical keys are out of EGHS scope (PRD §R3): skip, not deny.
// The trailing separator blocks sibling-prefix collisions (/repo2 vs /repo).
function isOutsideRepo(key, repoRoot, caseless) {
  const repoKey = canonicalKey(repoRoot, { caseless });
  return !repoKey.ok || !(key + path.sep).startsWith(repoKey.key + path.sep);
}

module.exports = { resolveToolHookContext, isOutsideRepo };
