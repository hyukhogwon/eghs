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

test('eghs-init bootstraps the P3 state-writer subdirs', () => {
  const repo = mkTmpRepo();
  run([], repo);
  const stateDir = path.join(repo, '.claude', 'state', 'eghs');
  for (const sub of ['reads', path.join('reads', 'tmp'), 'failed', path.join('failed', 'tmp'), 'pre']) {
    assert.ok(fs.statSync(path.join(stateDir, sub)).isDirectory(), sub);
  }
});

test('eghs-init writes fs-info.json (boolean caseless_fs) and removes the probe files', () => {
  const repo = mkTmpRepo();
  run([], repo);
  const stateDir = path.join(repo, '.claude', 'state', 'eghs');
  const info = JSON.parse(fs.readFileSync(path.join(stateDir, 'fs-info.json'), 'utf8'));
  assert.equal(info.schema_version, 1);
  assert.equal(typeof info.caseless_fs, 'boolean');
  assert.equal(typeof info.ts_ms, 'number');
  assert.ok(!fs.existsSync(path.join(stateDir, '.cs-probe')));
  assert.ok(!fs.existsSync(path.join(stateDir, '.CS-PROBE')));
});

test('eghs-init --repair recreates a missing fs-info.json', () => {
  const repo = mkTmpRepo();
  run([], repo);
  const infoPath = path.join(repo, '.claude', 'state', 'eghs', 'fs-info.json');
  fs.rmSync(infoPath);
  run(['--repair'], repo);
  assert.equal(typeof JSON.parse(fs.readFileSync(infoPath, 'utf8')).caseless_fs, 'boolean');
});

test('eghs-init --repair keeps a healthy fs-info.json untouched (no re-probe)', () => {
  const repo = mkTmpRepo();
  run([], repo);
  const infoPath = path.join(repo, '.claude', 'state', 'eghs', 'fs-info.json');
  const healthy = fs.readFileSync(infoPath, 'utf8'); // real probe output = healthy v2
  run(['--repair'], repo);
  assert.equal(fs.readFileSync(infoPath, 'utf8'), healthy);
});

test('eghs-init --repair re-probes a legacy pre-R20 v1 fs-info.json (unhealthy cache, PRD Case 4)', () => {
  const repo = mkTmpRepo();
  run([], repo);
  const infoPath = path.join(repo, '.claude', 'state', 'eghs', 'fs-info.json');
  fs.writeFileSync(infoPath, JSON.stringify({ schema_version: 1, caseless_fs: false, ts_ms: 42 }));
  run(['--repair'], repo);
  const body = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
  assert.equal(body.flock_ok, true);
  assert.equal(typeof body.fs_st_dev, 'number');
});

test('eghs-init survives stale probe leftovers from a crashed previous run', () => {
  const repo = mkTmpRepo();
  const stateDir = path.join(repo, '.claude', 'state', 'eghs');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '.CS-PROBE'), '');
  run([], repo);
  assert.ok(!fs.existsSync(path.join(stateDir, '.CS-PROBE')));
  // Verdict must match a clean-room probe, not be poisoned by the leftover.
  const fresh = mkTmpRepo();
  run([], fresh);
  const verdict = (repo2) =>
    JSON.parse(
      fs.readFileSync(path.join(repo2, '.claude', 'state', 'eghs', 'fs-info.json'), 'utf8')
    ).caseless_fs;
  assert.equal(verdict(repo), verdict(fresh));
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

test('eghs-init does not leak .init.lock after a successful run', () => {
  const repo = mkTmpRepo();
  run([], repo);
  assert.ok(!fs.existsSync(path.join(repo, '.claude', 'state', 'eghs', '.init.lock')));
});

test('eghs-init does not leak .init.lock when it refuses to run twice', () => {
  const repo = mkTmpRepo();
  run([], repo);
  assert.throws(() => run([], repo));
  assert.ok(!fs.existsSync(path.join(repo, '.claude', 'state', 'eghs', '.init.lock')));
});

test('eghs-init refuses to run while another .init.lock is held (concurrent bootstrap)', () => {
  const repo = mkTmpRepo();
  const stateDir = path.join(repo, '.claude', 'state', 'eghs');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '.init.lock'), '');
  assert.throws(() => run([], repo));
  // schema_version must not have been written while the lock was held.
  assert.ok(!fs.existsSync(path.join(stateDir, 'schema_version')));
});
