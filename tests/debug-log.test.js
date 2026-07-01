'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { appendDebugLog } = require('../hooks/lib/debug-log');

function mkStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-debuglog-'));
}

test('appendDebugLog writes one JSONL line with schema_version and sid merged in', () => {
  const stateDir = mkStateDir();
  appendDebugLog(stateDir, 'sid-1', { hook: 'Stop', decision: 'allow' });
  const line = fs.readFileSync(path.join(stateDir, 'debug', 'sid-1.jsonl'), 'utf8').trim();
  const event = JSON.parse(line);
  assert.equal(event.schema_version, 1);
  assert.equal(event.sid, 'sid-1');
  assert.equal(event.hook, 'Stop');
  assert.equal(event.decision, 'allow');
});

test('appendDebugLog appends multiple calls as separate lines', () => {
  const stateDir = mkStateDir();
  appendDebugLog(stateDir, 'sid-1', { n: 1 });
  appendDebugLog(stateDir, 'sid-1', { n: 2 });
  const lines = fs
    .readFileSync(path.join(stateDir, 'debug', 'sid-1.jsonl'), 'utf8')
    .trim()
    .split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).n, 2);
});

test('appendDebugLog does not throw when the state dir cannot be created', () => {
  const stateDir = path.join(mkStateDir(), 'not-writable-parent-does-not-exist', 'x'.repeat(5000));
  assert.doesNotThrow(() => appendDebugLog(stateDir, 'sid-1', { n: 1 }));
});
