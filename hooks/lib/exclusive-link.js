'use strict';
const fs = require('fs');
const path = require('path');
const { writeTmpFile, fsyncDir } = require('./tmp-file');

// write tmp + fsync, then link(2) to dest (EEXIST = someone else holds it).
// Never uses rename() — rename would silently overwrite and defeat the
// exclusivity guarantee. PRD §R2.5 / §R6 6.3a.
function exclusiveLinkCreate(destPath, contents) {
  const tmpPath = writeTmpFile(destPath, contents);

  try {
    fs.linkSync(tmpPath, destPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup — must not mask the original linkSync error.
    }
    if (err.code === 'EEXIST') {
      return { ok: false, code: 'EEXIST' };
    }
    throw err;
  }

  // link succeeded: dest now exists. tmp cleanup and the dir fsync are
  // best-effort durability steps from here — their failure must never turn
  // an already-successful create into a reported failure.
  try {
    fs.unlinkSync(tmpPath);
  } catch {
    // already gone (e.g. concurrent GC) is fine.
  }
  try {
    fsyncDir(path.dirname(destPath));
  } catch {
    // best-effort.
  }
  return { ok: true };
}

module.exports = { exclusiveLinkCreate };
