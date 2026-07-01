'use strict';
const fs = require('fs');
const path = require('path');
const { writeTmpFile, fsyncDir } = require('./tmp-file');

// destination-local temp + fsync(fd) + rename(2) + fsync(dirfd) — PRD §R2.5
function atomicWriteFile(destPath, contents) {
  const tmpPath = writeTmpFile(destPath, contents);

  try {
    fs.renameSync(tmpPath, destPath);
  } catch (err) {
    if (err.code === 'EISDIR') {
      // destPath exists as the wrong type (e.g. a corrupted schema_version
      // that got replaced by a stray directory). Clearing it lets this
      // self-heal instead of crashing the exact `eghs-init --repair` path
      // that's meant to recover from an INVALID schema_version.
      fs.rmSync(destPath, { recursive: true, force: true });
      fs.renameSync(tmpPath, destPath);
    } else {
      throw err;
    }
  }

  fsyncDir(path.dirname(destPath));
}

module.exports = { atomicWriteFile };
