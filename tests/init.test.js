'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const INIT_SCRIPT = path.join(__dirname, '..', 'hooks', 'init.js');

function mkTmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-init-'));
  return dir;
}

function run(args, cwd) {
  return execFileSync('node', [INIT_SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

test('eghs-init bootstraps schema_version and all P1 subdirs', () => {
  const repo = mkTmpRepo();
  run([], repo);
  const stateDir = path.join(repo, '.claude', 'state', 'eghs');
  assert.equal(fs.readFileSync(path.join(stateDir, 'schema_version'), 'utf8'), '1\n');
  for (const sub of ['locks', 'sessions', 'baselines', 'verify-logs', 'debug', 'tmp']) {
    assert.ok(fs.statSync(path.join(stateDir, sub)).isDirectory(), sub);
  }
});

test('eghs-init refuses to run twice without --repair', () => {
  const repo = mkTmpRepo();
  run([], repo);
  assert.throws(() => run([], repo));
});

test('eghs-init --repair is idempotent when everything is already healthy', () => {
  const repo = mkTmpRepo();
  run([], repo);
  assert.doesNotThrow(() => run(['--repair'], repo));
});

test('eghs-init --repair recreates a manually deleted subdir', () => {
  const repo = mkTmpRepo();
  run([], repo);
  const locksDir = path.join(repo, '.claude', 'state', 'eghs', 'locks');
  fs.rmSync(locksDir, { recursive: true, force: true });
  run(['--repair'], repo);
  assert.ok(fs.statSync(locksDir).isDirectory());
});
