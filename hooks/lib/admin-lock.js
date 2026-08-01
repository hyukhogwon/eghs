'use strict';
const fs = require('fs');
const path = require('path');
const { acquireExWithTimeout, flockUn } = require('./flock');

// Primitives shared by the admin CLIs (eghs-init, eghs-migrate) — PRD §R2.5
// §340/§345/§388. The admin mutex serializes every admin op; only while
// holding it may migrate.lock / .init.lock be created, inspected or unlinked.

const FAR_FUTURE_GRACE_MS = 86400000; // start_ms sanity ceiling (clock skew / VM resume pass; corruption fails)
// Env override exists for tests only — a held mutex is a 30s stall otherwise.
const ADMIN_MUTEX_TIMEOUT_MS = Number(process.env.EGHS_ADMIN_MUTEX_TIMEOUT_MS) || 30000;

// PRD §357: field-level sanity. A body that parses but fails these is
// corrupt (silent-deadlock prevention), remediation --clear-init-lock /
// --clear-migrate-lock.
function lockBodySane(body, nowMs) {
  return (
    body !== null &&
    typeof body === 'object' &&
    typeof body.pid === 'number' &&
    Number.isInteger(body.pid) &&
    body.pid >= 0 &&
    body.pid <= Number.MAX_SAFE_INTEGER &&
    typeof body.uid === 'number' &&
    Number.isInteger(body.uid) &&
    typeof body.start_ms === 'number' &&
    Number.isInteger(body.start_ms) &&
    body.start_ms >= 0 &&
    body.start_ms <= Number.MAX_SAFE_INTEGER &&
    body.start_ms <= nowMs + FAR_FUTURE_GRACE_MS
  );
}

// `create` is init-only (PRD §345 bootstrap-safe step 0): eghs-migrate never
// bootstraps locks/ — its absence means "run eghs-init" (PRD §388).
// Returns {ok:true, release} | {ok:false, reason}; the caller words the abort.
function acquireAdminMutex(stateDir, { create = false } = {}) {
  const locksDir = path.join(stateDir, 'locks');
  if (create) fs.mkdirSync(locksDir, { recursive: true, mode: 0o700 });
  let fd;
  try {
    fd = fs.openSync(
      path.join(locksDir, 'admin-mutex.guard'),
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_CLOEXEC, // no truncate: another holder's flock is on this inode
      0o600
    );
  } catch (err) {
    return { ok: false, reason: `cannot open locks/admin-mutex.guard: ${err.message}` };
  }
  if (!acquireExWithTimeout(fd, ADMIN_MUTEX_TIMEOUT_MS).ok) {
    fs.closeSync(fd);
    return { ok: false, reason: 'admin-mutex.guard held by another admin operation; retry later' };
  }
  return {
    ok: true,
    release: () => {
      try {
        flockUn(fd);
      } finally {
        fs.closeSync(fd);
      }
    },
  };
}

module.exports = { FAR_FUTURE_GRACE_MS, ADMIN_MUTEX_TIMEOUT_MS, lockBodySane, acquireAdminMutex };
