'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readSchemaVersion } = require('../hooks/lib/schema');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-schema-'));
}

test('readSchemaVersion: not_initialized when state dir is absent', () => {
  const dir = mkTmpDir();
  const result = readSchemaVersion(path.join(dir, 'does-not-exist'));
  assert.deepEqual(result, { status: 'not_initialized' });
});

test('readSchemaVersion: not_initialized when schema_version file is absent', () => {
  const dir = mkTmpDir();
  const result = readSchemaVersion(dir);
  assert.deepEqual(result, { status: 'not_initialized' });
});

test('readSchemaVersion: ok with parsed integer for a valid file', () => {
  const dir = mkTmpDir();
  fs.writeFileSync(path.join(dir, 'schema_version'), '1\n');
  assert.deepEqual(readSchemaVersion(dir), { status: 'ok', version: 1 });
});

test('readSchemaVersion: invalid on leading zero', () => {
  const dir = mkTmpDir();
  fs.writeFileSync(path.join(dir, 'schema_version'), '01\n');
  assert.deepEqual(readSchemaVersion(dir), { status: 'invalid' });
});

test('readSchemaVersion: invalid on missing trailing newline', () => {
  const dir = mkTmpDir();
  fs.writeFileSync(path.join(dir, 'schema_version'), '1');
  assert.deepEqual(readSchemaVersion(dir), { status: 'invalid' });
});

test('readSchemaVersion: invalid when file exceeds 32 bytes', () => {
  const dir = mkTmpDir();
  fs.writeFileSync(path.join(dir, 'schema_version'), '1'.repeat(40) + '\n');
  assert.deepEqual(readSchemaVersion(dir), { status: 'invalid' });
});

test('readSchemaVersion: invalid when path is a directory, not a regular file', () => {
  const dir = mkTmpDir();
  fs.mkdirSync(path.join(dir, 'schema_version'));
  assert.deepEqual(readSchemaVersion(dir), { status: 'invalid' });
});
