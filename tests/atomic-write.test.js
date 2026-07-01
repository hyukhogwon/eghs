'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { atomicWriteFile } = require('../hooks/lib/atomic-write');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-atomic-'));
}

test('atomicWriteFile creates the destination file with exact contents', () => {
  const dir = mkTmpDir();
  const dest = path.join(dir, 'sub', 'schema_version');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  atomicWriteFile(dest, '1\n');
  assert.equal(fs.readFileSync(dest, 'utf8'), '1\n');
});

test('atomicWriteFile leaves no leftover tmp files after success', () => {
  const dir = mkTmpDir();
  const dest = path.join(dir, 'schema_version');
  atomicWriteFile(dest, '1\n');
  const tmpDir = path.join(dir, 'tmp');
  assert.ok(!fs.existsSync(tmpDir) || fs.readdirSync(tmpDir).length === 0);
});

test('atomicWriteFile overwrites an existing file atomically', () => {
  const dir = mkTmpDir();
  const dest = path.join(dir, 'schema_version');
  atomicWriteFile(dest, '1\n');
  atomicWriteFile(dest, '2\n');
  assert.equal(fs.readFileSync(dest, 'utf8'), '2\n');
});

test('atomicWriteFile uses a fresh tmp filename per call (monotonic seq)', () => {
  const dir = mkTmpDir();
  atomicWriteFile(path.join(dir, 'a.json'), '{}');
  atomicWriteFile(path.join(dir, 'b.json'), '{}');
  assert.equal(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'), '{}');
  assert.equal(fs.readFileSync(path.join(dir, 'b.json'), 'utf8'), '{}');
});

test('atomicWriteFile self-heals when the destination is a stray directory (EISDIR)', () => {
  const dir = mkTmpDir();
  const dest = path.join(dir, 'schema_version');
  fs.mkdirSync(dest); // simulates a corrupted state dir entry
  atomicWriteFile(dest, '1\n');
  assert.equal(fs.readFileSync(dest, 'utf8'), '1\n');
});
