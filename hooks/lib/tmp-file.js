'use strict';
const fs = require('fs');
const path = require('path');

let seqCounter = 0;
function nextSeq() {
  seqCounter += 1;
  return seqCounter;
}

// Write `contents` to a fresh, fsynced temp file under `<destDir>/tmp/` and
// return its path. Shared by atomic-write.js (rename) and exclusive-link.js
// (link) so both draw temp names from one monotonic counter — PRD §R2.5.
function writeTmpFile(destPath, contents) {
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
  return tmpPath;
}

function fsyncDir(dirPath) {
  const dirFd = fs.openSync(dirPath, 'r');
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
}

module.exports = { writeTmpFile, fsyncDir };
