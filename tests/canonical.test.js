'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { canonicalKey, keyHash, sha256File } = require('../hooks/lib/canonical');

function mkDir() {
  // realpath the tmpdir itself: on macOS /tmp -> /private/tmp, and tests
  // must compare against fully resolved paths.
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-canon-')));
}

test('canonicalKey resolves symlinks and . / .. segments via realpath', () => {
  const dir = mkDir();
  const real = path.join(dir, 'real.txt');
  fs.writeFileSync(real, 'x');
  const link = path.join(dir, 'link.txt');
  fs.symlinkSync(real, link);
  const viaDots = path.join(dir, 'sub', '..', 'link.txt');
  fs.mkdirSync(path.join(dir, 'sub'));
  assert.deepEqual(canonicalKey(link, { caseless: false }), { ok: true, key: real });
  assert.deepEqual(canonicalKey(viaDots, { caseless: false }), { ok: true, key: real });
});

test('canonicalKey lowercases the resolved path only on a caseless fs', () => {
  const dir = mkDir();
  const file = path.join(dir, 'MixedCase.TXT');
  fs.writeFileSync(file, 'x');
  const resolved = fs.realpathSync(file);
  assert.deepEqual(canonicalKey(file, { caseless: true }), { ok: true, key: resolved.toLowerCase() });
  assert.deepEqual(canonicalKey(file, { caseless: false }), { ok: true, key: resolved });
});

test('canonicalKey classifies a missing path as FILE_UNREADABLE with missing:true', () => {
  const dir = mkDir();
  const r = canonicalKey(path.join(dir, 'nope.txt'), { caseless: false });
  assert.deepEqual(r, { ok: false, code: 'FILE_UNREADABLE', missing: true });
});

test('keyHash is the hex sha1 of the canonical key', () => {
  const key = '/some/canonical/path.js';
  const expected = crypto.createHash('sha1').update(key).digest('hex');
  assert.equal(keyHash(key), expected);
});

test('sha256File hashes raw disk bytes (no normalization) and reports size', () => {
  const dir = mkDir();
  const file = path.join(dir, 'crlf.bin');
  const bytes = Buffer.from('line1\r\nline2\n\x00tail');
  fs.writeFileSync(file, bytes);
  const expected = crypto.createHash('sha256').update(bytes).digest('hex');
  assert.deepEqual(sha256File(file), { ok: true, sha: expected, size: bytes.length });
});

test('sha256File reports a missing file as FILE_UNREADABLE with missing:true', () => {
  const dir = mkDir();
  const r = sha256File(path.join(dir, 'gone.bin'));
  assert.deepEqual(r, { ok: false, code: 'FILE_UNREADABLE', missing: true });
});

test('sha256File reports an EACCES file as unreadable but NOT missing', (t) => {
  if (process.getuid() === 0) return t.skip('root bypasses file modes');
  const dir = mkDir();
  const file = path.join(dir, 'locked.txt');
  fs.writeFileSync(file, 'secret');
  fs.chmodSync(file, 0o000);
  try {
    const r = sha256File(file);
    assert.deepEqual(r, { ok: false, code: 'FILE_UNREADABLE', missing: false });
  } finally {
    fs.chmodSync(file, 0o600);
  }
});

test('sha256File streams: a multi-chunk (>64KiB) file hashes identically to one-shot', () => {
  const dir = mkDir();
  const file = path.join(dir, 'big.bin');
  const bytes = crypto.randomBytes(65536 * 3 + 17);
  fs.writeFileSync(file, bytes);
  const expected = crypto.createHash('sha256').update(bytes).digest('hex');
  assert.deepEqual(sha256File(file), { ok: true, sha: expected, size: bytes.length });
});

test('sha256File hex digest is lowercase', () => {
  const dir = mkDir();
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'ABC');
  const { sha } = sha256File(file);
  assert.match(sha, /^[0-9a-f]{64}$/);
});
