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
  matcher_engine: 'picomatch',
  debug: true,
});

function loadConfig(repoRoot) {
  const configPath = path.join(repoRoot, '.claude', 'eghs.config.json');
  let userConfig = {};
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf8');
    try {
      userConfig = JSON.parse(raw);
    } catch (err) {
      throw new Error(`[eghs] failed to parse .claude/eghs.config.json: ${err.message}`);
    }
  }
  return { ...DEFAULT_CONFIG, ...userConfig };
}

module.exports = { DEFAULT_CONFIG, loadConfig };
