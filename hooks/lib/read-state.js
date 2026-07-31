'use strict';
const fs = require('fs');
const path = require('path');
const { atomicWriteFile } = require('./atomic-write');
const { keyHash } = require('./canonical');

// R2 read/post-edit state records and failed markers (PRD §R2, §R2.5).
// All writers here are best-effort against a broken state dir: P3 hooks are
// record-only and must degrade to "skip", never crash the tool call.

function readsPath(stateDir, key) {
  return path.join(stateDir, 'reads', `${keyHash(key)}.json`);
}

function markerPath(stateDir, key, sid) {
  if (sid !== null) {
    // Defense-in-depth: entrypoints validate session_id as UUIDv4, but sid
    // becomes a directory name here — never let a stray value traverse out
    // of failed/. Throwing lands in the callers' best-effort catch (= skip).
    if (typeof sid !== 'string' || !/^[0-9a-f-]+$/.test(sid)) {
      throw new Error(`unsafe sid for marker path: ${sid}`);
    }
    return path.join(stateDir, 'failed', sid, `${keyHash(key)}.json`);
  }
  return path.join(stateDir, 'failed', `${keyHash(key)}.json`);
}

// record: {file, sha, size, ts_ms, sid, evidence} — schema_version is added
// here so callers can't write a version-less record.
function writeReadState(stateDir, key, record) {
  try {
    // Spread first: the pinned schema_version must win over any caller field.
    atomicWriteFile(readsPath(stateDir, key), `${JSON.stringify({ ...record, schema_version: 1 })}\n`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function readReadState(stateDir, key) {
  try {
    const state = JSON.parse(fs.readFileSync(readsPath(stateDir, key), 'utf8'));
    return state !== null && typeof state === 'object' && !Array.isArray(state) ? state : null;
  } catch {
    return null;
  }
}

// Marker body per PRD §R2: {schema_version, origin_sid, ts_ms, reason}.
// sidScoped markers affect only their own session and are cascade-GC'd with
// it; key-scoped markers block every session (P4). Best-effort by contract.
function writeFailedMarker(stateDir, key, { sid, tsMs, reason, sidScoped = false }) {
  // A sidScoped request with a non-string sid must not alias into the
  // key-scoped path (markerPath treats null as "key-scoped" by design).
  if (sidScoped && typeof sid !== 'string') return;
  const body = { schema_version: 1, origin_sid: sid, ts_ms: tsMs, reason };
  try {
    // atomicWriteFile's tmp helper mkdirs the destination's tmp/ subdir
    // recursively, which also lazily creates failed/<sid>/ (PRD §R2.5).
    atomicWriteFile(markerPath(stateDir, key, sidScoped ? sid : null), `${JSON.stringify(body)}\n`);
  } catch {
    // Losing a marker weakens future gating but must not fail the tool call.
  }
}

// Marker release policy (PRD §R2): after this sid successfully records
// full_read/post_edit_success, clear (a) our own sid-scoped marker, and
// (b) the key-scoped marker iff we own it OR it predates our lease start
// (a newer marker belongs to a concurrently-active session — keep it).
function clearMarkersOnSuccess(stateDir, key, { sid, leaseStartMs }) {
  if (typeof sid === 'string') {
    // Non-string sid would alias markerPath into the key-scoped file and
    // bypass the release policy below — skip the own-marker unlink instead.
    try {
      fs.unlinkSync(markerPath(stateDir, key, sid));
    } catch {
      // ENOENT/EPERM: best-effort, retried on the next successful record.
    }
  }
  try {
    const keyScoped = markerPath(stateDir, key, null);
    const marker = JSON.parse(fs.readFileSync(keyScoped, 'utf8'));
    // ts_ms must be a real number: a corrupt marker (ts_ms null/string)
    // coercing past `<` would fail-open and clear a foreign marker.
    if (marker.origin_sid === sid || (typeof marker.ts_ms === 'number' && marker.ts_ms < leaseStartMs)) {
      fs.unlinkSync(keyScoped);
    }
  } catch {
    // Absent or unreadable key-scoped marker: nothing to clear.
  }
}

module.exports = { readsPath, writeReadState, readReadState, writeFailedMarker, clearMarkersOnSuccess };
