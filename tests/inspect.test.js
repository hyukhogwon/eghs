'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { keyHash } = require('../hooks/lib/canonical');

const INSPECT = path.join(__dirname, '..', 'hooks', 'inspect.js');
const PRE_HOOK = path.join(__dirname, '..', 'hooks', 'pre-tool-use.js');
const POST_HOOK = path.join(__dirname, '..', 'hooks', 'post-tool-use.js');
const INIT_SCRIPT = path.join(__dirname, '..', 'hooks', 'init.js');
const SID = '11111111-1111-4111-8111-111111111111';

function mkRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-inspect-')));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('node', [INIT_SCRIPT], { cwd: dir });
  return dir;
}

function run(repo, args = [], stdin = '') {
  const r = spawnSync('node', [INSPECT, ...args], {
    cwd: repo,
    input: stdin,
    encoding: 'utf8',
    env: process.env,
  });
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

function hookInput(event, tool, file) {
  return {
    session_id: SID,
    hook_event_name: event,
    tool_name: tool,
    tool_input: { file_path: file },
    tool_response: {},
  };
}

function runHook(script, repo, input) {
  spawnSync('node', [script], {
    cwd: repo,
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: process.env,
  });
}

function canonKey(repo, file) {
  const info = JSON.parse(
    fs.readFileSync(path.join(repo, '.claude', 'state', 'eghs', 'fs-info.json'), 'utf8')
  );
  const resolved = fs.realpathSync(file);
  return info.caseless_fs ? resolved.toLowerCase() : resolved;
}

test('dump renders schema, fs-info, sessions (with liveness), reads, markers and pre-files', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'a.txt');
  fs.writeFileSync(file, 'contents');
  runHook(PRE_HOOK, repo, hookInput('PreToolUse', 'Read', file));
  runHook(POST_HOOK, repo, hookInput('PostToolUse', 'Read', file));
  // Seed a key-scoped marker for a second file so `failed` shows up too.
  const other = path.join(repo, 'b.txt');
  fs.writeFileSync(other, 'x');
  fs.writeFileSync(
    path.join(repo, '.claude', 'state', 'eghs', 'failed', `${keyHash(canonKey(repo, other))}.json`),
    JSON.stringify({ schema_version: 1, origin_sid: SID, ts_ms: 1, reason: 'stale_read' })
  );
  const { exitCode, stdout } = run(repo);
  assert.equal(exitCode, 0);
  const dump = JSON.parse(stdout);
  assert.equal(dump.schema.version, 1);
  assert.equal(dump.fs_info.status, 'ok');
  const session = dump.sessions.find((s) => s.sid === SID);
  assert.equal(session.alive, true); // lease pid = this test process
  assert.equal(dump.reads.length, 1);
  assert.equal(dump.reads[0].body.evidence, 'full_read');
  assert.equal(dump.failed.key_scoped.length, 1);
  assert.equal(dump.failed.key_scoped[0].body.reason, 'stale_read');
  assert.deepEqual(dump.pre[SID] ?? [], []); // consumed by PostToolUse
});

test('dump on an uninitialized repo exits 1 and points at init', () => {
  const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-inspect-bare-')));
  execFileSync('git', ['init', '-q'], { cwd: bare });
  const { exitCode, stderr } = run(bare);
  assert.equal(exitCode, 1);
  assert.match(stderr, /init/);
});

test('--dry-run resolves a hook input to canonical key + current state (none yet)', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'new.txt'); // does not exist: deep-new-path
  const { exitCode, stdout } = run(repo, ['--dry-run'], JSON.stringify(hookInput('PreToolUse', 'Edit', file)));
  assert.equal(exitCode, 0);
  const out = JSON.parse(stdout);
  assert.equal(out.key_hash, keyHash(out.key));
  assert.equal(out.outside_repo, false);
  assert.equal(out.state, null);
  assert.equal(out.key_marker, null);
  assert.equal(out.sid_marker, null);
});

test('--dry-run surfaces an existing full_read record and pre-file for the file', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'seen.txt');
  fs.writeFileSync(file, 'v1');
  runHook(PRE_HOOK, repo, hookInput('PreToolUse', 'Read', file));
  runHook(POST_HOOK, repo, hookInput('PostToolUse', 'Read', file));
  runHook(PRE_HOOK, repo, hookInput('PreToolUse', 'Edit', file)); // leaves a write pre-file
  const { stdout } = run(repo, ['--dry-run'], JSON.stringify(hookInput('PostToolUse', 'Edit', file)));
  const out = JSON.parse(stdout);
  assert.equal(out.state.evidence, 'full_read');
  assert.equal(out.state.sid, SID);
  assert.equal(out.pre_write.length, 1); // one entry per tool_use_id (R16)
  assert.equal(typeof out.pre_write[0].body.pre_sha, 'string');
  assert.deepEqual(out.pre_read, []); // consumed by the earlier PostToolUse
});

test('--dry-run with malformed stdin exits 1', () => {
  const repo = mkRepo();
  const { exitCode, stderr } = run(repo, ['--dry-run'], '{ not json');
  assert.equal(exitCode, 1);
  assert.match(stderr, /JSON/i);
});
