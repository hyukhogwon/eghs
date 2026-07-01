'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig, DEFAULT_CONFIG } = require('../hooks/lib/config');

function mkTmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-config-'));
}

test('loadConfig returns defaults when no config file exists', () => {
  const repo = mkTmpRepo();
  assert.deepEqual(loadConfig(repo), DEFAULT_CONFIG);
});

test('loadConfig merges user config onto defaults without dropping untouched keys', () => {
  const repo = mkTmpRepo();
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, '.claude', 'eghs.config.json'),
    JSON.stringify({
      verification_commands: { typecheck: 'tsc --noEmit' },
      verification_timeout_seconds: 20,
    })
  );
  const config = loadConfig(repo);
  assert.equal(config.verification_timeout_seconds, 20);
  assert.equal(config.verification_parallel, true); // untouched default preserved
  assert.deepEqual(config.verification_commands, { typecheck: 'tsc --noEmit' });
});

test('loadConfig throws a descriptive error on invalid JSON', () => {
  const repo = mkTmpRepo();
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'eghs.config.json'), '{ not json');
  assert.throws(() => loadConfig(repo), /eghs\.config\.json/);
});
