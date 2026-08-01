#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveStateDir } = require('./lib/state-dir');
const { readSchemaVersion, HOOK_SCHEMA_VERSION } = require('./lib/schema');
const { atomicWriteFile } = require('./lib/atomic-write');
const { exclusiveLinkCreate } = require('./lib/exclusive-link');
const { getRepoRoot } = require('./lib/git');
const { isAlive } = require('./lib/proc');
const { isValidSid } = require('./lib/sid');
const { acquireExWithTimeout } = require('./lib/flock');
const { lockBodySane, acquireAdminMutex } = require('./lib/admin-lock');
const { selectStaleSids, gcSessions, cascadeTargets } = require('./lib/session');
const { loadConfig } = require('./lib/config');

// eghs-migrate per PRD §R2.5 steps 0-8: admin-mutex → migrate.lock → role
// validation → sessions GC (+ orphan stop-lock sweep) → empty-state
// precondition → per-record wipe → atomic schema_version rewrite → release.
//
// It never bootstraps: a missing state dir belongs to eghs-init. `--dry-run`
// traces the whole plan and performs no write at all (not even the locks).
//
// The three admin escape hatches (PRD §301-343) live here too: --clear-sid
// (corrupt lease/baseline, the only way out of a repeating
// INFRA_NOT_READY reason=lease_unavailable), --clear-migrate-lock and
// --clear-init-lock (corrupt or non-regular lock files that no hook and no
// other CLI can self-heal). Common lock order: admin-mutex → migrate.lock →
// sid guard.

const MIGRATE_LOCK_GRACE_MS = 600000; // same-uid dead-lock reclaim grace (hook precedence #4)
const FOREIGN_MIGRATE_LOCK_GRACE_MS = 7200000; // 2h before a foreign lock reads as stale
const INIT_LOCK_GRACE_MS = 60000; // .init.lock stale-dead reclaim grace (eghs-init step 4)
// Env override exists for tests only — a stuck hook is a 90s stall otherwise.
const CLEAR_SID_WAIT_MS = Number(process.env.EGHS_CLEAR_SID_WAIT_MS) || 90000;

class MigrateAbort extends Error {}

function abort(msg) {
  throw new MigrateAbort(msg);
}

function say(msg) {
  process.stdout.write(`[eghs-migrate] ${msg}\n`);
}

// kill(0) with the EPERM case kept distinct: `isAlive` folds it into "alive"
// (fail-closed for hooks), but the admin commands owe the user a different
// answer — an unverifiable pid is not a live one (PRD §314).
function pidStatus(pid) {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (err) {
    return err.code === 'ESRCH' ? 'dead' : 'eperm';
  }
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
function reclaimMigrateLock(stateDir, { nowMs, forceForeign, dryRun, trace }) {
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
  if (foreign && !forceForeign) {
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
    abort(
      err.code === 'EEXIST'
        ? 'cannot acquire migrate.lock: another admin op holds it (if it is stale, use --clear-migrate-lock)'
        : `cannot acquire migrate.lock: ${err.message}`
    );
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

// sid-scoped marker dirs left behind by a cascade that hit EPERM. Step 5 has
// already proven sessions/ empty, so every one of these is an orphan — and the
// cascade that failed on them is their only other GC path.
function listOrphanMarkerDirs(stateDir) {
  const failedDir = path.join(stateDir, 'failed');
  try {
    return fs
      .readdirSync(failedDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== 'tmp')
      .map((e) => path.join(failedDir, e.name));
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
  const orphanDirs = listOrphanMarkerDirs(stateDir);
  if (dryRun) {
    trace(`would unlink ${records.length} evidence record(s) under reads/ and failed/`);
    trace(`would remove ${orphanDirs.length} orphan sid-scoped marker dir(s) under failed/`);
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
  for (const p of orphanDirs) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {
      // best-effort: EPERM leaves it for the next run
    }
  }
  atomicWriteFile(path.join(stateDir, 'schema_version'), `${HOOK_SCHEMA_VERSION}\n`);
}

function runMigrate({ forceForeign, dryRun }, { cwd = process.cwd(), nowMs = Date.now() } = {}) {
  const repoRoot = getRepoRoot(cwd) || cwd;
  const stateDir = resolveStateDir(repoRoot);
  const trace = dryRun ? (m) => process.stdout.write(`[eghs-migrate] dry-run: ${m}\n`) : () => {};

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
    reclaimMigrateLock(stateDir, { nowMs, forceForeign, dryRun, trace });
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
        foreignStaleSeconds: forceForeign ? config.session_stale_seconds * 2 : null,
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

// ---------------------------------------------------------------------------
// --clear-sid <SID> (PRD §R2.5 §301-323). The only escape hatch out of a
// corrupt lease/baseline, so its own gates are the safety: admin-mutex (0) →
// migrate.lock (1) → uid gate (3) → pid liveness (4) → tombstone + guard
// barrier (5) → cascade (6) → tombstone unlink (7).

function rmBestEffort({ p, dir }) {
  try {
    if (dir) fs.rmSync(p, { recursive: true, force: true });
    else fs.unlinkSync(p);
  } catch {
    // ENOENT is the normal case; EPERM leaves the file for manual cleanup —
    // the tombstone keeps the sid blocked either way.
  }
}

function fileIdentity(p) {
  try {
    const st = fs.lstatSync(p);
    return { ino: String(st.ino), sha: crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') };
  } catch {
    return null;
  }
}

// Step 3 + 4: who owns this lease, and may we remove it?
function checkSidGates(leasePath, sid, { force, forceForeign }) {
  let st;
  try {
    st = fs.lstatSync(leasePath);
  } catch (err) {
    if (err.code === 'ENOENT') return; // baseline-only corruption: nothing to gate on
    abort(`cannot stat lease for sid ${sid}: ${err.message}`);
  }

  let body = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(leasePath, 'utf8'));
    if (parsed !== null && typeof parsed === 'object') body = parsed;
  } catch {
    body = null; // corrupt body: fall back to the file's own st_uid (PRD §308)
  }

  const ownerUid = body !== null && typeof body.uid === 'number' ? body.uid : st.uid;
  if (ownerUid !== process.getuid()) {
    // --force is deliberately NOT enough for a foreign uid (PRD §306).
    if (!forceForeign) abort(`sid ${sid} foreign uid; use --force-foreign-cleanup instead`);
    try {
      fs.accessSync(leasePath, fs.constants.R_OK);
    } catch {
      abort(`sid ${sid} lease not accessible; cannot clean up`);
    }
  }

  if (body === null || typeof body.pid !== 'number') {
    if (!force) abort(`sid ${sid} lease body corrupt; --force required for cleanup`);
    return;
  }
  const status = pidStatus(body.pid);
  if (status === 'alive' && !force) abort(`sid ${sid} lease pid alive; refusing without --force`);
  if (status === 'eperm') {
    process.stderr.write(`[eghs-migrate] sid ${sid} lease pid=${body.pid} unverifiable (EPERM); treating as dead\n`);
  }
}

// Step 5a: the tombstone is the race guard — once it exists, every hook on
// this sid returns INFRA_NOT_READY reason=sid_cleared, so the cascade below
// cannot be undone by a hook writing state back.
function placeTombstone(tombPath, sid, nowMs) {
  const created = exclusiveLinkCreate(
    tombPath,
    JSON.stringify({
      cleared_by_pid: process.pid,
      cleared_by_uid: process.getuid(),
      ts_ms: nowMs,
      reason: 'clear-sid',
    })
  );
  if (!created.ok) {
    // A tombstone from an earlier attempt: resume it only if its owner is us
    // and provably gone (PRD §317).
    let prev = null;
    try {
      prev = JSON.parse(fs.readFileSync(tombPath, 'utf8'));
    } catch {
      abort(`sid ${sid} tombstone unreadable; inspect ${tombPath}`);
    }
    if (prev === null || typeof prev !== 'object' || prev.cleared_by_uid !== process.getuid()) {
      abort(`sid ${sid} tombstone owned by another user; aborting`);
    }
    if (typeof prev.cleared_by_pid !== 'number' || pidStatus(prev.cleared_by_pid) !== 'dead') {
      abort(`sid ${sid} tombstone held by pid=${prev.cleared_by_pid}; aborting`);
    }
  }
  return fileIdentity(tombPath);
}

function clearSidUnderLocks(stateDir, sid, { force, forceForeign, nowMs }) {
  const sessionsDir = path.join(stateDir, 'sessions');
  const leasePath = path.join(sessionsDir, `${sid}.json`);
  const tombPath = path.join(sessionsDir, `${sid}.tombstone`);

  checkSidGates(leasePath, sid, { force, forceForeign });
  const tombId = placeTombstone(tombPath, sid, nowMs);

  // Step 5b: drain observation. An exclusive guard hold means no hook is
  // mid-write on this sid; a timeout leaves the tombstone behind on purpose
  // (the sid stays blocked, disk stays consistent).
  let guardFd;
  try {
    guardFd = fs.openSync(
      path.join(sessionsDir, `${sid}.guard.lock`),
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_CLOEXEC,
      0o600
    );
  } catch (err) {
    abort(`cannot open guard.lock for sid ${sid}: ${err.message}`);
  }
  if (!acquireExWithTimeout(guardFd, CLEAR_SID_WAIT_MS).ok) {
    fs.closeSync(guardFd);
    abort(`sid ${sid} hooks did not drain within grace; retry`);
  }

  try {
    // Step 6: the §R2.5 §320 set, guard first and lease second (a guard that
    // outlives its lease is a permanent orphan).
    const [guardTarget, ...rest] = cascadeTargets(stateDir, sid).filter((t) => !t.p.endsWith('.tombstone'));
    rmBestEffort(guardTarget);
    rmBestEffort({ p: leasePath, dir: false });
    for (const t of rest) rmBestEffort(t);

    // Key-scoped markers are not sid-named: only their body says who wrote them.
    let markers = [];
    try {
      markers = fs.readdirSync(path.join(stateDir, 'failed')).filter((n) => n.endsWith('.json'));
    } catch {
      // failed/ unreadable: those markers age out via their own GC
    }
    for (const name of markers) {
      const p = path.join(stateDir, 'failed', name);
      try {
        if (JSON.parse(fs.readFileSync(p, 'utf8')).origin_sid === sid) fs.unlinkSync(p);
      } catch {
        // unreadable or already gone: best-effort
      }
    }
  } finally {
    fs.closeSync(guardFd); // releases the flock; the file itself is already unlinked
  }

  // Step 7: drop our own tombstone, never someone else's replacement.
  const nowId = fileIdentity(tombPath);
  if (nowId && tombId && nowId.ino === tombId.ino && nowId.sha === tombId.sha) {
    rmBestEffort({ p: tombPath, dir: false });
  } else if (nowId) {
    process.stderr.write(`[eghs-migrate] sid ${sid} tombstone changed during cleanup; left in place\n`);
  }
  say(`sid ${sid} cleared`);
}

function clearSid(stateDir, sid, opts) {
  if (!isValidSid(sid)) abort(`--clear-sid requires a lowercase UUIDv4 sid; got "${sid}"`);
  const mutex = acquireAdminMutex(stateDir);
  if (!mutex.ok) abort(mutex.reason);
  try {
    // Step 1: plain exclusive create — unlike the migrate flow this never
    // reclaims a stale lock (that is --clear-migrate-lock's job).
    const releaseLock = createMigrateLock(stateDir, opts.nowMs);
    try {
      clearSidUnderLocks(stateDir, sid, opts);
    } finally {
      releaseLock();
    }
  } finally {
    mutex.release();
  }
}

// ---------------------------------------------------------------------------
// --clear-migrate-lock / --clear-init-lock (PRD §324-343). Same procedure,
// different target: classify by lstat WITHOUT opening (a FIFO would block, a
// symlink would misdirect), then re-verify the exact identity under the admin
// mutex so a freshly created valid lock is never killed.

function snapshotRegular(p) {
  let fd;
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    const body = fs.readFileSync(fd);
    return {
      ino: String(st.ino),
      dev: String(st.dev),
      size: String(st.size),
      mtimeNs: String(st.mtimeNs),
      sha: crypto.createHash('sha256').update(body).digest('hex'),
      uid: Number(st.uid),
      body: body.toString('utf8'),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function sameSnapshot(a, b) {
  return (
    a !== null &&
    b !== null &&
    a.ino === b.ino &&
    a.dev === b.dev &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.sha === b.sha
  );
}

// Step 3b: decide whether a regular lock file may be removed at all.
function verifyRemovableLock(snap, { name, graceMs, nowMs }) {
  let body = null;
  try {
    body = JSON.parse(snap.body);
  } catch {
    return; // corrupt body: removable
  }
  if (!lockBodySane(body, nowMs)) return;
  if (body.uid !== snap.uid) return; // body disagrees with the inode's owner: corrupt
  const status = pidStatus(body.pid);
  if (status === 'alive') abort(`${name} held by pid=${body.pid}; refusing to remove a live lock`);
  if (nowMs - body.start_ms < graceMs) abort(`${name} dead but within its grace window; retry later`);
}

function clearLockFile(stateDir, { name, graceMs, forceForeign, nowMs }, attemptsLeft = 3) {
  if (attemptsLeft <= 0) abort(`${name} replaced during check; retry`);
  const p = path.join(stateDir, name);

  // Step 1: lstat only — never open an unclassified path.
  let st;
  try {
    st = fs.lstatSync(p);
  } catch (err) {
    if (err.code === 'ENOENT') {
      say(`${name} absent (no-op)`);
      return;
    }
    abort(`cannot stat ${name}: ${err.message}`);
  }
  if (st.uid !== process.getuid() && !forceForeign) {
    abort(`${name} owned by uid ${st.uid}; use --force-foreign-cleanup`);
  }

  // Step 2: type branch.
  let removeDir = false;
  let snapshot = null;
  if (st.isSymbolicLink() || st.isFIFO() || st.isSocket()) {
    // Removed without ever opening it (symlink attack / FIFO blocking).
  } else if (st.isDirectory()) {
    let entries;
    try {
      entries = fs.readdirSync(p);
    } catch (err) {
      abort(`${name} is a directory that cannot be listed (${err.code}); manual cleanup required`);
    }
    if (entries.length > 0) {
      abort(`${name} is a directory and not empty; manual cleanup required`);
    }
    removeDir = true;
  } else if (st.isFile()) {
    snapshot = snapshotRegular(p);
    if (snapshot === null) abort(`${name} vanished while being read; retry`);
    verifyRemovableLock(snapshot, { name, graceMs, nowMs });
  } else {
    abort(`${name} has an unexpected file type; manual cleanup required`);
  }

  // Steps 4-6: the mutex is taken AFTER classification and released right
  // after the unlink, so the whole TOCTOU window sits inside it.
  const mutex = acquireAdminMutex(stateDir);
  if (!mutex.ok) abort(mutex.reason);
  let retry = false;
  try {
    let st2;
    try {
      st2 = fs.lstatSync(p);
    } catch (err) {
      if (err.code === 'ENOENT') {
        say(`${name} vanished before cleanup (no-op)`);
        return;
      }
      abort(`cannot re-stat ${name}: ${err.message}`);
    }
    if (st2.mode !== st.mode || String(st2.ino) !== String(st.ino)) {
      retry = true;
    } else if (snapshot !== null && !sameSnapshot(snapshotRegular(p), snapshot)) {
      retry = true;
    }
    if (!retry) {
      try {
        if (removeDir) fs.rmdirSync(p);
        else fs.unlinkSync(p);
      } catch (err) {
        // e.g. the directory filled up again, or EPERM on a sticky parent.
        abort(`cannot remove ${name}: ${err.message}`);
      }
      say(`${name} removed`);
    }
  } finally {
    mutex.release();
  }
  if (retry) return clearLockFile(stateDir, { name, graceMs, forceForeign, nowMs }, attemptsLeft - 1);
}

function runClearCommand(mode, { sid, force, forceForeign }, { cwd = process.cwd(), nowMs = Date.now() } = {}) {
  const repoRoot = getRepoRoot(cwd) || cwd;
  const stateDir = resolveStateDir(repoRoot);
  if (!isDirectory(path.join(stateDir, 'locks'))) {
    abort(`state dir not initialized at ${stateDir}; run eghs-init`);
  }
  if (mode === 'clear-sid') {
    clearSid(stateDir, sid, { force, forceForeign, nowMs });
    return;
  }
  clearLockFile(stateDir, {
    name: mode === 'clear-migrate-lock' ? 'migrate.lock' : '.init.lock',
    graceMs: mode === 'clear-migrate-lock' ? MIGRATE_LOCK_GRACE_MS : INIT_LOCK_GRACE_MS,
    forceForeign,
    nowMs,
  });
}

const CLEAR_MODES = {
  '--clear-sid': 'clear-sid',
  '--clear-migrate-lock': 'clear-migrate-lock',
  '--clear-init-lock': 'clear-init-lock',
};

function parseArgs(argv) {
  const opts = { mode: 'migrate', sid: null, force: false, forceForeign: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') opts.force = true;
    else if (arg === '--force-foreign-cleanup') opts.forceForeign = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (CLEAR_MODES[arg]) {
      if (opts.mode !== 'migrate') return { error: 'only one command at a time' };
      opts.mode = CLEAR_MODES[arg];
      if (arg === '--clear-sid') {
        opts.sid = argv[i + 1];
        i += 1;
        if (opts.sid === undefined) return { error: '--clear-sid requires a sid argument' };
      }
    } else return { error: `unknown option(s): ${arg}` };
  }
  if (opts.dryRun && opts.mode !== 'migrate') {
    return { error: `--dry-run is not supported with ${opts.mode.replace('clear-', '--clear-')}` };
  }
  if (opts.force && opts.mode !== 'clear-sid') {
    return { error: '--force applies only to --clear-sid (use --force-foreign-cleanup elsewhere)' };
  }
  return opts;
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
    if (parsed.mode === 'migrate') runMigrate(parsed, opts);
    else runClearCommand(parsed.mode, parsed, opts);
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
