#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { resolveStateDir, P1_SUBDIRS } = require('./lib/state-dir');
const { readSchemaVersion, HOOK_SCHEMA_VERSION } = require('./lib/schema');
const { atomicWriteFile } = require('./lib/atomic-write');

function getRepoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return process.cwd();
  }
}

function main(argv) {
  const repair = argv.includes('--repair');
  const repoRoot = getRepoRoot();
  const stateDir = resolveStateDir(repoRoot);

  const before = readSchemaVersion(stateDir);

  if (!repair) {
    if (before.status !== 'not_initialized') {
      process.stderr.write(
        '[eghs-init] schema_version already exists; use eghs-init --repair or eghs-migrate\n'
      );
      process.exit(1);
    }
  } else {
    if (before.status === 'not_initialized') {
      process.stderr.write(
        '[eghs-init] --repair requires an existing schema_version; run eghs-init first\n'
      );
      process.exit(1);
    }
  }

  for (const sub of P1_SUBDIRS) {
    fs.mkdirSync(path.join(stateDir, sub), { recursive: true, mode: 0o700 });
  }

  if (before.status === 'invalid' || before.status === 'not_initialized') {
    atomicWriteFile(path.join(stateDir, 'schema_version'), `${HOOK_SCHEMA_VERSION}\n`);
  }
  // before.status === 'ok' + --repair: subdirs already recreated above, no-op on schema_version.

  process.stdout.write(`[eghs-init] ready at ${stateDir}\n`);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { main };
