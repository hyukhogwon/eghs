'use strict';

// Shared by lock.js/session.js/baseline.js reclaim logic. EPERM (and any
// non-ESRCH error) is treated as alive — fail-closed: we'd rather refuse a
// reclaim than clobber a process we can't prove is dead.
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

module.exports = { isAlive };
