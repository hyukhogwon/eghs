'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { keyHash } = require('../hooks/lib/canonical');
const {
  writePreFile,
  readPreFile,
  deletePreFile,
  gcPreFiles,
  normalizeToolUseId,
  listPreFilesForHash,
} = require('../hooks/lib/pre-file');

const SID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY = '/repo/src/mod.js';
const TUID = 'toolu_01AbCdEfGh';

function mkStateDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-pre-'));
  fs.mkdirSync(path.join(dir, 'pre'), { recursive: true });
  return dir;
}

test('writePreFile + readPreFile round-trip a write record with lazy pre/<sid>/ creation', () => {
  const stateDir = mkStateDir();
  writePreFile(stateDir, SID, KEY, TUID, 'write', { pre_sha: 'ab'.repeat(32), pretool_sid: SID });
  const p = path.join(stateDir, 'pre', SID, `${keyHash(KEY)}.${TUID}.write.json`);
  const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(onDisk.schema_version, 1);
  assert.equal(onDisk.pre_sha, 'ab'.repeat(32));
  assert.deepEqual(readPreFile(stateDir, SID, KEY, TUID, 'write'), onDisk);
});

test('parallel tool calls on the same key keep distinct pre-records (tool_use_id suffix)', () => {
  const stateDir = mkStateDir();
  writePreFile(stateDir, SID, KEY, 'toolu_A', 'write', { pre_sha: '11'.repeat(32), pretool_sid: SID });
  writePreFile(stateDir, SID, KEY, 'toolu_B', 'write', { pre_sha: '22'.repeat(32), pretool_sid: SID });
  assert.equal(readPreFile(stateDir, SID, KEY, 'toolu_A', 'write').pre_sha, '11'.repeat(32));
  assert.equal(readPreFile(stateDir, SID, KEY, 'toolu_B', 'write').pre_sha, '22'.repeat(32));
  deletePreFile(stateDir, SID, KEY, 'toolu_A', 'write');
  assert.equal(readPreFile(stateDir, SID, KEY, 'toolu_A', 'write'), null);
  assert.equal(readPreFile(stateDir, SID, KEY, 'toolu_B', 'write').pre_sha, '22'.repeat(32));
});

test('read and write pre-files for the same key live side by side', () => {
  const stateDir = mkStateDir();
  writePreFile(stateDir, SID, KEY, TUID, 'read', { sha: '11'.repeat(32) });
  writePreFile(stateDir, SID, KEY, TUID, 'write', { pre_sha: null, pretool_sid: SID });
  assert.equal(readPreFile(stateDir, SID, KEY, TUID, 'read').sha, '11'.repeat(32));
  assert.equal(readPreFile(stateDir, SID, KEY, TUID, 'write').pre_sha, null);
});

test('readPreFile returns null for absent or corrupt records', () => {
  const stateDir = mkStateDir();
  assert.equal(readPreFile(stateDir, SID, KEY, TUID, 'read'), null);
  fs.mkdirSync(path.join(stateDir, 'pre', SID), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'pre', SID, `${keyHash(KEY)}.${TUID}.read.json`), '{ nope');
  assert.equal(readPreFile(stateDir, SID, KEY, TUID, 'read'), null);
});

test('deletePreFile removes the record and is a no-op when absent', () => {
  const stateDir = mkStateDir();
  writePreFile(stateDir, SID, KEY, TUID, 'read', { sha: null });
  deletePreFile(stateDir, SID, KEY, TUID, 'read');
  assert.equal(readPreFile(stateDir, SID, KEY, TUID, 'read'), null);
  assert.doesNotThrow(() => deletePreFile(stateDir, SID, KEY, TUID, 'read'));
});

test('an unknown kind throws from every entry point (programmer error, not silently mis-pathed)', () => {
  const stateDir = mkStateDir();
  assert.throws(() => writePreFile(stateDir, SID, KEY, TUID, 'edit', {}));
  assert.throws(() => readPreFile(stateDir, SID, KEY, TUID, 'edit'));
  assert.throws(() => deletePreFile(stateDir, SID, KEY, TUID, 'edit'));
});

test('a path-traversal sid cannot escape pre/ (write becomes a no-op)', () => {
  const stateDir = mkStateDir();
  const evil = path.join('..', '..', 'owned');
  assert.doesNotThrow(() => writePreFile(stateDir, evil, KEY, TUID, 'write', { pre_sha: null }));
  assert.ok(!fs.existsSync(path.join(path.dirname(stateDir), 'owned')));
});

test('a path-traversal tool_use_id is normalized away, never a path segment', () => {
  const stateDir = mkStateDir();
  const evil = `..${path.sep}..${path.sep}owned`;
  assert.equal(normalizeToolUseId(evil), 'none');
  writePreFile(stateDir, SID, KEY, normalizeToolUseId(evil), 'write', { pre_sha: null, pretool_sid: SID });
  assert.ok(fs.existsSync(path.join(stateDir, 'pre', SID, `${keyHash(KEY)}.none.write.json`)));
  assert.ok(!fs.existsSync(path.join(path.dirname(stateDir), 'owned')));
});

test('normalizeToolUseId passes real ids through and falls back to "none"', () => {
  assert.equal(normalizeToolUseId('toolu_01PFLaaGEgTNNhE49Bq2tnWj'), 'toolu_01PFLaaGEgTNNhE49Bq2tnWj');
  assert.equal(normalizeToolUseId(undefined), 'none');
  assert.equal(normalizeToolUseId(''), 'none');
  assert.equal(normalizeToolUseId(42), 'none');
  assert.equal(normalizeToolUseId('has space'), 'none');
  assert.equal(normalizeToolUseId('dot.dot'), 'none');
});

test('listPreFilesForHash finds every tool_use_id variant for a key hash, one kind only', () => {
  const stateDir = mkStateDir();
  const hash = keyHash(KEY);
  writePreFile(stateDir, SID, KEY, 'toolu_A', 'write', { pre_sha: null, pretool_sid: SID });
  writePreFile(stateDir, SID, KEY, 'toolu_B', 'write', { pre_sha: null, pretool_sid: SID });
  writePreFile(stateDir, SID, KEY, 'toolu_C', 'read', { sha: null });
  writePreFile(stateDir, SID, '/repo/other.js', 'toolu_D', 'write', { pre_sha: null, pretool_sid: SID });
  const found = listPreFilesForHash(stateDir, SID, hash, 'write');
  assert.deepEqual(found.map((f) => f.toolUseId).sort(), ['toolu_A', 'toolu_B']);
  for (const f of found) {
    assert.ok(fs.existsSync(f.path));
    assert.ok(f.path.includes(`${hash}.`));
  }
});

test('listPreFilesForHash returns [] for an absent sid dir and never matches other hashes', () => {
  const stateDir = mkStateDir();
  assert.deepEqual(listPreFilesForHash(stateDir, SID, keyHash(KEY), 'write'), []);
  writePreFile(stateDir, SID, KEY, 'toolu_A', 'write', { pre_sha: null, pretool_sid: SID });
  assert.deepEqual(listPreFilesForHash(stateDir, SID, keyHash('/repo/unrelated.js'), 'write'), []);
});

test('gcPreFiles removes pre-files older than 24h and keeps fresh ones', () => {
  const stateDir = mkStateDir();
  writePreFile(stateDir, SID, KEY, TUID, 'read', { sha: null });
  writePreFile(stateDir, SID, '/repo/other.js', TUID, 'write', { pre_sha: null });
  const oldPath = path.join(stateDir, 'pre', SID, `${keyHash(KEY)}.${TUID}.read.json`);
  const old = new Date(Date.now() - 25 * 3600 * 1000);
  fs.utimesSync(oldPath, old, old);
  gcPreFiles(stateDir, { nowMs: Date.now() });
  assert.ok(!fs.existsSync(oldPath));
  assert.ok(fs.existsSync(path.join(stateDir, 'pre', SID, `${keyHash('/repo/other.js')}.${TUID}.write.json`)));
});

test('gcPreFiles tolerates a missing pre/ directory', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-pre-bare-'));
  assert.doesNotThrow(() => gcPreFiles(bare, { nowMs: Date.now() }));
});

// ---- P4 finale: empty sid dirs must not outlive their files (§G5) ----

test('gcPreFiles rmdirs an empty pre/<sid>/ (and its tmp/) once both are 24h stale', () => {
  const stateDir = mkStateDir();
  const sidDir = path.join(stateDir, 'pre', SID);
  fs.mkdirSync(path.join(sidDir, 'tmp'), { recursive: true });
  const old = Date.now() / 1000 - 48 * 3600;
  fs.utimesSync(path.join(sidDir, 'tmp'), old, old);
  fs.utimesSync(sidDir, old, old);
  gcPreFiles(stateDir, { nowMs: Date.now() });
  assert.ok(!fs.existsSync(sidDir));
});

test('gcPreFiles keeps a freshly-touched empty sid dir (live-session write window)', () => {
  const stateDir = mkStateDir();
  const sidDir = path.join(stateDir, 'pre', SID);
  fs.mkdirSync(path.join(sidDir, 'tmp'), { recursive: true });
  gcPreFiles(stateDir, { nowMs: Date.now() });
  assert.ok(fs.existsSync(sidDir), 'a dir touched moments ago may be mid-write');
});

test('gcPreFiles never removes a sid dir that still holds a fresh record', () => {
  const stateDir = mkStateDir();
  const sidDir = path.join(stateDir, 'pre', SID);
  fs.mkdirSync(sidDir, { recursive: true });
  fs.writeFileSync(path.join(sidDir, 'aa.toolu_X.write.json'), '{}');
  const old = Date.now() / 1000 - 48 * 3600;
  fs.utimesSync(sidDir, old, old);
  gcPreFiles(stateDir, { nowMs: Date.now() });
  assert.ok(fs.existsSync(path.join(sidDir, 'aa.toolu_X.write.json')));
});
