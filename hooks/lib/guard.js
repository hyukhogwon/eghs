'use strict';
const fs = require('fs');
const path = require('path');
const { flockShNb } = require('./flock');

// PRD §R6 #3.7: sid tombstone check + shared guard acquire. The kernel
// rwlock (flock) replaces stat-then-recheck — every sid-scoped state-dir
// mutation happens under this shared hold, so `--clear-sid`'s exclusive
// acquisition is a true barrier. The fd stays open for the hook's lifetime;
// process exit releases the lock automatically.
//
// Returns one of:
//   {outcome:'ok', guardFd}
//   {outcome:'sid_cleared'}        — tombstone present, or clear-sid holds EX
//   {outcome:'infra', detail}      — sessions/ absent or unopenable
function acquireSidGuard(stateDir, sid) {
  const sessions = path.join(stateDir, 'sessions');
  const tombstonePath = path.join(sessions, `${sid}.tombstone`);

  // Step 1: mutation-free short-circuit — a tombstone means the sid is being
  // (or has been) cleared; don't even create the guard.
  if (fs.existsSync(tombstonePath)) return { outcome: 'sid_cleared' };

  // Step 2: open-or-create the guard. ENOENT = sessions/ itself missing
  // (schema exists but subdirs were hand-deleted) → infra, repair needed.
  let fd;
  try {
    fd = fs.openSync(
      path.join(sessions, `${sid}.guard.lock`),
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_CLOEXEC,
      0o600
    );
  } catch (err) {
    return { outcome: 'infra', detail: `guard.lock open failed: ${err.code}` };
  }

  try {
    // Step 3: LOCK_SH non-blocking. EWOULDBLOCK = --clear-sid holds (or
    // awaits) exclusive — treat as cleared.
    if (!flockShNb(fd).ok) {
      fs.closeSync(fd);
      return { outcome: 'sid_cleared' };
    }
    // Step 4: re-stat the tombstone — it may have been created between
    // step 1 and the flock. The shared hold now blocks any NEW exclusive,
    // so this check is race-free going forward.
    if (fs.existsSync(tombstonePath)) {
      fs.closeSync(fd); // close releases the flock
      return { outcome: 'sid_cleared' };
    }
    return { outcome: 'ok', guardFd: fd };
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {
      // already closed
    }
    return { outcome: 'infra', detail: `guard flock failed: ${err.code || err.message}` };
  }
}

module.exports = { acquireSidGuard };
