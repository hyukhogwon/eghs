'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { appendDebugLog, logDecision, setDebugEnabled } = require('../hooks/lib/debug-log');

const SID = '11111111-1111-4111-8111-111111111111';

function mkStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-debuglog-'));
}

function readEvents(stateDir, sid) {
  return fs
    .readFileSync(path.join(stateDir, 'debug', `${sid}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
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

// --- PRD §5 uniform event schema (P4 unit 11) ---

const EVENT_KEYS = [
  'schema_version',
  'sid',
  'ts_ms',
  'hook',
  'tool',
  'path',
  'gate_applicable',
  'has_gate_passing_state',
  'evidence_kind',
  'kill_switch',
  'decision',
  'deny_code',
  'latency_ms',
];

test('logDecision emits every §5 field, defaulting the ones the caller omits', () => {
  const stateDir = mkStateDir();
  logDecision(stateDir, SID, { tsMs: 1780000000000, hook: 'PreToolUse', tool: 'Edit', decision: 'allow' });
  const [event] = readEvents(stateDir, SID);
  assert.deepEqual(Object.keys(event), EVENT_KEYS);
  assert.equal(event.hook, 'PreToolUse');
  assert.equal(event.tool, 'Edit');
  assert.equal(event.path, null);
  assert.equal(event.gate_applicable, false);
  assert.equal(event.has_gate_passing_state, false);
  assert.equal(event.evidence_kind, null);
  assert.equal(event.kill_switch, 'off');
  assert.equal(event.deny_code, null);
  assert.equal(typeof event.latency_ms, 'number');
});

test('logDecision keeps extra diagnostic keys after the fixed schema fields', () => {
  const stateDir = mkStateDir();
  logDecision(stateDir, SID, { tsMs: 1, hook: 'Stop', decision: 'block', denyCode: 'INFRA_NOT_READY', masked_from: 'MIGRATE_IN_PROGRESS' });
  const [event] = readEvents(stateDir, SID);
  assert.equal(event.deny_code, 'INFRA_NOT_READY');
  assert.equal(event.masked_from, 'MIGRATE_IN_PROGRESS');
  assert.deepEqual(Object.keys(event).slice(0, EVENT_KEYS.length), EVENT_KEYS);
});

test('setDebugEnabled(false) silences both writers until re-enabled', () => {
  const stateDir = mkStateDir();
  setDebugEnabled(false);
  try {
    logDecision(stateDir, SID, { tsMs: 1, hook: 'Stop', decision: 'allow' });
    appendDebugLog(stateDir, SID, { event: 'sessions_gc_partial' });
    assert.ok(!fs.existsSync(path.join(stateDir, 'debug')));
  } finally {
    setDebugEnabled(true);
  }
  logDecision(stateDir, SID, { tsMs: 2, hook: 'Stop', decision: 'allow' });
  assert.equal(readEvents(stateDir, SID).length, 1);
});

test('a live PreToolUse writes one §5-schema line; config debug:false suppresses it', () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-debugcfg-')));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('node', [path.join(__dirname, '..', 'hooks', 'init.js')], { cwd: repo });
  const file = path.join(repo, 'a.txt');
  fs.writeFileSync(file, 'hello');
  const stateDir = path.join(repo, '.claude', 'state', 'eghs');
  const input = JSON.stringify({ session_id: SID, tool_name: 'Edit', tool_input: { file_path: file } });
  const run = () =>
    spawnSync('node', [path.join(__dirname, '..', 'hooks', 'pre-tool-use.js')], { cwd: repo, input, encoding: 'utf8' });

  run();
  const [event] = readEvents(stateDir, SID);
  assert.deepEqual(Object.keys(event), EVENT_KEYS);
  assert.equal(event.hook, 'PreToolUse');
  // canonical key: lowercased on a caseless FS, raw realpath otherwise.
  assert.equal(event.path.toLowerCase(), file.toLowerCase());
  assert.equal(event.decision, 'skip'); // in-repo, not gated (state_gate_paths [])

  fs.rmSync(path.join(stateDir, 'debug'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'eghs.config.json'), JSON.stringify({ debug: false }));
  run();
  assert.ok(!fs.existsSync(path.join(stateDir, 'debug', `${SID}.jsonl`)));
});
