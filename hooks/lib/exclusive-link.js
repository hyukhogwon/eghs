'use strict';
const fs = require('fs');
const path = require('path');

let seqCounter = 0;
function nextSeq() {
  seqCounter += 1;
  return seqCounter;
}

// write tmp + fsync, then link(2) to dest (EEXIST = someone else holds it),
// then unlink the tmp source. Never uses rename() — rename would silently
// overwrite and defeat the exclusivity guarantee. PRD §R2.5 / §R6 6.3a.
function exclusiveLinkCreate(destPath, contents) {
  const destDir = path.dirname(destPath);
  const tmpDir = path.join(destDir, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  const tmpPath = path.join(
    tmpDir,
    `${path.basename(destPath)}.${process.pid}.${nextSeq()}`
  );

  const fd = fs.openSync(tmpPath, 'w', 0o600);
  try {
    fs.writeSync(fd, contents);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  try {
    fs.linkSync(tmpPath, destPath);
  } catch (err) {
    fs.unlinkSync(tmpPath);
    if (err.code === 'EEXIST') {
      return { ok: false, code: 'EEXIST' };
    }
    throw err;
  }

  fs.unlinkSync(tmpPath);
  const dirFd = fs.openSync(destDir, 'r');
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
  return { ok: true };
}

module.exports = { exclusiveLinkCreate };
