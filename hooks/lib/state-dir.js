'use strict';
const path = require('path');

const STATE_DIRNAME = path.join('.claude', 'state', 'eghs');

function resolveStateDir(repoRoot) {
  return path.join(repoRoot, STATE_DIRNAME);
}

// Subdirs Stop hook needs in P1. reads/, failed/, pre/ are P3 scope.
const DIRS_WITH_TMP = ['locks', 'sessions', 'baselines'];
const P1_SUBDIRS = [
  'tmp',
  ...DIRS_WITH_TMP.flatMap((d) => [d, path.join(d, 'tmp')]),
  'verify-logs',
  'debug',
];

module.exports = { STATE_DIRNAME, resolveStateDir, P1_SUBDIRS };
