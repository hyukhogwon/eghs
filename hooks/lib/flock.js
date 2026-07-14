'use strict';
const { flockSync } = require('fs-ext');
const { sleepMs } = require('./stdin');

// flock(2) wrapper (PRD §R6 #3.7 guard rwlock, §R2.5 admin-mutex). fs-ext is
// the only flock access Node has — core never exposed it. Kernel semantics we
// rely on: shared/exclusive contention across processes, auto-release on
// process death, ~1μs non-blocking fast path.
//
// EAGAIN is the EWOULDBLOCK alias on macOS and Linux; both spellings are
// normalized to {ok:false, wouldBlock:true}. Every other errno throws —
// callers must treat that as an infra fault, never as contention.

function tryFlock(fd, mode) {
  try {
    flockSync(fd, mode);
    return { ok: true, wouldBlock: false };
  } catch (err) {
    if (err.code === 'EAGAIN' || err.code === 'EWOULDBLOCK') {
      return { ok: false, wouldBlock: true };
    }
    throw err;
  }
}

function flockShNb(fd) {
  return tryFlock(fd, 'shnb');
}

function flockExNb(fd) {
  return tryFlock(fd, 'exnb');
}

function flockUn(fd) {
  flockSync(fd, 'un');
}

// Exclusive acquire with a deadline, as an exnb poll loop: flockSync's
// blocking mode has no timeout, and polling keeps CLI paths interruptible
// (plan decision 1). Used by admin-mutex (30s) and --clear-sid drain (90s).
function acquireExWithTimeout(fd, timeoutMs, pollMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (flockExNb(fd).ok) return { ok: true };
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ok: false };
    sleepMs(Math.min(pollMs, remaining));
  }
}

module.exports = { flockShNb, flockExNb, flockUn, acquireExWithTimeout };
