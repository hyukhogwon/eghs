'use strict';
const path = require('path');

const STATE_DIRNAME = path.join('.claude', 'state', 'eghs');

function resolveStateDir(repoRoot) {
  return path.join(repoRoot, STATE_DIRNAME);
}

// Root-level subdirs eghs-init pre-creates (PRD §R2.5). Only sid-scoped
// paths (pre/<sid>/, failed/<sid>/) are created lazily by hooks at first
// write — a missing root-level dir means "not initialized", never mkdir.
const DIRS_WITH_TMP = ['locks', 'sessions', 'baselines', 'reads', 'failed'];
const STATE_SUBDIRS = [
  'tmp',
  ...DIRS_WITH_TMP.flatMap((d) => [d, path.join(d, 'tmp')]),
  'pre',
  'verify-logs',
  'debug',
];

module.exports = { STATE_DIRNAME, resolveStateDir, STATE_SUBDIRS };
