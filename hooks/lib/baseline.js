'use strict';
const fs = require('fs');
const path = require('path');
const { exclusiveLinkCreate } = require('./exclusive-link');
const { getHeadCommit } = require('./git');
const { SidCollisionError } = require('./session');

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH'; // EPERM etc. => treat as alive (fail-closed)
  }
}

function baselinePath(stateDir, sid) {
  return path.join(stateDir, 'baselines', `${sid}.txt`);
}

// A corrupt/unparseable baseline is treated the same as a missing one — PRD
// §R6 6.3b.4 explicitly routes "baseline JSON parse 실패" into stale-cleanup.
function readBody(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// PRD §R6 6.3a/b/c, scoped to P1's single writer (only Stop leases sessions,
// so baseline anchors only ever contend with a prior Stop invocation).
function ensureBaseline(stateDir, sid, { lease, repoRoot }) {
  const filePath = baselinePath(stateDir, sid);
  const write = () => {
    const body = {
      commit: getHeadCommit(repoRoot),
      lease_start_ms: lease.start_ms,
      lease_pid: lease.pid,
    };
    const created = exclusiveLinkCreate(filePath, JSON.stringify(body));
    return { body, created };
  };

  const { body: freshBody, created } = write();
  if (created.ok) return { commit: freshBody.commit };

  // Already existed -> inspect anchor.
  const existing = readBody(filePath);
  const anchorMatches =
    existing && existing.lease_start_ms === lease.start_ms && existing.lease_pid === lease.pid;

  if (anchorMatches) {
    return { commit: existing.commit };
  }

  if (existing && existing.lease_pid !== lease.pid && isAlive(existing.lease_pid)) {
    throw new SidCollisionError(
      `baseline for sid ${sid} anchored to live foreign pid ${existing.lease_pid}`
    );
  }

  // Anchor mismatch + dead (or missing/corrupt) foreign lease -> stale-cleanup.
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ENOENT: another process already cleaned it up; fall through to retry.
  }
  const retry = write();
  if (retry.created.ok) return { commit: retry.body.commit };

  const afterRetry = readBody(filePath);
  if (
    afterRetry &&
    afterRetry.lease_start_ms === lease.start_ms &&
    afterRetry.lease_pid === lease.pid
  ) {
    return { commit: afterRetry.commit };
  }
  throw new Error(`INFRA_NOT_READY: could not establish baseline anchor for sid ${sid}`);
}

module.exports = { ensureBaseline };
