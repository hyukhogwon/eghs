'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readFsInfo } = require('../hooks/lib/fs-info');

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
