'use strict';
const fs = require('fs');
const path = require('path');

function checkKillSwitch({ repoRoot, env }) {
  if (env.EGHS_DISABLED === '1') {
    return { active: true, reason: 'env' };
  }

  const offPath = path.join(repoRoot, '.claude', 'eghs-off');
  try {
    const stat = fs.statSync(offPath); // follows symlinks
    if (stat.isFile()) {
      return { active: true, reason: 'file' };
    }
  } catch {
    // ENOENT or broken symlink -> not active
  }

  return { active: false, reason: null };
}

module.exports = { checkKillSwitch };
