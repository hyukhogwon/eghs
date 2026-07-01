'use strict';
const fs = require('fs');
const path = require('path');

let seqCounter = 0;
function nextSeq() {
  seqCounter += 1;
  return seqCounter;
}

// destination-local temp + fsync(fd) + rename(2) + fsync(dirfd) — PRD §R2.5
function atomicWriteFile(destPath, contents) {
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

  fs.renameSync(tmpPath, destPath);

  const dirFd = fs.openSync(destDir, 'r');
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
}

module.exports = { atomicWriteFile };
