#!/usr/bin/env node
'use strict';
// eghs-inspect (PRD §6, MVP item 7) — read-only P3 verification CLI.
//   node hooks/inspect.js              dump the whole EGHS state dir as JSON
//   node hooks/inspect.js --dry-run    read a hook-input JSON from stdin and
//                                      print the state it resolves to
const fs = require('fs');
const path = require('path');
const { readStdin } = require('./lib/stdin');
const { getRepoRoot } = require('./lib/git');
const { resolveStateDir } = require('./lib/state-dir');
const { readSchemaVersion } = require('./lib/schema');
const { readFsInfo } = require('./lib/fs-info');
const { canonicalKeyAllowMissing, keyHash } = require('./lib/canonical');
const { isOutsideRepo } = require('./lib/tool-hook');
const { readReadState } = require('./lib/read-state');
const { listPreFilesForHash } = require('./lib/pre-file');
const { isValidSid } = require('./lib/sid');
const { isAlive } = require('./lib/proc');

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null; // absent or unparseable both render as null
  }
}

// [{name, body}] for every *.json directly inside dir (absent dir → []).
function jsonEntries(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    // absent dir
  }
  return names.sort().map((name) => ({ name, body: readJson(path.join(dir, name)) }));
}

function subdirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== 'tmp')
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function dump(stateDir) {
  const failedDir = path.join(stateDir, 'failed');
  const preDir = path.join(stateDir, 'pre');
  return {
    state_dir: stateDir,
    schema: readSchemaVersion(stateDir),
    fs_info: readFsInfo(stateDir),
    sessions: jsonEntries(path.join(stateDir, 'sessions')).map(({ name, body }) => ({
      sid: name.replace(/\.json$/, ''),
      alive: body && typeof body.pid === 'number' ? isAlive(body.pid) : null,
      body,
    })),
    reads: jsonEntries(path.join(stateDir, 'reads')),
    failed: {
      key_scoped: jsonEntries(failedDir),
      sid_scoped: Object.fromEntries(
        subdirs(failedDir).map((sid) => [sid, jsonEntries(path.join(failedDir, sid))])
      ),
    },
    pre: Object.fromEntries(subdirs(preDir).map((sid) => [sid, jsonEntries(path.join(preDir, sid))])),
  };
}

// Resolve a hook input the way the tool hooks would and report every piece
// of state they would consult for that file. Never writes anything.
function dryRun(stateDir, repoRoot, caseless, input) {
  const filePath = input.tool_input && input.tool_input.file_path;
  if (typeof filePath !== 'string') {
    throw new Error('hook input has no tool_input.file_path');
  }
  const resolved = canonicalKeyAllowMissing(filePath, { caseless });
  if (!resolved.ok) throw new Error(`cannot resolve ${filePath}: ${resolved.code}`);
  const key = resolved.key;
  const hash = keyHash(key);
  const sid = isValidSid(input.session_id) ? input.session_id : null;
  return {
    file: filePath,
    key,
    key_hash: hash,
    outside_repo: isOutsideRepo(key, repoRoot, caseless),
    sid,
    state: readReadState(stateDir, key),
    key_marker: readJson(path.join(stateDir, 'failed', `${hash}.json`)),
    sid_marker: sid ? readJson(path.join(stateDir, 'failed', sid, `${hash}.json`)) : null,
    pre_read: sid ? preEntries(stateDir, sid, hash, 'read') : [],
    pre_write: sid ? preEntries(stateDir, sid, hash, 'write') : [],
  };
}

// One entry per tool_use_id (R16 amendment: parallel calls keep distinct
// pre-records, so a dry-run must show all of them).
function preEntries(stateDir, sid, hash, kind) {
  return listPreFilesForHash(stateDir, sid, hash, kind).map(({ toolUseId, path: p }) => ({
    tool_use_id: toolUseId,
    body: readJson(p),
  }));
}

function main() {
  const repoRoot = getRepoRoot(process.cwd()) || process.cwd();
  const stateDir = resolveStateDir(repoRoot);
  if (readSchemaVersion(stateDir).status !== 'ok') {
    throw new Error(`state dir not initialized at ${stateDir} — run \`node hooks/init.js\``);
  }

  if (process.argv.includes('--dry-run')) {
    let input;
    try {
      input = JSON.parse(readStdin());
    } catch (err) {
      throw new Error(`stdin is not valid hook-input JSON: ${err.message}`);
    }
    const fsInfo = readFsInfo(stateDir);
    if (fsInfo.status !== 'ok') {
      throw new Error(`fs-info ${fsInfo.status} — run \`node hooks/init.js --repair\``);
    }
    process.stdout.write(JSON.stringify(dryRun(stateDir, repoRoot, fsInfo.caseless, input), null, 2) + '\n');
    return;
  }

  process.stdout.write(JSON.stringify(dump(stateDir), null, 2) + '\n');
}

try {
  main();
} catch (err) {
  process.stderr.write(`[eghs] inspect: ${err.message}\n`);
  process.exitCode = 1;
}
