'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { keyHash } = require('../hooks/lib/canonical');

const POST_HOOK = path.join(__dirname, '..', 'hooks', 'post-tool-use.js');
const PRE_HOOK = path.join(__dirname, '..', 'hooks', 'pre-tool-use.js');
const INIT_SCRIPT = path.join(__dirname, '..', 'hooks', 'init.js');
const SID = '11111111-1111-4111-8111-111111111111';

function mkRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-posttool-')));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('node', [INIT_SCRIPT], { cwd: dir });
  return dir;
}

function runHook(script, repo, input, extraEnv = {}) {
  const r = spawnSync('node', [script], {
    cwd: repo,
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

function readInput(file, extra = {}) {
  return {
    session_id: SID,
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    tool_input: { file_path: file, ...extra },
    tool_response: {},
  };
}

// State records are keyed by sha1(canonical key); on this dev box the repo
// path from mkdtemp is already realpath'd, so derive the key the same way
// the hooks do: lowercase iff the repo's own fs-info says caseless.
function canonKey(repo, file) {
  const info = JSON.parse(
    fs.readFileSync(path.join(repo, '.claude', 'state', 'eghs', 'fs-info.json'), 'utf8')
  );
  const resolved = fs.realpathSync(file);
  return info.caseless_fs ? resolved.toLowerCase() : resolved;
}

function readState(repo, file) {
  const p = path.join(repo, '.claude', 'state', 'eghs', 'reads', `${keyHash(canonKey(repo, file))}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

function keyMarkerPath(repo, file) {
  return path.join(repo, '.claude', 'state', 'eghs', 'failed', `${keyHash(canonKey(repo, file))}.json`);
}

test('a clean full Read records evidence full_read with the disk sha and sid', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'a.txt');
  fs.writeFileSync(file, 'contents');
  const { exitCode, stdout } = runHook(POST_HOOK, repo, readInput(file));
  assert.equal(exitCode, 0);
  assert.equal(stdout, '');
  const state = readState(repo, file);
  assert.equal(state.evidence, 'full_read');
  assert.equal(state.sha, crypto.createHash('sha256').update('contents').digest('hex'));
  assert.equal(state.sid, SID);
  assert.equal(state.size, 8);
  assert.equal(state.schema_version, 1);
});

test('offset/limit reads record partial_read with sha:null', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'a.txt');
  fs.writeFileSync(file, '0123456789');
  runHook(POST_HOOK, repo, readInput(file, { offset: 2, limit: 3 }));
  const state = readState(repo, file);
  assert.equal(state.evidence, 'partial_read');
  assert.equal(state.sha, null);
  assert.equal(state.size, 10);
});

test('a file above max_full_read_bytes records partial_read even without offset/limit', () => {
  const repo = mkRepo();
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, '.claude', 'eghs.config.json'),
    JSON.stringify({ max_full_read_bytes: 4 })
  );
  const file = path.join(repo, 'big.txt');
  fs.writeFileSync(file, 'way more than four bytes');
  runHook(POST_HOOK, repo, readInput(file));
  const state = readState(repo, file);
  assert.equal(state.evidence, 'partial_read');
  assert.equal(state.sha, null); // partial evidence must never carry a gate-passing sha
});

test('offset:0 still records partial_read (explicit offset, not truthiness)', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'z.txt');
  fs.writeFileSync(file, '0123456789');
  runHook(POST_HOOK, repo, readInput(file, { offset: 0 }));
  const state = readState(repo, file);
  assert.equal(state.evidence, 'partial_read');
  assert.equal(state.sha, null);
});

test('TOCTOU: a pre-read sha mismatch records stale_read and leaves a key-scoped marker', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'race.txt');
  fs.writeFileSync(file, 'original');
  const pre = runHook(PRE_HOOK, repo, { ...readInput(file), hook_event_name: 'PreToolUse' });
  assert.equal(pre.exitCode, 0);
  fs.writeFileSync(file, 'changed behind the tool');
  runHook(POST_HOOK, repo, readInput(file));
  const state = readState(repo, file);
  assert.equal(state.evidence, 'stale_read');
  const marker = JSON.parse(fs.readFileSync(keyMarkerPath(repo, file), 'utf8'));
  assert.equal(marker.reason, 'stale_read');
  assert.equal(marker.origin_sid, SID);
});

test('the PreToolUse read pre-file is deleted after PostToolUse processes it', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'p.txt');
  fs.writeFileSync(file, 'x');
  runHook(PRE_HOOK, repo, { ...readInput(file), hook_event_name: 'PreToolUse' });
  const preDir = path.join(repo, '.claude', 'state', 'eghs', 'pre', SID);
  assert.equal(fs.readdirSync(preDir).filter((f) => f.endsWith('.read.json')).length, 1);
  runHook(POST_HOOK, repo, readInput(file));
  assert.equal(fs.readdirSync(preDir).filter((f) => f.endsWith('.read.json')).length, 0);
});

test('a successful full_read clears this session\'s own failed markers', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'heal.txt');
  fs.writeFileSync(file, 'ok now');
  // Seed an own-sid key-scoped marker (as if an earlier stale_read happened).
  const failedDir = path.join(repo, '.claude', 'state', 'eghs', 'failed');
  fs.writeFileSync(
    keyMarkerPath(repo, file),
    JSON.stringify({ schema_version: 1, origin_sid: SID, ts_ms: 1, reason: 'stale_read' })
  );
  assert.ok(fs.existsSync(failedDir));
  runHook(POST_HOOK, repo, readInput(file));
  assert.equal(readState(repo, file).evidence, 'full_read');
  assert.ok(!fs.existsSync(keyMarkerPath(repo, file)));
});

test('a PostToolUse Read also creates/renews the session lease', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'l.txt');
  fs.writeFileSync(file, 'x');
  const leasePath = path.join(repo, '.claude', 'state', 'eghs', 'sessions', `${SID}.json`);
  runHook(POST_HOOK, repo, readInput(file));
  const first = JSON.parse(fs.readFileSync(leasePath, 'utf8'));
  assert.equal(typeof first.start_ms, 'number');
  assert.equal(first.pid, process.pid); // hook's ppid = this test process
  runHook(POST_HOOK, repo, readInput(file));
  const second = JSON.parse(fs.readFileSync(leasePath, 'utf8'));
  assert.equal(second.start_ms, first.start_ms); // renewal preserves lease start
  assert.ok(second.renewed_ms >= first.renewed_ms);
});

test('guards: kill switch, CI, NO_SESSION, uninitialized state all skip with exit 0', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'g.txt');
  fs.writeFileSync(file, 'x');
  fs.writeFileSync(path.join(repo, '.claude', 'eghs-off'), '');
  assert.equal(runHook(POST_HOOK, repo, readInput(file)).exitCode, 0);
  fs.rmSync(path.join(repo, '.claude', 'eghs-off'));
  assert.equal(runHook(POST_HOOK, repo, readInput(file), { CI: 'true' }).exitCode, 0);
  const noSid = readInput(file);
  noSid.session_id = undefined;
  const r = runHook(POST_HOOK, repo, noSid);
  assert.equal(r.exitCode, 0);
  assert.match(r.stderr, /NO_SESSION/);
  assert.equal(readState(repo, file), null);
  const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-posttool-bare-')));
  execFileSync('git', ['init', '-q'], { cwd: bare });
  const bf = path.join(bare, 'x.txt');
  fs.writeFileSync(bf, 'x');
  assert.equal(runHook(POST_HOOK, bare, readInput(bf)).exitCode, 0);
  assert.ok(!fs.existsSync(path.join(bare, '.claude', 'state', 'eghs', 'reads')));
});

test('an unavailable session lease leaves a sid-scoped lease_unavailable marker, no state', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'l2.txt');
  fs.writeFileSync(file, 'x');
  // A live foreign pid (1 = launchd/init) holding this sid forces a
  // SID_COLLISION out of ensureSessionLease.
  const sessions = path.join(repo, '.claude', 'state', 'eghs', 'sessions');
  fs.writeFileSync(
    path.join(sessions, `${SID}.json`),
    JSON.stringify({ pid: 1, uid: process.getuid(), start_ms: 1, renewed_ms: Date.now() })
  );
  const { exitCode } = runHook(POST_HOOK, repo, readInput(file));
  assert.equal(exitCode, 0);
  assert.equal(readState(repo, file), null);
  const marker = JSON.parse(
    fs.readFileSync(
      path.join(repo, '.claude', 'state', 'eghs', 'failed', SID, `${keyHash(canonKey(repo, file))}.json`),
      'utf8'
    )
  );
  assert.equal(marker.reason, 'lease_unavailable');
});

test('malformed stdin and a corrupt eghs.config.json both skip without crashing', () => {
  const repo = mkRepo();
  assert.equal(runHook(POST_HOOK, repo, '{ not json').exitCode, 0);
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'eghs.config.json'), '{ nope');
  const file = path.join(repo, 'c.txt');
  fs.writeFileSync(file, 'x');
  const { exitCode, stdout } = runHook(POST_HOOK, repo, readInput(file));
  assert.equal(exitCode, 0);
  assert.equal(stdout, '');
  assert.equal(readState(repo, file), null);
});

test('a vanished file (deleted between Read and PostToolUse) is skipped, not crashed', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'gone.txt');
  const input = readInput(file); // file never created
  const { exitCode } = runHook(POST_HOOK, repo, input);
  assert.equal(exitCode, 0);
});
