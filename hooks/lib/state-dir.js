'use strict';
const path = require('path');

const STATE_DIRNAME = path.join('.claude', 'state', 'eghs');

function resolveStateDir(repoRoot) {
  return path.join(repoRoot, STATE_DIRNAME);
}

// Subdirs Stop hook needs in P1. reads/, failed/, pre/ are P3 scope.
const P1_SUBDIRS = [
  'tmp',
  'locks', path.join('locks', 'tmp'),
  'sessions', path.join('sessions', 'tmp'),
  'baselines', path.join('baselines', 'tmp'),
  'verify-logs',
  'debug',
];

module.exports = { STATE_DIRNAME, resolveStateDir, P1_SUBDIRS };
