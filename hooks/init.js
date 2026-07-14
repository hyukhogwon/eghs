#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { resolveStateDir, STATE_SUBDIRS } = require('./lib/state-dir');
const { readSchemaVersion, HOOK_SCHEMA_VERSION } = require('./lib/schema');
const { readFsInfo, probeAndWriteFsInfo, FlockUnsupportedError } = require('./lib/fs-info');
const { atomicWriteFile } = require('./lib/atomic-write');
const { getRepoRoot } = require('./lib/git');

// Serializes concurrent `eghs-init` invocations so two racing bootstraps
// can't both observe not_initialized and both "win" (PRD §R2.5 `.init.lock`).
// P1 has no eghs-migrate CLI, so this only ever contends with itself; a
// crashed run leaves the lock behind and requires manual removal — full
// stale-lock recovery is P3 scope alongside eghs-migrate.
function acquireInitLock(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(stateDir, '.init.lock');
  let fd;
  try {
    fd = fs.openSync(lockPath, 'wx', 0o600);
  } catch (err) {
    if (err.code === 'EEXIST') {
      process.stderr.write(
        '[eghs-init] another eghs-init is already running (or crashed and left a stale lock). ' +
          `If none is running, remove ${lockPath} and retry.\n`
      );
      process.exit(1);
    }
    throw err;
  }
  fs.closeSync(fd);
  return () => {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // already gone -> fine
    }
  };
}

function main(argv) {
  const repair = argv.includes('--repair');
  const repoRoot = getRepoRoot(process.cwd()) || process.cwd();
  const stateDir = resolveStateDir(repoRoot);

  const releaseLock = acquireInitLock(stateDir);
  try {
    const before = readSchemaVersion(stateDir);

    if (!repair) {
      if (before.status !== 'not_initialized') {
        process.stderr.write(
          '[eghs-init] schema_version already exists; use eghs-init --repair or eghs-migrate\n'
        );
        releaseLock(); // process.exit() below skips `finally` — release explicitly first.
        process.exit(1);
      }
    } else {
      if (before.status === 'not_initialized') {
        process.stderr.write(
          '[eghs-init] --repair requires an existing schema_version; run eghs-init first\n'
        );
        releaseLock();
        process.exit(1);
      }
    }

    for (const sub of STATE_SUBDIRS) {
      fs.mkdirSync(path.join(stateDir, sub), { recursive: true, mode: 0o700 });
    }

    // Probe before schema_version: schema presence is the single "all infra
    // ready" signal (PRD §R2.5 init step 7), so fs-info.json must exist first.
    // A healthy cache is kept as-is — the filesystem's case behavior can't
    // change under a live state dir, so --repair only fixes missing/unhealthy
    // (PRD Cases 3/4: legacy v1 cache, corruption, FS move all re-probe).
    if (readFsInfo(stateDir).status !== 'ok') {
      fs.rmSync(path.join(stateDir, 'fs-info.json'), { force: true }); // Case 4: unlink before re-probe
      try {
        probeAndWriteFsInfo(stateDir, Date.now());
      } catch (err) {
        if (err instanceof FlockUnsupportedError) {
          // PRD init step 6c: fail-closed — guard rwlock and admin mutex
          // correctness depend on real flock semantics.
          process.stderr.write(`[eghs-init] ${err.message}\n`);
          releaseLock();
          process.exit(1);
        }
        throw err;
      }
    }

    if (before.status === 'invalid' || before.status === 'not_initialized') {
      atomicWriteFile(path.join(stateDir, 'schema_version'), `${HOOK_SCHEMA_VERSION}\n`);
    }
    // before.status === 'ok' + --repair: subdirs already recreated above, no-op on schema_version.

    process.stdout.write(`[eghs-init] ready at ${stateDir}\n`);
  } finally {
    releaseLock();
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { main };
