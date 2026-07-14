'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readFsInfo, probeAndWriteFsInfo, liveAnchor } = require('../hooks/lib/fs-info');

function mkStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-fsinfo-'));
}

// A body that readFsInfo must accept in the dir it is written to: anchors
// come from the live filesystem, so they always match.
function healthyBody(dir, overrides = {}) {
  const anchor = liveAnchor(dir);
  return JSON.stringify({
    schema_version: 1,
    caseless_fs: true,
    flock_ok: true,
    fs_st_dev: anchor.fsStDev,
    fs_statfs_id: anchor.fsStatfsId,
    ts_ms: 42,
    ...overrides,
  });
}

test('readFsInfo reports missing when fs-info.json does not exist', () => {
  assert.deepEqual(readFsInfo(mkStateDir()), { status: 'missing' });
});

test('readFsInfo reports unhealthy on malformed JSON', () => {
  const dir = mkStateDir();
  fs.writeFileSync(path.join(dir, 'fs-info.json'), '{ not json');
  assert.equal(readFsInfo(dir).status, 'unhealthy');
});

test('readFsInfo reports unhealthy when caseless_fs is not a boolean', () => {
  const dir = mkStateDir();
  fs.writeFileSync(path.join(dir, 'fs-info.json'), healthyBody(dir, { caseless_fs: 'yes' }));
  assert.equal(readFsInfo(dir).status, 'unhealthy');
});

test('readFsInfo reports unhealthy (not a crash) when the file contains JSON null', () => {
  const dir = mkStateDir();
  fs.writeFileSync(path.join(dir, 'fs-info.json'), 'null');
  assert.equal(readFsInfo(dir).status, 'unhealthy');
});

test('readFsInfo returns ok plus the cached caseless flag for a healthy v2 body', () => {
  const dir = mkStateDir();
  fs.writeFileSync(path.join(dir, 'fs-info.json'), healthyBody(dir));
  assert.deepEqual(readFsInfo(dir), { status: 'ok', caseless: true });
});

test('readFsInfo rejects an unknown schema_version', () => {
  const dir = mkStateDir();
  fs.writeFileSync(path.join(dir, 'fs-info.json'), healthyBody(dir, { schema_version: 2 }));
  assert.equal(readFsInfo(dir).status, 'unhealthy');
});

test('readFsInfo treats a pre-R20 v1 body (no flock fields) as unhealthy legacy cache', () => {
  const dir = mkStateDir();
  fs.writeFileSync(
    path.join(dir, 'fs-info.json'),
    JSON.stringify({ schema_version: 1, caseless_fs: false, ts_ms: 42 })
  );
  const r = readFsInfo(dir);
  assert.equal(r.status, 'unhealthy');
  assert.match(r.reason, /missing_fields/);
});

test('readFsInfo reports unhealthy when flock_ok is not exactly true', () => {
  const dir = mkStateDir();
  fs.writeFileSync(path.join(dir, 'fs-info.json'), healthyBody(dir, { flock_ok: false }));
  assert.equal(readFsInfo(dir).status, 'unhealthy');
  fs.writeFileSync(path.join(dir, 'fs-info.json'), healthyBody(dir, { flock_ok: 'true' }));
  assert.equal(readFsInfo(dir).status, 'unhealthy');
});

test('readFsInfo detects an FS move via anchor mismatch (PRD §R6 #3.3)', () => {
  const dir = mkStateDir();
  fs.writeFileSync(path.join(dir, 'fs-info.json'), healthyBody(dir, { fs_st_dev: -1 }));
  const byDev = readFsInfo(dir);
  assert.equal(byDev.status, 'unhealthy');
  assert.match(byDev.reason, /anchor/);
  fs.writeFileSync(path.join(dir, 'fs-info.json'), healthyBody(dir, { fs_statfs_id: 'linux:0' }));
  assert.equal(readFsInfo(dir).status, 'unhealthy');
});

test('readFsInfo reports unhealthy on an oversized file (>4KB, never parsed)', () => {
  const dir = mkStateDir();
  fs.writeFileSync(path.join(dir, 'fs-info.json'), `{"pad":"${'x'.repeat(5000)}"}`);
  const r = readFsInfo(dir);
  assert.equal(r.status, 'unhealthy');
  assert.match(r.reason, /size/);
});

test('readFsInfo reports unhealthy when fs-info.json is not a regular file', () => {
  const dir = mkStateDir();
  fs.mkdirSync(path.join(dir, 'fs-info.json'));
  const r = readFsInfo(dir);
  assert.equal(r.status, 'unhealthy');
  assert.match(r.reason, /regular/);
});

test('readFsInfo reports unhealthy on an unreadable file (EACCES)', () => {
  if (process.getuid && process.getuid() === 0) return; // root ignores modes
  const dir = mkStateDir();
  const p = path.join(dir, 'fs-info.json');
  fs.writeFileSync(p, healthyBody(dir));
  fs.chmodSync(p, 0o000);
  try {
    assert.equal(readFsInfo(dir).status, 'unhealthy');
  } finally {
    fs.chmodSync(p, 0o600);
  }
});

test('liveAnchor returns a numeric st_dev and a platform-tagged statfs id', () => {
  const anchor = liveAnchor(mkStateDir());
  assert.equal(typeof anchor.fsStDev, 'number');
  assert.match(anchor.fsStatfsId, /^(darwin|linux|posix:[a-z0-9]+):\d+$/);
});

test('probeAndWriteFsInfo writes a v2 cache readFsInfo accepts and cleans its probes', () => {
  const dir = mkStateDir();
  const caseless = probeAndWriteFsInfo(dir, 42);
  assert.equal(typeof caseless, 'boolean');
  assert.deepEqual(readFsInfo(dir), { status: 'ok', caseless });
  const body = JSON.parse(fs.readFileSync(path.join(dir, 'fs-info.json'), 'utf8'));
  assert.equal(body.flock_ok, true);
  assert.equal(typeof body.fs_st_dev, 'number');
  assert.equal(typeof body.fs_statfs_id, 'string');
  assert.ok(!fs.existsSync(path.join(dir, '.cs-probe')));
  assert.ok(!fs.existsSync(path.join(dir, '.CS-PROBE')));
  // flock probe temp cleaned up too
  const tmp = path.join(dir, 'tmp');
  assert.ok(!fs.existsSync(tmp) || fs.readdirSync(tmp).every((n) => !n.startsWith('flock-probe.')));
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
