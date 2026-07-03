'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { keyHash } = require('../hooks/lib/canonical');
const {
  writeReadState,
  readReadState,
  writeFailedMarker,
  clearMarkersOnSuccess,
} = require('../hooks/lib/read-state');

const SID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEY = '/repo/src/file.js';

function mkStateDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-rstate-'));
  // Mirror eghs-init's pre-created root-level dirs the lib relies on.
  for (const sub of ['reads', path.join('reads', 'tmp'), 'failed', path.join('failed', 'tmp')]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

test('writeReadState + readReadState round-trip an R2 record under reads/<sha1(key)>.json', () => {
  const stateDir = mkStateDir();
  const r = writeReadState(stateDir, KEY, {
    file: KEY,
    sha: 'ab'.repeat(32),
    size: 10,
    ts_ms: 1780000000000,
    sid: SID_A,
    evidence: 'full_read',
  });
  assert.equal(r.ok, true);
  const onDisk = JSON.parse(
    fs.readFileSync(path.join(stateDir, 'reads', `${keyHash(KEY)}.json`), 'utf8')
  );
  assert.equal(onDisk.schema_version, 1);
  assert.equal(onDisk.evidence, 'full_read');
  assert.deepEqual(readReadState(stateDir, KEY), onDisk);
});

test('writeReadState pins schema_version:1 even if the record tries to override it', () => {
  const stateDir = mkStateDir();
  writeReadState(stateDir, KEY, { sid: SID_A, evidence: 'full_read', schema_version: 99 });
  assert.equal(readReadState(stateDir, KEY).schema_version, 1);
});

test('writeReadState reports {ok:false} instead of throwing when reads/ is unwritable', (t) => {
  if (process.getuid() === 0) return t.skip('root bypasses file modes');
  const stateDir = mkStateDir();
  fs.chmodSync(path.join(stateDir, 'reads'), 0o500);
  try {
    const r = writeReadState(stateDir, KEY, { sid: SID_A, evidence: 'full_read' });
    assert.equal(r.ok, false);
    assert.ok(r.error);
  } finally {
    fs.chmodSync(path.join(stateDir, 'reads'), 0o700);
  }
});

test('a path-traversal sid cannot escape failed/ (marker write becomes a no-op)', () => {
  const stateDir = mkStateDir();
  const evil = path.join('..', '..', 'owned');
  assert.doesNotThrow(() =>
    writeFailedMarker(stateDir, KEY, { sid: evil, tsMs: 1, reason: 'stale_read', sidScoped: true })
  );
  assert.ok(!fs.existsSync(path.join(stateDir, 'owned')));
  assert.ok(!fs.existsSync(path.join(path.dirname(stateDir), 'owned')));
});

test('clearMarkersOnSuccess tolerates a corrupt key-scoped marker (kept, no throw)', () => {
  const stateDir = mkStateDir();
  const p = path.join(stateDir, 'failed', `${keyHash(KEY)}.json`);
  fs.writeFileSync(p, '{ corrupt');
  assert.doesNotThrow(() => clearMarkersOnSuccess(stateDir, KEY, { sid: SID_A, leaseStartMs: 1 }));
  assert.ok(fs.existsSync(p));
});

test('readReadState returns null for an absent or corrupt record', () => {
  const stateDir = mkStateDir();
  assert.equal(readReadState(stateDir, KEY), null);
  fs.writeFileSync(path.join(stateDir, 'reads', `${keyHash(KEY)}.json`), '{ nope');
  assert.equal(readReadState(stateDir, KEY), null);
});

test('writeFailedMarker writes a key-scoped marker with the R2 marker schema', () => {
  const stateDir = mkStateDir();
  writeFailedMarker(stateDir, KEY, { sid: SID_A, tsMs: 123, reason: 'stale_read' });
  const marker = JSON.parse(
    fs.readFileSync(path.join(stateDir, 'failed', `${keyHash(KEY)}.json`), 'utf8')
  );
  assert.deepEqual(marker, {
    schema_version: 1,
    origin_sid: SID_A,
    ts_ms: 123,
    reason: 'stale_read',
  });
});

test('writeFailedMarker sidScoped lands in failed/<sid>/ with lazy dir creation', () => {
  const stateDir = mkStateDir();
  writeFailedMarker(stateDir, KEY, {
    sid: SID_A,
    tsMs: 5,
    reason: 'state_record_failed',
    sidScoped: true,
  });
  const p = path.join(stateDir, 'failed', SID_A, `${keyHash(KEY)}.json`);
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).origin_sid, SID_A);
});

test('writeFailedMarker is best-effort: an unwritable failed/ does not throw', (t) => {
  if (process.getuid() === 0) return t.skip('root bypasses file modes');
  const stateDir = mkStateDir();
  fs.chmodSync(path.join(stateDir, 'failed'), 0o500);
  try {
    assert.doesNotThrow(() =>
      writeFailedMarker(stateDir, KEY, { sid: SID_A, tsMs: 1, reason: 'state_record_failed' })
    );
  } finally {
    fs.chmodSync(path.join(stateDir, 'failed'), 0o700);
  }
});

test('clearMarkersOnSuccess removes own-sid key-scoped and sid-scoped markers', () => {
  const stateDir = mkStateDir();
  writeFailedMarker(stateDir, KEY, { sid: SID_A, tsMs: 10, reason: 'stale_read' });
  writeFailedMarker(stateDir, KEY, { sid: SID_A, tsMs: 10, reason: 'stale_read', sidScoped: true });
  clearMarkersOnSuccess(stateDir, KEY, { sid: SID_A, leaseStartMs: 1 });
  assert.ok(!fs.existsSync(path.join(stateDir, 'failed', `${keyHash(KEY)}.json`)));
  assert.ok(!fs.existsSync(path.join(stateDir, 'failed', SID_A, `${keyHash(KEY)}.json`)));
});

test("clearMarkersOnSuccess keeps another session's marker that is newer than our lease start", () => {
  const stateDir = mkStateDir();
  writeFailedMarker(stateDir, KEY, { sid: SID_B, tsMs: 2000, reason: 'overwrite_race' });
  clearMarkersOnSuccess(stateDir, KEY, { sid: SID_A, leaseStartMs: 1000 });
  assert.ok(fs.existsSync(path.join(stateDir, 'failed', `${keyHash(KEY)}.json`)));
});

test("clearMarkersOnSuccess removes another session's marker that predates our lease start", () => {
  const stateDir = mkStateDir();
  writeFailedMarker(stateDir, KEY, { sid: SID_B, tsMs: 500, reason: 'overwrite_race' });
  clearMarkersOnSuccess(stateDir, KEY, { sid: SID_A, leaseStartMs: 1000 });
  assert.ok(!fs.existsSync(path.join(stateDir, 'failed', `${keyHash(KEY)}.json`)));
});

test('clearMarkersOnSuccess is a no-op without markers (no throw)', () => {
  const stateDir = mkStateDir();
  assert.doesNotThrow(() => clearMarkersOnSuccess(stateDir, KEY, { sid: SID_A, leaseStartMs: 1 }));
});

test("clearMarkersOnSuccess does not touch another sid's sid-scoped marker", () => {
  const stateDir = mkStateDir();
  writeFailedMarker(stateDir, KEY, { sid: SID_B, tsMs: 500, reason: 'stale_read', sidScoped: true });
  clearMarkersOnSuccess(stateDir, KEY, { sid: SID_A, leaseStartMs: 1000 });
  assert.ok(fs.existsSync(path.join(stateDir, 'failed', SID_B, `${keyHash(KEY)}.json`)));
});

test('readReadState returns null for a JSON-array record (schema-shaped objects only)', () => {
  const stateDir = mkStateDir();
  fs.writeFileSync(path.join(stateDir, 'reads', `${keyHash(KEY)}.json`), '[1,2,3]');
  assert.equal(readReadState(stateDir, KEY), null);
});

test('writeFailedMarker sidScoped with a null sid writes nothing (no key-scoped aliasing)', () => {
  const stateDir = mkStateDir();
  writeFailedMarker(stateDir, KEY, { sid: null, tsMs: 1, reason: 'stale_read', sidScoped: true });
  assert.ok(!fs.existsSync(path.join(stateDir, 'failed', `${keyHash(KEY)}.json`)));
});

test("clearMarkersOnSuccess with a null sid cannot alias into the key-scoped marker", () => {
  const stateDir = mkStateDir();
  writeFailedMarker(stateDir, KEY, { sid: SID_B, tsMs: 2000, reason: 'overwrite_race' });
  clearMarkersOnSuccess(stateDir, KEY, { sid: null, leaseStartMs: 1000 });
  assert.ok(fs.existsSync(path.join(stateDir, 'failed', `${keyHash(KEY)}.json`)));
});

test('clearMarkersOnSuccess keeps a foreign marker whose ts_ms is corrupt (null) — fail-closed', () => {
  const stateDir = mkStateDir();
  const p = path.join(stateDir, 'failed', `${keyHash(KEY)}.json`);
  fs.writeFileSync(
    p,
    JSON.stringify({ schema_version: 1, origin_sid: SID_B, ts_ms: null, reason: 'stale_read' })
  );
  clearMarkersOnSuccess(stateDir, KEY, { sid: SID_A, leaseStartMs: 1000 });
  assert.ok(fs.existsSync(p));
});

test('clearMarkersOnSuccess keeps a foreign marker at exactly leaseStartMs (strict <)', () => {
  const stateDir = mkStateDir();
  writeFailedMarker(stateDir, KEY, { sid: SID_B, tsMs: 1000, reason: 'overwrite_race' });
  clearMarkersOnSuccess(stateDir, KEY, { sid: SID_A, leaseStartMs: 1000 });
  assert.ok(fs.existsSync(path.join(stateDir, 'failed', `${keyHash(KEY)}.json`)));
});

test('a path-traversal sid cannot unlink outside failed/ on the CLEAR path', () => {
  const stateDir = mkStateDir();
  const outside = path.join(stateDir, `${keyHash(KEY)}.json`); // parent of failed/
  fs.writeFileSync(outside, 'do-not-unlink');
  clearMarkersOnSuccess(stateDir, KEY, { sid: '..', leaseStartMs: 1 });
  assert.ok(fs.existsSync(outside));
});
