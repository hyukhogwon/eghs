'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { atomicWriteFile } = require('./atomic-write');
const { flockExNb, flockUn } = require('./flock');

const FS_INFO_FILENAME = 'fs-info.json';
const MAX_FS_INFO_BYTES = 4096;
const REQUIRED_FIELDS = ['schema_version', 'caseless_fs', 'flock_ok', 'fs_st_dev', 'fs_statfs_id'];

let probeSeq = 0;

// Current filesystem identity of stateDir (PRD §R2.5 step 6d anchors).
// fs_statfs_id deviates from the PRD letter deliberately: Node core exposes
// only the numeric statfs type on every platform (no f_fstypename), so the
// id is "<platform>:<decimal type>" — same anchor strength, no native code.
// (PRD amendment queued, plan decision 3.)
function liveAnchor(dir) {
  const tag = process.platform === 'darwin' || process.platform === 'linux'
    ? process.platform
    : `posix:${process.platform}`;
  return {
    fsStDev: fs.statSync(dir).dev,
    fsStatfsId: `${tag}:${fs.statfsSync(dir).type}`,
  };
}

// Hooks only read this cache (stat per call, never write) — probing and
// writing it is eghs-init's job (PRD §R2), so a hook can't race the probe.
//
// The unhealthy predicate is PRD §R6 #3.3 verbatim and is shared with
// `eghs-init --repair` Case 4: absent → missing; non-regular / >4KB /
// corrupt JSON / missing or mistyped required field / flock_ok !== true /
// FS anchor mismatch → unhealthy (remediation: eghs-init --repair).
function readFsInfo(stateDir) {
  const p = path.join(stateDir, FS_INFO_FILENAME);
  let st;
  try {
    st = fs.lstatSync(p);
  } catch (err) {
    return err.code === 'ENOENT' ? { status: 'missing' } : { status: 'unhealthy', reason: 'stat_failed' };
  }
  if (!st.isFile()) return { status: 'unhealthy', reason: 'not_a_regular_file' };
  if (st.size > MAX_FS_INFO_BYTES) return { status: 'unhealthy', reason: 'size_exceeded' };

  let info;
  try {
    info = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return { status: 'unhealthy', reason: 'corrupt_json' };
  }
  if (info === null || typeof info !== 'object' || Array.isArray(info)) {
    return { status: 'unhealthy', reason: 'corrupt_json' };
  }
  const missing = REQUIRED_FIELDS.filter((f) => !(f in info));
  if (missing.length > 0) {
    return { status: 'unhealthy', reason: `missing_fields:${missing.join(',')}` };
  }
  if (
    info.schema_version !== 1 ||
    typeof info.caseless_fs !== 'boolean' ||
    typeof info.fs_st_dev !== 'number' ||
    typeof info.fs_statfs_id !== 'string'
  ) {
    return { status: 'unhealthy', reason: 'field_type_mismatch' };
  }
  if (info.flock_ok !== true) return { status: 'unhealthy', reason: 'flock_not_ok' };

  let anchor;
  try {
    anchor = liveAnchor(stateDir);
  } catch {
    return { status: 'unhealthy', reason: 'anchor_unverifiable' };
  }
  if (info.fs_st_dev !== anchor.fsStDev || info.fs_statfs_id !== anchor.fsStatfsId) {
    return { status: 'unhealthy', reason: 'anchor_mismatch' };
  }
  return { status: 'ok', caseless: info.caseless_fs };
}

class FlockUnsupportedError extends Error {
  constructor(detail) {
    super(
      `flock not supported on this filesystem (likely NFS/CIFS/silent-noop): ${detail}; ` +
        'EGHS requires a local POSIX flock-capable FS'
    );
    this.name = 'FlockUnsupportedError';
  }
}

// flock capability probe (PRD §R2.5 init step 6a-c): the parent takes
// LOCK_EX on a temp file, then a CHILD PROCESS opens the same path with its
// own fd and must observe EWOULDBLOCK. A child that acquires the lock means
// flock is a silent no-op on this FS (broken NFS) — fail-closed: the guard
// rwlock and admin mutex would be theater.
function probeFlockCapability(stateDir) {
  const tmpDir = path.join(stateDir, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  const probePath = path.join(tmpDir, `flock-probe.${process.pid}.${probeSeq++}`);
  const fd = fs.openSync(probePath, 'w+', 0o600); // O_RDWR per PRD step 6a
  try {
    if (!flockExNb(fd).ok) throw new FlockUnsupportedError('parent could not acquire LOCK_EX');
    const child = spawnSync(process.execPath, [
      '-e',
      `
      const fs = require('fs');
      const { flockSync } = require(${JSON.stringify(require.resolve('fs-ext'))});
      const fd = fs.openSync(${JSON.stringify(probePath)}, 'r+');
      try {
        flockSync(fd, 'exnb');
        fs.closeSync(fd);
        process.exit(3); // acquired: flock is a silent no-op here
      } catch (err) {
        fs.closeSync(fd);
        process.exit(err.code === 'EAGAIN' || err.code === 'EWOULDBLOCK' ? 0 : 4);
      }
      `,
    ]);
    if (child.status !== 0) {
      throw new FlockUnsupportedError(
        child.status === 3
          ? 'child acquired a lock the parent holds (silent no-op flock)'
          : `child probe failed (exit ${child.status})`
      );
    }
  } finally {
    try {
      flockUn(fd);
    } catch {
      // fd may be dead; unlink below is what matters
    }
    fs.closeSync(fd);
    fs.rmSync(probePath, { force: true });
  }
}

// Caseless-FS probe (PRD §R2): create `.cs-probe`, then stat `.CS-PROBE` —
// on a caseless filesystem both spellings resolve to the same inode.
// Caller must hold .init.lock: the probe files are fixed names in stateDir.
function probeCaseless(stateDir) {
  const lower = path.join(stateDir, '.cs-probe');
  const upper = path.join(stateDir, '.CS-PROBE');
  // Leftovers from a crashed probe would EEXIST the create (caseless FS) —
  // clear both spellings first. recursive handles a probe-named *directory*
  // (external tampering) that plain rm would EISDIR-crash-loop on.
  fs.rmSync(lower, { force: true, recursive: true });
  fs.rmSync(upper, { force: true, recursive: true });
  fs.closeSync(fs.openSync(lower, 'wx', 0o600));
  try {
    const a = fs.statSync(lower);
    try {
      const b = fs.statSync(upper);
      return a.dev === b.dev && a.ino === b.ino;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      return false;
    }
  } finally {
    fs.rmSync(lower, { force: true, recursive: true });
    fs.rmSync(upper, { force: true, recursive: true });
  }
}

// Full probe (PRD §R2.5 init step 6): caseless + flock capability + FS
// anchors, written as one v2 body. Throws FlockUnsupportedError (fail-closed)
// on a non-flock-capable FS — eghs-init turns that into its non-zero exit.
function probeAndWriteFsInfo(stateDir, nowMs) {
  const caseless = probeCaseless(stateDir);
  probeFlockCapability(stateDir);
  const anchor = liveAnchor(stateDir);
  atomicWriteFile(
    path.join(stateDir, FS_INFO_FILENAME),
    `${JSON.stringify({
      schema_version: 1,
      caseless_fs: caseless,
      flock_ok: true,
      fs_st_dev: anchor.fsStDev,
      fs_statfs_id: anchor.fsStatfsId,
      ts_ms: nowMs,
    })}\n`
  );
  return caseless;
}

module.exports = { readFsInfo, probeAndWriteFsInfo, liveAnchor, FlockUnsupportedError };
