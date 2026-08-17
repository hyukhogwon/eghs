#!/usr/bin/env node
'use strict';
// eghs-bypass-watcher (PRD §5 측정 방법) — the optional background poller that
// makes the Bash-bypass detection rate measurable.
//
//   node hooks/bypass-watcher.js --once
//   node hooks/bypass-watcher.js --interval-seconds 30
//
// It SHAs every file matching `state_gate_paths`, diffs against the previous
// poll, and logs each change it cannot attribute to an EGHS-observed edit.
// `eghs-metrics` then correlates those observations with the next PreToolUse
// decision on the same path (detected iff RACE_DETECTED).
//
// This is NOT a hook: no lease, no guard, no precedence chain. It reads
// reads/ and appends to its own log, nothing more.
const fs = require('fs');
const path = require('path');
const picomatch = require('picomatch');
const { getRepoRoot } = require('./lib/git');
const { resolveStateDir } = require('./lib/state-dir');
const { readSchemaVersion } = require('./lib/schema');
const { readFsInfo } = require('./lib/fs-info');
const { loadConfig } = require('./lib/config');
const { canonicalKey, keyHash, sha256File } = require('./lib/canonical');
const { readReadState } = require('./lib/read-state');
const { checkKillSwitch } = require('./lib/kill-switch');
const { atomicWriteFile } = require('./lib/atomic-write');

const SNAPSHOT = '.bypass-snapshot.json';
const LOG = 'bypass-watcher.jsonl';
const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;
const DEFAULT_INTERVAL_SECONDS = 30;

// Pruned unconditionally: .git and the state dir are churn the watcher itself
// causes or git causes, and node_modules is both huge and never the thing a
// bypass is hiding in. Everything else under the repo is walked, because
// `state_gate_paths` is the only scope definition EGHS has.
const PRUNE = new Set(['.git', 'node_modules']);

function walk(dir, repoRoot, stateDir, isMatch, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // unreadable dir: best-effort, keep polling the rest
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (full === stateDir) continue;
    if (entry.isDirectory()) {
      if (PRUNE.has(entry.name)) continue;
      walk(full, repoRoot, stateDir, isMatch, out);
    } else if (entry.isFile()) {
      if (isMatch(path.relative(repoRoot, full))) out.push(full);
    }
    // symlinks are skipped: their target is walked on its own if it is in-repo
  }
  return out;
}

// One poll's view of the world: canonical key -> sha256. Files that vanish
// between readdir and hashing are simply absent from it.
function snapshotNow(repoRoot, stateDir, config, caseless) {
  // Same matcher call as lib/gate.js — picomatch v4, {dot:true}, repo-relative
  // (PRD §R3 "picomatch 단일 reference").
  const globs = (config.state_gate_paths || []).filter((g) => typeof g === 'string' && g.length > 0);
  const isMatch = globs.length === 0 ? () => false : picomatch(globs, { dot: true });

  const files = {};
  for (const file of walk(repoRoot, repoRoot, stateDir, isMatch, [])) {
    const resolved = canonicalKey(file, { caseless });
    if (!resolved.ok) continue;
    const hashed = sha256File(resolved.key);
    if (!hashed.ok) continue;
    files[resolved.key] = hashed.sha;
  }
  return files;
}

function readSnapshot(stateDir) {
  try {
    const body = JSON.parse(fs.readFileSync(path.join(stateDir, 'debug', SNAPSHOT), 'utf8'));
    if (body === null || typeof body !== 'object' || body.files === null || typeof body.files !== 'object') {
      return null;
    }
    return body.files;
  } catch {
    return null; // absent or corrupt: re-baseline rather than guess
  }
}

// A change is attributed — i.e. EGHS saw the edit, it is not a bypass — iff
// the read state records THIS new sha as a successful edit. `full_read` does
// not attribute anything: reading a file does not change it, so a read record
// carrying the new sha means something else wrote it.
function isAttributed(stateDir, key, newSha) {
  const state = readReadState(stateDir, key);
  return state !== null && state.evidence === 'post_edit_success' && state.sha === newSha;
}

// The debug GC is per-sid (`debug/<sid>.jsonl`), so nothing would ever sweep
// this log — it rotates itself instead of becoming the §G5 disk leak this
// project has already had to fix twice.
function rotateIfLarge(logPath, maxBytes) {
  try {
    if (fs.statSync(logPath).size <= maxBytes) return;
  } catch {
    return; // no log yet
  }
  try {
    fs.renameSync(logPath, `${logPath}.1`);
  } catch {
    // rotation is best-effort; a failed rename just means the log keeps growing
  }
}

function poll(repoRoot, stateDir, caseless, { maxLogBytes }) {
  const config = loadConfig(repoRoot);
  const current = snapshotNow(repoRoot, stateDir, config, caseless);
  const previous = readSnapshot(stateDir);

  let observed = 0;
  if (previous !== null) {
    const logPath = path.join(stateDir, 'debug', LOG);
    rotateIfLarge(logPath, maxLogBytes);
    const lines = [];
    for (const [key, sha] of Object.entries(current)) {
      const prevSha = previous[key];
      // Creations (no prev) and deletions (no current) are snapshot-only: a
      // later Edit on a file EGHS never saw denies with UNREAD_OR_STALE, not
      // RACE_DETECTED, so §5's rate is not defined over them.
      if (prevSha === undefined || prevSha === sha) continue;
      if (isAttributed(stateDir, key, sha)) continue;
      lines.push(
        JSON.stringify({
          schema_version: 1,
          ts_ms: Date.now(),
          event: 'bypass_observed',
          path: key,
          key_hash: keyHash(key),
          prev_sha: prevSha,
          new_sha: sha,
        })
      );
    }
    if (lines.length > 0) {
      fs.appendFileSync(logPath, lines.join('\n') + '\n');
      observed = lines.length;
    }
  }

  atomicWriteFile(
    path.join(stateDir, 'debug', SNAPSHOT),
    JSON.stringify({ schema_version: 1, ts_ms: Date.now(), files: current }) + '\n'
  );
  return { watched: Object.keys(current).length, observed, baselined: previous === null };
}

function parseArgs(argv) {
  const opts = {
    once: false,
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    maxLogBytes: DEFAULT_MAX_LOG_BYTES,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const nextNumber = () => {
      const v = Number(argv[i + 1]);
      if (!Number.isFinite(v) || v <= 0) throw new Error(`${arg} requires a positive number`);
      i += 1;
      return v;
    };
    if (arg === '--once') opts.once = true;
    else if (arg === '--interval-seconds') opts.intervalSeconds = nextNumber();
    else if (arg === '--max-log-bytes') opts.maxLogBytes = nextNumber();
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  const repoRoot = getRepoRoot(process.cwd()) || process.cwd();

  // G5: the kill switch stops the watcher before it writes anything at all,
  // exactly as it stops the hooks (PRD §R6 #2).
  const killSwitch = checkKillSwitch({ repoRoot, env: process.env });
  if (killSwitch.active) {
    process.stderr.write(`[eghs] kill-switch active: ${killSwitch.reason} — watcher exiting\n`);
    return;
  }

  const stateDir = resolveStateDir(repoRoot);
  if (readSchemaVersion(stateDir).status !== 'ok') {
    throw new Error(`state dir not initialized at ${stateDir} — run \`node hooks/init.js\``);
  }
  const fsInfo = readFsInfo(stateDir);
  if (fsInfo.status !== 'ok') {
    throw new Error(`fs-info ${fsInfo.status} — run \`node hooks/init.js --repair\``);
  }

  const runOnce = () => {
    const { watched, observed, baselined } = poll(repoRoot, stateDir, fsInfo.caseless, opts);
    process.stderr.write(
      `[eghs] bypass-watcher: ${watched} watched file(s), ` +
        `${baselined ? 'baseline recorded' : `${observed} unattributed change(s)`}\n`
    );
  };

  runOnce();
  if (opts.once) return;

  // In daemon mode a poll must not be able to kill the watcher: a config file
  // saved mid-edit, a transient EACCES, a full disk — all recover on the next
  // tick, and a watcher that exited hours ago silently stops measuring. The
  // one-shot path above deliberately keeps throwing (exit 1).
  const timer = setInterval(() => {
    try {
      runOnce();
    } catch (err) {
      process.stderr.write(`[eghs] bypass-watcher: poll failed, retrying next tick: ${err.message}\n`);
    }
  }, opts.intervalSeconds * 1000);
  const stop = () => {
    clearInterval(timer);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`[eghs] bypass-watcher: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { main, poll };
