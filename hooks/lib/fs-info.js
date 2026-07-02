'use strict';
const fs = require('fs');
const path = require('path');
const { atomicWriteFile } = require('./atomic-write');

const FS_INFO_FILENAME = 'fs-info.json';

// Hooks only read this cache (stat per call, never write) — probing and
// writing it is eghs-init's job (PRD §R2), so a hook can't race the probe.
function readFsInfo(stateDir) {
  let info;
  try {
    info = JSON.parse(fs.readFileSync(path.join(stateDir, FS_INFO_FILENAME), 'utf8'));
  } catch (err) {
    // Missing file -> ENOENT; unreadable or malformed JSON -> invalid.
    return err.code === 'ENOENT' ? { status: 'missing' } : { status: 'invalid' };
  }
  // `null` is valid JSON — the property access below would throw on it.
  if (info === null || typeof info !== 'object' || typeof info.caseless_fs !== 'boolean') {
    return { status: 'invalid' };
  }
  return { status: 'ok', caseless: info.caseless_fs };
}

// Caseless-FS probe (PRD §R2): create `.cs-probe`, then stat `.CS-PROBE` —
// on a caseless filesystem both spellings resolve to the same inode.
// Caller must hold .init.lock: the probe files are fixed names in stateDir.
function probeAndWriteFsInfo(stateDir, nowMs) {
  const lower = path.join(stateDir, '.cs-probe');
  const upper = path.join(stateDir, '.CS-PROBE');
  // Leftovers from a crashed probe would EEXIST the create (caseless FS) —
  // clear both spellings first.
  fs.rmSync(lower, { force: true });
  fs.rmSync(upper, { force: true });
  fs.closeSync(fs.openSync(lower, 'wx', 0o600));
  let caseless = false;
  try {
    const a = fs.statSync(lower);
    try {
      const b = fs.statSync(upper);
      caseless = a.dev === b.dev && a.ino === b.ino;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  } finally {
    fs.rmSync(lower, { force: true });
    fs.rmSync(upper, { force: true });
  }
  atomicWriteFile(
    path.join(stateDir, FS_INFO_FILENAME),
    `${JSON.stringify({ schema_version: 1, caseless_fs: caseless, ts_ms: nowMs })}\n`
  );
  return caseless;
}

module.exports = { readFsInfo, probeAndWriteFsInfo };
