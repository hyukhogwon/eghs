#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { resolveStateDir } = require('./lib/state-dir');
const { readSchemaVersion, HOOK_SCHEMA_VERSION } = require('./lib/schema');
const { atomicWriteFile } = require('./lib/atomic-write');
const { getRepoRoot } = require('./lib/git');
const { isAlive } = require('./lib/proc');
const { lockBodySane, acquireAdminMutex } = require('./lib/admin-lock');
const { selectStaleSids, gcSessions } = require('./lib/session');
const { loadConfig } = require('./lib/config');

// eghs-migrate per PRD §R2.5 steps 0-8: admin-mutex → migrate.lock → role
// validation → sessions GC (+ orphan stop-lock sweep) → empty-state
// precondition → per-record wipe → atomic schema_version rewrite → release.
//
// It never bootstraps: a missing state dir belongs to eghs-init. `--dry-run`
// traces the whole plan and performs no write at all (not even the locks).

const MIGRATE_LOCK_GRACE_MS = 600000; // same-uid dead-lock reclaim grace (hook precedence #4)
const FOREIGN_MIGRATE_LOCK_GRACE_MS = 7200000; // 2h before a foreign lock reads as stale

class MigrateAbort extends Error {}

function abort(msg) {
  throw new MigrateAbort(msg);
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Step 1 (PRD §389): reclaim a stale migrate.lock, refuse a live one. A
// foreign-uid lock needs --force-foreign-cleanup and a 2h grace; without that
// escape hatch the hook's #4 foreign-stale guidance would dead-end.
function reclaimMigrateLock(stateDir, { nowMs, force, dryRun, trace }) {
  const lockPath = path.join(stateDir, 'migrate.lock');
  let st = null;
  try {
    st = fs.lstatSync(lockPath);
  } catch (err) {
    if (err.code !== 'ENOENT') abort(`cannot stat migrate.lock: ${err.message}`);
  }
  if (st === null) return;

  if (!st.isFile()) abort('migrate.lock is not a regular file; use --clear-migrate-lock');
  let body = null;
  try {
    body = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    abort('migrate.lock body corrupt; use --clear-migrate-lock');
  }
  if (!lockBodySane(body, nowMs)) abort('migrate.lock body corrupt; use --clear-migrate-lock');

  const foreign = body.uid !== process.getuid();
  if (foreign && !force) {
    abort(`migrate.lock owned by uid ${body.uid}; use --force-foreign-cleanup to reclaim a stale foreign lock`);
  }
  if (isAlive(body.pid)) abort(`migrate.lock held by live pid=${body.pid}; aborting`);
  const graceMs = foreign ? FOREIGN_MIGRATE_LOCK_GRACE_MS : MIGRATE_LOCK_GRACE_MS;
  if (nowMs - body.start_ms < graceMs) abort('migrate.lock dead but within its grace window; retry later');

  if (dryRun) {
    trace(`would reclaim stale migrate.lock (pid=${body.pid}${foreign ? ', foreign uid' : ''})`);
    return;
  }
  try {
    fs.unlinkSync(lockPath);
  } catch (err) {
    abort(`cannot reclaim stale migrate.lock: ${err.message}`);
  }
}

// Step 2 (PRD §390).
function createMigrateLock(stateDir, nowMs) {
  const lockPath = path.join(stateDir, 'migrate.lock');
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx', 0o600);
  } catch (err) {
    abort(`cannot acquire migrate.lock: ${err.code === 'EEXIST' ? 'raced by another admin op' : err.message}`);
  }
  fs.writeSync(fd, JSON.stringify({ pid: process.pid, uid: process.getuid(), start_ms: nowMs, role: 'migrate' }));
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

function stopLockSid(name) {
  if (!name.startsWith('stop-')) return null;
  if (name.endsWith('.recover.lock')) return name.slice('stop-'.length, -'.recover.lock'.length);
  if (name.endsWith('.lock')) return name.slice('stop-'.length, -'.lock'.length);
  return null;
}

// Step 4 extra (PRD §393-395): TTL-independent orphan stop-lock sweep. Without
// it a crashed short-lived session's stop-lock survives until the 24h session
// TTL and fails the step 5 precondition. A lock whose lease is still alive is
// never touched (that would gut a live Stop hook).
function selectOrphanStopLocks(stateDir) {
  const locksDir = path.join(stateDir, 'locks');
  let names = [];
  try {
    names = fs.readdirSync(locksDir);
  } catch {
    return [];
  }
  const orphans = [];
  for (const name of names) {
    const sid = stopLockSid(name);
    if (sid === null) continue;
    let raw = null;
    try {
      raw = fs.readFileSync(path.join(stateDir, 'sessions', `${sid}.json`), 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') continue; // unreadable lease: liveness undecidable, hands off
    }
    if (raw !== null) {
      // A lease that exists but cannot be judged dead keeps its lock: step 5
      // will refuse the migrate anyway, so guessing buys nothing.
      let lease;
      try {
        lease = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!lease || typeof lease.pid !== 'number' || isAlive(lease.pid)) continue;
    }
    orphans.push(name);
  }
  return orphans;
}

// Step 5 (PRD §396 + §264): sessions/ must be empty and locks/ must hold
// nothing beyond admin-mutex.guard and its tmp/ dir. `ignore*` carry what a
// dry-run would have deleted in step 4 but has not.
function checkPreconditions(stateDir, { ignoreSids = new Set(), ignoreLocks = new Set() } = {}) {
  const sessionsDir = path.join(stateDir, 'sessions');
  let sessionEntries = [];
  try {
    sessionEntries = fs.readdirSync(sessionsDir).filter((n) => n !== 'tmp');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  // sid-scoped names are `<uuid>.json|.guard.lock|.tombstone`; a uuid has no dot.
  const active = sessionEntries.filter((n) => !ignoreSids.has(n.split('.')[0]));
  if (active.length > 0) {
    abort(
      `active session state remains (${active.length}): ${active.join(', ')}; ` +
        'wait for those sessions to end, or clear a broken one with `eghs-migrate --clear-sid <SID>`'
    );
  }

  let lockEntries = [];
  try {
    lockEntries = fs.readdirSync(path.join(stateDir, 'locks'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const leftovers = lockEntries.filter(
    (n) => n !== 'tmp' && n !== 'admin-mutex.guard' && !ignoreLocks.has(n)
  );
  if (leftovers.length > 0) {
    abort(`locks/ not clean: ${leftovers.join(', ')}; inspect them before migrating`);
  }
}

function listRecords(stateDir, sub) {
  try {
    return fs
      .readdirSync(path.join(stateDir, sub))
      .filter((n) => n.endsWith('.json'))
      .map((n) => path.join(stateDir, sub, n));
  } catch {
    return [];
  }
}

// Steps 6-7 (PRD §397-403): a schema change invalidates every cross-session
// evidence record (G1 over convenience — a Read regenerates them), then the
// version file is rewritten atomically. fs-info.json is schema-agnostic and
// deliberately kept.
function migrateRecords(stateDir, { dryRun, trace }) {
  const records = [...listRecords(stateDir, 'reads'), ...listRecords(stateDir, 'failed')];
  if (dryRun) {
    trace(`would unlink ${records.length} evidence record(s) under reads/ and failed/`);
    trace(`would write schema_version=${HOOK_SCHEMA_VERSION}`);
    return;
  }
  for (const p of records) {
    try {
      fs.unlinkSync(p);
    } catch {
      // best-effort: a record that vanished mid-pass is already gone
    }
  }
  atomicWriteFile(path.join(stateDir, 'schema_version'), `${HOOK_SCHEMA_VERSION}\n`);
}

function runMigrate({ force, dryRun }, { cwd = process.cwd(), nowMs = Date.now() } = {}) {
  const repoRoot = getRepoRoot(cwd) || cwd;
  const stateDir = resolveStateDir(repoRoot);
  const trace = dryRun ? (m) => process.stdout.write(`[eghs-migrate] dry-run: ${m}\n`) : () => {};
  const say = (m) => process.stdout.write(`[eghs-migrate] ${m}\n`);

  // Step 0: no bootstrap — a missing locks/ means the state dir was never
  // initialized (PRD §388).
  if (!isDirectory(path.join(stateDir, 'locks'))) {
    abort(`state dir not initialized at ${stateDir}; run eghs-init`);
  }
  // A dry-run takes no lock at all: the mutex would create/flock a file, and
  // the point of the trace is a zero-write preview.
  let releaseMutex = () => {};
  if (dryRun) {
    trace('would acquire locks/admin-mutex.guard');
  } else {
    const mutex = acquireAdminMutex(stateDir);
    if (!mutex.ok) abort(mutex.reason);
    releaseMutex = mutex.release;
  }

  try {
    reclaimMigrateLock(stateDir, { nowMs, force, dryRun, trace });
    let releaseLock = () => {};
    if (dryRun) trace('would create migrate.lock (role=migrate)');
    else releaseLock = createMigrateLock(stateDir, nowMs);

    try {
      // Step 3: role validation.
      const schema = readSchemaVersion(stateDir);
      if (schema.status === 'not_initialized') abort('schema_version absent; use eghs-init to bootstrap');
      if (schema.status === 'invalid') abort('schema_version INVALID; run `eghs-init --repair` first');
      if (schema.version === HOOK_SCHEMA_VERSION) {
        say(`already at schema_version ${HOOK_SCHEMA_VERSION} (no-op)`);
        return;
      }
      trace(`schema_version ${schema.version} on disk, hook expects ${HOOK_SCHEMA_VERSION}`);

      // Step 4: sessions GC (+ cascade) and the orphan stop-lock sweep.
      const config = loadConfig(repoRoot);
      const gcOpts = {
        nowMs,
        uid: process.getuid(),
        sessionStaleSeconds: config.session_stale_seconds,
        foreignStaleSeconds: force ? config.session_stale_seconds * 2 : null,
      };
      const staleSids = selectStaleSids(stateDir, gcOpts).map((s) => s.sid);
      const orphanLocks = selectOrphanStopLocks(stateDir);
      if (dryRun) {
        trace(`would cascade-delete ${staleSids.length} stale lease(s): ${staleSids.join(', ') || 'none'}`);
        trace(`would unlink ${orphanLocks.length} orphan stop-lock(s): ${orphanLocks.join(', ') || 'none'}`);
      } else {
        gcSessions(stateDir, gcOpts);
        for (const name of orphanLocks) {
          try {
            fs.unlinkSync(path.join(stateDir, 'locks', name));
          } catch {
            // best-effort (PRD §394)
          }
        }
      }

      // Step 5: everything must be quiet before the schema moves.
      checkPreconditions(stateDir, {
        ignoreSids: new Set(dryRun ? staleSids : []),
        ignoreLocks: new Set(dryRun ? orphanLocks : []),
      });

      // Steps 6-7.
      migrateRecords(stateDir, { dryRun, trace });
      if (!dryRun) say(`schema_version ${schema.version} → ${HOOK_SCHEMA_VERSION} at ${stateDir}`);
    } finally {
      // Step 8: migrate.lock, then the mutex.
      releaseLock();
    }
  } finally {
    releaseMutex();
  }
}

function parseArgs(argv) {
  const known = new Set(['--force-foreign-cleanup', '--dry-run']);
  const unknown = argv.filter((a) => !known.has(a));
  if (unknown.length > 0) {
    return { error: `unknown option(s): ${unknown.join(' ')}` };
  }
  return { force: argv.includes('--force-foreign-cleanup'), dryRun: argv.includes('--dry-run') };
}

// Returns the process exit code. A dry-run reports the abort it would have hit
// on stdout with the rest of the trace (stderr stays for real failures).
function main(argv, opts) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    process.stderr.write(`[eghs-migrate] ${parsed.error}\n`);
    return 1;
  }
  try {
    runMigrate(parsed, opts);
  } catch (err) {
    if (!(err instanceof MigrateAbort)) throw err;
    if (parsed.dryRun) {
      process.stdout.write(`[eghs-migrate] dry-run: would abort: ${err.message}\n`);
      process.stderr.write('[eghs-migrate] dry-run: no state writes performed\n');
      return 1;
    }
    process.stderr.write(`[eghs-migrate] ${err.message}\n`);
    return 1;
  }
  if (parsed.dryRun) process.stderr.write('[eghs-migrate] dry-run: no state writes performed\n');
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main, MigrateAbort };
