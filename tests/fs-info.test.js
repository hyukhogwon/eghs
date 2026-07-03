'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readFsInfo, probeAndWriteFsInfo } = require('../hooks/lib/fs-info');

function mkStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-fsinfo-'));
}

test('readFsInfo reports missing when fs-info.json does not exist', () => {
  assert.deepEqual(readFsInfo(mkStateDir()), { status: 'missing' });
});

test('readFsInfo reports invalid on malformed JSON', () => {
  const dir = mkStateDir();
  fs.writeFileSync(path.join(dir, 'fs-info.json'), '{ not json');
  assert.deepEqual(readFsInfo(dir), { status: 'invalid' });
});

test('readFsInfo reports invalid when caseless_fs is not a boolean', () => {
  const dir = mkStateDir();
  fs.writeFileSync(path.join(dir, 'fs-info.json'), JSON.stringify({ schema_version: 1, caseless_fs: 'yes' }));
  assert.deepEqual(readFsInfo(dir), { status: 'invalid' });
});

test('readFsInfo reports invalid (not a crash) when the file contains JSON null', () => {
  const dir = mkStateDir();
  fs.writeFileSync(path.join(dir, 'fs-info.json'), 'null');
  assert.deepEqual(readFsInfo(dir), { status: 'invalid' });
});

test('readFsInfo returns ok plus the cached caseless flag', () => {
  const dir = mkStateDir();
  fs.writeFileSync(
    path.join(dir, 'fs-info.json'),
    JSON.stringify({ schema_version: 1, caseless_fs: true, ts_ms: 42 })
  );
  assert.deepEqual(readFsInfo(dir), { status: 'ok', caseless: true });
});

test('readFsInfo rejects an unknown schema_version', () => {
  const dir = mkStateDir();
  fs.writeFileSync(
    path.join(dir, 'fs-info.json'),
    JSON.stringify({ schema_version: 2, caseless_fs: true, ts_ms: 42 })
  );
  assert.deepEqual(readFsInfo(dir), { status: 'invalid' });
});

test('readFsInfo reports invalid on an unreadable file (EACCES)', () => {
  if (process.getuid && process.getuid() === 0) return; // root ignores modes
  const dir = mkStateDir();
  const p = path.join(dir, 'fs-info.json');
  fs.writeFileSync(p, JSON.stringify({ schema_version: 1, caseless_fs: false }));
  fs.chmodSync(p, 0o000);
  try {
    assert.deepEqual(readFsInfo(dir), { status: 'invalid' });
  } finally {
    fs.chmodSync(p, 0o600);
  }
});

test('probeAndWriteFsInfo writes a cache readFsInfo accepts and cleans its probes', () => {
  const dir = mkStateDir();
  const caseless = probeAndWriteFsInfo(dir, 42);
  assert.equal(typeof caseless, 'boolean');
  assert.deepEqual(readFsInfo(dir), { status: 'ok', caseless });
  assert.ok(!fs.existsSync(path.join(dir, '.cs-probe')));
  assert.ok(!fs.existsSync(path.join(dir, '.CS-PROBE')));
});

test('probeAndWriteFsInfo survives leftover probe files of both spellings', () => {
  const dir = mkStateDir();
  fs.writeFileSync(path.join(dir, '.cs-probe'), 'stale');
  try {
    fs.writeFileSync(path.join(dir, '.CS-PROBE'), 'stale'); // same file on caseless FS
  } catch {
    // EEXIST-class on some setups: leftover state is the point either way
  }
  assert.equal(typeof probeAndWriteFsInfo(dir, 1), 'boolean');
  assert.equal(readFsInfo(dir).status, 'ok');
});

test('probeAndWriteFsInfo survives a probe-named DIRECTORY left by tampering', () => {
  const dir = mkStateDir();
  fs.mkdirSync(path.join(dir, '.cs-probe'));
  fs.writeFileSync(path.join(dir, '.cs-probe', 'junk'), 'x');
  assert.equal(typeof probeAndWriteFsInfo(dir, 1), 'boolean');
  assert.equal(readFsInfo(dir).status, 'ok');
});
