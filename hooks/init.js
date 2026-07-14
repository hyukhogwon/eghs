#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { resolveStateDir, STATE_SUBDIRS } = require('./lib/state-dir');
const { readSchemaVersion, HOOK_SCHEMA_VERSION } = require('./lib/schema');
const { readFsInfo, probeAndWriteFsInfo, FlockUnsupportedError } = require('./lib/fs-info');
const { atomicWriteFile } = require('./lib/atomic-write');
const { getRepoRoot } = require('./lib/git');
const { acquireExWithTimeout, flockUn } = require('./lib/flock');
const { isAlive } = require('./lib/proc');

// eghs-init bootstrap per PRD §R2.5 steps 0-8 (R16-R20 amendments):
// admin-mutex → migrate.lock (shared init/migrate mutex) → role validation →
// .init.lock (inner-step protection) → subdirs → fs-info probe →
// schema_version LAST (its presence is the single "all infra ready" signal).

const MIGRATE_LOCK_GRACE_MS = 600000; // hook precedence #4 same-uid dead grace
const INIT_LOCK_GRACE_MS = 60000; // stale-dead .init.lock recovery grace (NOT a clock-skew tolerance)
const FAR_FUTURE_GRACE_MS = 86400000; // start_ms sanity ceiling (clock skew / VM resume pass; corruption fails)
// Env override exists for tests only — a held mutex is a 30s stall otherwise.
const ADMIN_MUTEX_TIMEOUT_MS = Number(process.env.EGHS_ADMIN_MUTEX_TIMEOUT_MS) || 30000;

class InitAbort extends Error {}

function abort(msg) {
  throw new InitAbort(`[eghs-init] ${msg}`);
}

// PRD §357: field-level sanity. A body that parses but fails these is
// corrupt (silent-deadlock prevention), remediation --clear-init-lock.
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

// Step 0 (PRD §345): the admin mutex serializes every admin op
// (eghs-init / eghs-migrate / --clear-*) — only inside it may
// migrate.lock/.init.lock be created, inspected, or unlinked.
function acquireAdminMutex(stateDir) {
  fs.mkdirSync(path.join(stateDir, 'locks'), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(
    path.join(stateDir, 'locks', 'admin-mutex.guard'),
    fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_CLOEXEC, // no truncate: another holder's flock is on this inode
    0o600
  );
  if (!acquireExWithTimeout(fd, ADMIN_MUTEX_TIMEOUT_MS).ok) {
    fs.closeSync(fd);
    abort('admin-mutex.guard held by another admin operation; retry later');
  }
  return () => {
    try {
      flockUn(fd);
    } finally {
      fs.closeSync(fd);
    }
  };
}

// Steps 1-2 (PRD §346-347): reclaim a same-uid dead+grace-elapsed
// migrate.lock, then take it exclusively with role "init".
function acquireMigrateLock(stateDir, nowMs) {
  const lockPath = path.join(stateDir, 'migrate.lock');
  let st = null;
  try {
    st = fs.lstatSync(lockPath);
  } catch (err) {
    if (err.code !== 'ENOENT') abort(`cannot stat migrate.lock: ${err.message}`);
  }
  if (st !== null) {
    if (!st.isFile()) {
      abort('migrate.lock is not a regular file; run `eghs-migrate --clear-migrate-lock`');
    }
    let body;
    try {
      body = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    } catch {
      abort('migrate.lock body corrupt; run `eghs-migrate --clear-migrate-lock`');
    }
    if (!lockBodySane(body, nowMs)) {
      abort('migrate.lock body corrupt; run `eghs-migrate --clear-migrate-lock`');
    }
    if (body.uid !== process.getuid()) {
      abort(`migrate.lock owned by uid ${body.uid}; aborting (foreign lock)`);
    }
    if (isAlive(body.pid)) {
      abort(`migrate.lock held by live pid=${body.pid}; aborting`);
    }
    if (nowMs - body.start_ms < MIGRATE_LOCK_GRACE_MS) {
      abort('migrate.lock dead but within its grace window; retry later');
    }
    try {
      fs.unlinkSync(lockPath); // stale: same uid + dead + grace elapsed
    } catch (err) {
      abort(`cannot reclaim stale migrate.lock: ${err.message}`);
    }
  }

  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx', 0o600);
  } catch (err) {
    abort(`cannot acquire migrate.lock: ${err.code === 'EEXIST' ? 'raced by another admin op' : err.message}`);
  }
  fs.writeSync(fd, JSON.stringify({ pid: process.pid, uid: process.getuid(), start_ms: nowMs, role: 'init' }));
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  return () => {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // already gone -> fine
    }
  };
}

// Step 4 (PRD §355-363): .init.lock with a JSON body and full stale rules.
function acquireInitLock(stateDir, nowMs, attemptsLeft = 2) {
  if (attemptsLeft <= 0) abort('could not acquire .init.lock after stale reclaim; retry later');
  const lockPath = path.join(stateDir, '.init.lock');
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx', 0o600);
  } catch (err) {
    if (err.code !== 'EEXIST') abort(`cannot create .init.lock: ${err.message}`);
    let body;
    try {
      body = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    } catch {
      abort('.init.lock body parse fail; run `eghs-migrate --clear-init-lock`');
    }
    if (!lockBodySane(body, nowMs)) {
      abort('.init.lock body corrupt; run `eghs-migrate --clear-init-lock`');
    }
    if (body.uid !== process.getuid()) abort('.init.lock foreign; aborting');
    if (isAlive(body.pid)) abort(`.init.lock held by pid=${body.pid}; aborting`);
    if (nowMs - body.start_ms < INIT_LOCK_GRACE_MS) {
      abort('.init.lock dead but within its 60s grace; retry shortly');
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // raced: the retry below re-evaluates from scratch
    }
    return acquireInitLock(stateDir, nowMs, attemptsLeft - 1);
  }
  fs.writeSync(fd, JSON.stringify({ pid: process.pid, uid: process.getuid(), start_ms: nowMs }));
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  return () => {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // already gone -> fine
    }
  };
}

// Step 3 (PRD §348-354 + §295-300): decide which of steps 5/6/7 run.
// Returns {mkSubdirs, ensureFsInfo, writeSchema} or exits for Case 5.
function validateRole(stateDir, repair) {
  const schema = readSchemaVersion(stateDir);
  if (!repair) {
    if (schema.status !== 'not_initialized') {
      abort('schema_version already exists; use eghs-init --repair or eghs-migrate');
    }
    return { mkSubdirs: true, ensureFsInfo: true, writeSchema: true };
  }

  if (schema.status === 'not_initialized') {
    abort('--repair requires an existing schema_version; run eghs-init first');
  }
  const subdirsMissing = STATE_SUBDIRS.some((sub) => {
    try {
      return !fs.statSync(path.join(stateDir, sub)).isDirectory();
    } catch {
      return true;
    }
  });
  const fsInfo = readFsInfo(stateDir);

  if (schema.status === 'invalid') {
    return { mkSubdirs: true, ensureFsInfo: true, writeSchema: true }; // Case 1
  }
  if (subdirsMissing) {
    return { mkSubdirs: true, ensureFsInfo: true, writeSchema: false }; // Case 2 (6 conditional = ensure)
  }
  if (fsInfo.status !== 'ok') {
    return { mkSubdirs: false, ensureFsInfo: true, writeSchema: false }; // Cases 3/4
  }
  return null; // Case 5: no-op, idempotent success
}

function main(argv) {
  const repair = argv.includes('--repair');
  const repoRoot = getRepoRoot(process.cwd()) || process.cwd();
  const stateDir = resolveStateDir(repoRoot);
  const nowMs = Date.now();
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });

  const releaseMutex = acquireAdminMutex(stateDir);
  try {
    const releaseMigrateLock = acquireMigrateLock(stateDir, nowMs);
    try {
      const plan = validateRole(stateDir, repair);
      if (plan === null) {
        process.stdout.write(`[eghs-init] already healthy at ${stateDir} (no-op)\n`);
        return;
      }

      const releaseInitLock = acquireInitLock(stateDir, nowMs);
      try {
        if (plan.mkSubdirs) {
          for (const sub of STATE_SUBDIRS) {
            fs.mkdirSync(path.join(stateDir, sub), { recursive: true, mode: 0o700 });
          }
        }

        // Step 6: ensure a healthy fs-info.json (unhealthy predicate is
        // shared with hook precedence #3.3 — legacy v1 cache, corruption and
        // FS moves all unlink + re-probe here).
        if (plan.ensureFsInfo && readFsInfo(stateDir).status !== 'ok') {
          fs.rmSync(path.join(stateDir, 'fs-info.json'), { force: true });
          try {
            probeAndWriteFsInfo(stateDir, Date.now());
          } catch (err) {
            if (err instanceof FlockUnsupportedError) abort(err.message); // step 6c fail-closed
            throw err;
          }
        }

        // Step 7: schema_version strictly last — its presence signals that
        // every piece of infra above is ready.
        if (plan.writeSchema) {
          atomicWriteFile(path.join(stateDir, 'schema_version'), `${HOOK_SCHEMA_VERSION}\n`);
        }

        process.stdout.write(`[eghs-init] ready at ${stateDir}\n`);
      } finally {
        releaseInitLock();
      }
    } finally {
      releaseMigrateLock();
    }
  } finally {
    releaseMutex();
  }
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof InitAbort) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

module.exports = { main, InitAbort };
