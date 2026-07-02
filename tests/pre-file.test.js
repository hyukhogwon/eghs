'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { keyHash } = require('../hooks/lib/canonical');
const { writePreFile, readPreFile, deletePreFile, gcPreFiles } = require('../hooks/lib/pre-file');

const SID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY = '/repo/src/mod.js';

function mkStateDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-pre-'));
  fs.mkdirSync(path.join(dir, 'pre'), { recursive: true });
  return dir;
}

test('writePreFile + readPreFile round-trip a write record with lazy pre/<sid>/ creation', () => {
  const stateDir = mkStateDir();
  writePreFile(stateDir, SID, KEY, 'write', { pre_sha: 'ab'.repeat(32), pretool_sid: SID });
  const p = path.join(stateDir, 'pre', SID, `${keyHash(KEY)}.write.json`);
  const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(onDisk.schema_version, 1);
  assert.equal(onDisk.pre_sha, 'ab'.repeat(32));
  assert.deepEqual(readPreFile(stateDir, SID, KEY, 'write'), onDisk);
});

test('read and write pre-files for the same key live side by side', () => {
  const stateDir = mkStateDir();
  writePreFile(stateDir, SID, KEY, 'read', { sha: '11'.repeat(32) });
  writePreFile(stateDir, SID, KEY, 'write', { pre_sha: null, pretool_sid: SID });
  assert.equal(readPreFile(stateDir, SID, KEY, 'read').sha, '11'.repeat(32));
  assert.equal(readPreFile(stateDir, SID, KEY, 'write').pre_sha, null);
});

test('readPreFile returns null for absent or corrupt records', () => {
  const stateDir = mkStateDir();
  assert.equal(readPreFile(stateDir, SID, KEY, 'read'), null);
  fs.mkdirSync(path.join(stateDir, 'pre', SID), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'pre', SID, `${keyHash(KEY)}.read.json`), '{ nope');
  assert.equal(readPreFile(stateDir, SID, KEY, 'read'), null);
});

test('deletePreFile removes the record and is a no-op when absent', () => {
  const stateDir = mkStateDir();
  writePreFile(stateDir, SID, KEY, 'read', { sha: null });
  deletePreFile(stateDir, SID, KEY, 'read');
  assert.equal(readPreFile(stateDir, SID, KEY, 'read'), null);
  assert.doesNotThrow(() => deletePreFile(stateDir, SID, KEY, 'read'));
});

test('an unknown kind throws from every entry point (programmer error, not silently mis-pathed)', () => {
  const stateDir = mkStateDir();
  assert.throws(() => writePreFile(stateDir, SID, KEY, 'edit', {}));
  assert.throws(() => readPreFile(stateDir, SID, KEY, 'edit'));
  assert.throws(() => deletePreFile(stateDir, SID, KEY, 'edit'));
});

test('a path-traversal sid cannot escape pre/ (write becomes a no-op)', () => {
  const stateDir = mkStateDir();
  const evil = path.join('..', '..', 'owned');
  assert.doesNotThrow(() => writePreFile(stateDir, evil, KEY, 'write', { pre_sha: null }));
  assert.ok(!fs.existsSync(path.join(path.dirname(stateDir), 'owned')));
});

test('gcPreFiles removes pre-files older than 24h and keeps fresh ones', () => {
  const stateDir = mkStateDir();
  writePreFile(stateDir, SID, KEY, 'read', { sha: null });
  writePreFile(stateDir, SID, '/repo/other.js', 'write', { pre_sha: null });
  const oldPath = path.join(stateDir, 'pre', SID, `${keyHash(KEY)}.read.json`);
  const old = new Date(Date.now() - 25 * 3600 * 1000);
  fs.utimesSync(oldPath, old, old);
  gcPreFiles(stateDir, { nowMs: Date.now() });
  assert.ok(!fs.existsSync(oldPath));
  assert.ok(fs.existsSync(path.join(stateDir, 'pre', SID, `${keyHash('/repo/other.js')}.write.json`)));
});

test('gcPreFiles tolerates a missing pre/ directory', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-pre-bare-'));
  assert.doesNotThrow(() => gcPreFiles(bare, { nowMs: Date.now() }));
});
