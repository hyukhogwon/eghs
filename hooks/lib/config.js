'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = Object.freeze({
  verification_commands: {},
  verification_timeout_seconds: 45,
  verification_parallel: true,
  verification_cwd: null, // null => repo_root at call time
  verification_shell: ['/bin/sh', '-c'],
  verification_env: {},
  skip_if_only_changed: [],
  diff_base: 'session_baseline',
  max_full_read_bytes: 5 * 1024 * 1024, // above this a Read records partial_read (PRD §R2)
  matcher_engine: 'picomatch',
  debug: true,
  // P4 gate (PRD §R3/§R6). state_gate_paths [] = gate applies to zero paths
  // (dark by default); the deploy config supplies real core-source globs.
  state_gate_paths: [],
  stale_after_seconds: 1800, // R3 gate: full_read/post_edit_success freshness
  session_stale_seconds: 86400,
  read_state_stale_seconds: 2592000,
  failed_marker_stale_seconds: 2592000,
  verify_logs_stale_seconds: 604800,
  tombstone_stale_seconds: 3600,
});

// Shallow top-level merge of .claude/eghs.config.json onto DEFAULT_CONFIG —
// a user-set key fully replaces its default (no per-key deep merge). All of
// DEFAULT_CONFIG's object-valued defaults are currently empty, so this is
// only observable when a user sets a key at all.
function loadConfig(repoRoot) {
  const configPath = path.join(repoRoot, '.claude', 'eghs.config.json');
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { ...DEFAULT_CONFIG };
    throw new Error(`[eghs] failed to read .claude/eghs.config.json: ${err.message}`);
  }

  let userConfig;
  try {
    userConfig = JSON.parse(raw);
  } catch (err) {
    throw new Error(`[eghs] failed to parse .claude/eghs.config.json: ${err.message}`);
  }

  return { ...DEFAULT_CONFIG, ...userConfig };
}

module.exports = { DEFAULT_CONFIG, loadConfig };
