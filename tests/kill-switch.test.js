'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkKillSwitch } = require('../hooks/lib/kill-switch');

function mkTmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-kill-'));
}

test('inactive when neither file nor env is set', () => {
  const repo = mkTmpRepo();
  assert.deepEqual(checkKillSwitch({ repoRoot: repo, env: {} }), {
    active: false,
    reason: null,
  });
});

test('active via .claude/eghs-off regular file', () => {
  const repo = mkTmpRepo();
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'eghs-off'), '');
  assert.deepEqual(checkKillSwitch({ repoRoot: repo, env: {} }), {
    active: true,
    reason: 'file',
  });
});

test('active via EGHS_DISABLED=1 env', () => {
  const repo = mkTmpRepo();
  assert.deepEqual(
    checkKillSwitch({ repoRoot: repo, env: { EGHS_DISABLED: '1' } }),
    { active: true, reason: 'env' }
  );
});

test('inactive when eghs-off is a directory, not a regular file', () => {
  const repo = mkTmpRepo();
  fs.mkdirSync(path.join(repo, '.claude', 'eghs-off'), { recursive: true });
  assert.deepEqual(checkKillSwitch({ repoRoot: repo, env: {} }), {
    active: false,
    reason: null,
  });
});

test('inactive (not a crash) when eghs-off is a broken symlink', () => {
  const repo = mkTmpRepo();
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.symlinkSync(
    path.join(repo, '.claude', 'does-not-exist'),
    path.join(repo, '.claude', 'eghs-off')
  );
  assert.deepEqual(checkKillSwitch({ repoRoot: repo, env: {} }), {
    active: false,
    reason: null,
  });
});
