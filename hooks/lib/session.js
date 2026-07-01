'use strict';
const fs = require('fs');
const path = require('path');
const { atomicWriteFile } = require('./atomic-write');

class SidCollisionError extends Error {
  constructor(msg) {
    super(`SID_COLLISION: ${msg}`);
    this.name = 'SidCollisionError';
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH'; // EPERM etc. => treat as alive (fail-closed)
  }
}

function leasePath(stateDir, sid) {
  return path.join(stateDir, 'sessions', `${sid}.json`);
}

function readLease(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// PRD §R6 6.3: create-or-renew. Never overwrites a live foreign-pid lease.
function ensureSessionLease(stateDir, sid, { pid, uid, nowMs }) {
  const filePath = leasePath(stateDir, sid);
  const existing = readLease(filePath);

  if (!existing) {
    const lease = { pid, uid, start_ms: nowMs, renewed_ms: nowMs };
    atomicWriteFile(filePath, JSON.stringify(lease));
    return lease;
  }

  if (existing.pid === pid) {
    const lease = { ...existing, renewed_ms: nowMs };
    atomicWriteFile(filePath, JSON.stringify(lease));
    return lease;
  }

  if (isAlive(existing.pid)) {
    throw new SidCollisionError(
      `sid ${sid} already leased by live pid ${existing.pid} (current pid ${pid})`
    );
  }

  // existing.pid is dead -> stale-cleanup: recreate the lease for this pid.
  const lease = { pid, uid, start_ms: nowMs, renewed_ms: nowMs };
  atomicWriteFile(filePath, JSON.stringify(lease));
  return lease;
}

function gcSessions(stateDir, { nowMs, sessionStaleSeconds = 86400 }) {
  const sessionsDir = path.join(stateDir, 'sessions');
  let entries = [];
  try {
    entries = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }

  for (const entry of entries) {
    const filePath = path.join(sessionsDir, entry);
    let body;
    try {
      body = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue; // ENOENT (raced away) or corrupt -> leave for a later pass
    }
    const staleByTime = nowMs - body.renewed_ms > sessionStaleSeconds * 1000;
    if (staleByTime && !isAlive(body.pid)) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // already gone -> fine
      }
    }
  }
}

module.exports = { ensureSessionLease, gcSessions, SidCollisionError };
