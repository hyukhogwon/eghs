'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exclusiveLinkCreate } = require('../hooks/lib/exclusive-link');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-link-'));
}

test('exclusiveLinkCreate creates the file when absent', () => {
  const dir = mkTmpDir();
  const dest = path.join(dir, 'lock.json');
  const result = exclusiveLinkCreate(dest, '{"pid":1}');
  assert.deepEqual(result, { ok: true });
  assert.equal(fs.readFileSync(dest, 'utf8'), '{"pid":1}');
});

test('exclusiveLinkCreate returns ok:false EEXIST when already present, without overwriting', () => {
  const dir = mkTmpDir();
  const dest = path.join(dir, 'lock.json');
  exclusiveLinkCreate(dest, '{"pid":1}');
  const second = exclusiveLinkCreate(dest, '{"pid":2}');
  assert.deepEqual(second, { ok: false, code: 'EEXIST' });
  assert.equal(fs.readFileSync(dest, 'utf8'), '{"pid":1}');
});

test('exclusiveLinkCreate leaves no leftover tmp file after success or collision', () => {
  const dir = mkTmpDir();
  const dest = path.join(dir, 'lock.json');
  exclusiveLinkCreate(dest, '{"pid":1}');
  exclusiveLinkCreate(dest, '{"pid":2}');
  const tmpDir = path.join(dir, 'tmp');
  assert.ok(!fs.existsSync(tmpDir) || fs.readdirSync(tmpDir).length === 0);
});
