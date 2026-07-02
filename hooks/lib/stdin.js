'use strict';
const fs = require('fs');

// Synchronous whole-of-stdin drain shared by every hook entrypoint (hooks are
// stdin-JSON driven, PRD MVP #7).
//
// EAGAIN means stdin is a non-blocking pipe with no data yet (some hosts
// spawn hooks that way); retrying immediately would spin a CPU core until the
// writer catches up, so block this thread ~5ms per miss instead. Atomics.wait
// is the only sync sleep available without a child process.
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readStdin() {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  while (true) {
    let bytesRead;
    try {
      bytesRead = fs.readSync(0, buf, 0, buf.length, null);
    } catch (err) {
      if (err.code === 'EAGAIN') {
        sleepMs(5);
        continue;
      }
      if (err.code === 'EOF') break;
      throw err;
    }
    if (bytesRead === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

module.exports = { readStdin };
