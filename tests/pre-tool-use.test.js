'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'hooks', 'pre-tool-use.js');
const INIT_SCRIPT = path.join(__dirname, '..', 'hooks', 'init.js');
const SID = '11111111-1111-4111-8111-111111111111';

function mkRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-pretool-')));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('node', [INIT_SCRIPT], { cwd: dir });
  return dir;
}

function runHook(repo, input, extraEnv = {}) {
  const r = spawnSync('node', [HOOK], {
    cwd: repo,
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

function preFiles(repo, kind) {
  const dir = path.join(repo, '.claude', 'state', 'eghs', 'pre', SID);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(`.${kind}.json`))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

function toolInput(tool, file) {
  return {
    session_id: SID,
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: { file_path: file },
  };
}

test('Edit on an existing file records pre_sha + pretool_sid, exit 0, empty stdout', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'a.txt');
  fs.writeFileSync(file, 'hello');
  const { exitCode, stdout } = runHook(repo, toolInput('Edit', file));
  assert.equal(exitCode, 0);
  assert.equal(stdout, '');
  const records = preFiles(repo, 'write');
  assert.equal(records.length, 1);
  assert.equal(records[0].pre_sha, crypto.createHash('sha256').update('hello').digest('hex'));
  assert.equal(records[0].pretool_sid, SID);
  assert.equal(records[0].schema_version, 1);
});

test('Write intent for a not-yet-existing (deep) path records pre_sha:null', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'brand', 'new', 'dir', 'file.txt');
  const { exitCode } = runHook(repo, toolInput('Write', file));
  assert.equal(exitCode, 0);
  const records = preFiles(repo, 'write');
  assert.equal(records.length, 1);
  assert.equal(records[0].pre_sha, null);
});

test('Read records the PreToolUse-time sha into a .read.json pre-file', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'r.txt');
  fs.writeFileSync(file, 'read me');
  const { exitCode } = runHook(repo, toolInput('Read', file));
  assert.equal(exitCode, 0);
  const records = preFiles(repo, 'read');
  assert.equal(records.length, 1);
  assert.equal(records[0].sha, crypto.createHash('sha256').update('read me').digest('hex'));
});

test('MultiEdit is treated as a write-kind tool', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'm.txt');
  fs.writeFileSync(file, 'multi');
  runHook(repo, toolInput('MultiEdit', file));
  assert.equal(preFiles(repo, 'write').length, 1);
});

test('unknown tools and missing file_path are skipped silently (exit 0)', () => {
  const repo = mkRepo();
  assert.equal(runHook(repo, toolInput('Bash', undefined)).exitCode, 0);
  assert.equal(runHook(repo, { session_id: SID, tool_name: 'Edit', tool_input: {} }).exitCode, 0);
  assert.equal(preFiles(repo, 'write').length, 0);
});

test('malformed stdin JSON never blocks the tool (exit 0, stderr note)', () => {
  const repo = mkRepo();
  const { exitCode, stderr } = runHook(repo, '{ not json');
  assert.equal(exitCode, 0);
  assert.match(stderr, /\[eghs\]/);
});

test('P4: missing/invalid session_id fail-closed BLOCKS Edit (exit 2, NO_SESSION)', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'a.txt');
  fs.writeFileSync(file, 'x');
  const input = toolInput('Edit', file);
  input.session_id = 'not-a-uuid';
  const { exitCode, stderr } = runHook(repo, input);
  assert.equal(exitCode, 2);
  assert.match(stderr, /NO_SESSION/);
  assert.match(stderr, /sid=none/);
  assert.ok(!fs.existsSync(path.join(repo, '.claude', 'state', 'eghs', 'pre', 'not-a-uuid')));
});

test('P4: NO_SESSION on Read also fail-closed blocks (exit 2, G1)', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'a.txt');
  fs.writeFileSync(file, 'x');
  const input = toolInput('Read', file);
  input.session_id = 'nope';
  assert.equal(runHook(repo, input).exitCode, 2);
});

test('kill switch and CI passthrough skip recording entirely', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'a.txt');
  fs.writeFileSync(file, 'x');
  fs.writeFileSync(path.join(repo, '.claude', 'eghs-off'), '');
  assert.equal(runHook(repo, toolInput('Edit', file)).exitCode, 0);
  fs.rmSync(path.join(repo, '.claude', 'eghs-off'));
  assert.equal(runHook(repo, toolInput('Edit', file), { CI: 'true' }).exitCode, 0);
  assert.equal(preFiles(repo, 'write').length, 0);
});

test('P4: uninitialized state dir blocks Edit with SCHEMA_NOT_INITIALIZED (exit 2, auto-unblock Yes)', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-pretool-bare-')));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'x');
  const { exitCode, stderr } = runHook(dir, toolInput('Edit', file));
  assert.equal(exitCode, 2);
  assert.match(stderr, /SCHEMA_NOT_INITIALIZED/);
  assert.match(stderr, /eghs-init/);
  assert.ok(!fs.existsSync(path.join(dir, '.claude', 'state', 'eghs', 'pre')));
});

test('a file outside the repo root is skipped (out-of-repo = out of scope)', () => {
  const repo = mkRepo();
  const outside = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-out-'))), 'x.txt');
  fs.writeFileSync(outside, 'external');
  const { exitCode } = runHook(repo, toolInput('Edit', outside));
  assert.equal(exitCode, 0);
  assert.equal(preFiles(repo, 'write').length, 0);
});

test('pre-files older than 24h are GCed on the next hook invocation', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'a.txt');
  fs.writeFileSync(file, 'x');
  runHook(repo, toolInput('Edit', file));
  const dir = path.join(repo, '.claude', 'state', 'eghs', 'pre', SID);
  const stale = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))[0];
  const old = new Date(Date.now() - 25 * 3600 * 1000);
  fs.utimesSync(path.join(dir, stale), old, old);
  const other = path.join(repo, 'b.txt');
  fs.writeFileSync(other, 'y');
  runHook(repo, toolInput('Read', other));
  assert.ok(!fs.existsSync(path.join(dir, stale)));
});

// ---- P4 unit 9: live R3 gate (state_gate_paths configured) ----

const crypto2 = require('crypto');

function writeConfig(repo, gatePaths) {
  fs.writeFileSync(
    path.join(repo, '.claude', 'eghs.config.json'),
    JSON.stringify({ state_gate_paths: gatePaths })
  );
}

function readState(repo, file) {
  const info = JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'state', 'eghs', 'fs-info.json'), 'utf8'));
  const key = info.caseless_fs ? fs.realpathSync(file).toLowerCase() : fs.realpathSync(file);
  const { createHash } = require('crypto');
  const hash = createHash('sha1').update(key).digest('hex');
  const p = path.join(repo, '.claude', 'state', 'eghs', 'reads', `${hash}.json`);
  return { key, statePath: p };
}

test('gate ON, gated file with no read evidence → BLOCK UNREAD_OR_STALE (exit 2)', () => {
  const repo = mkRepo();
  writeConfig(repo, ['**/*.ts']);
  const file = path.join(repo, 'src.ts');
  fs.writeFileSync(file, 'code');
  const { exitCode, stderr } = runHook(repo, toolInput('Edit', file));
  assert.equal(exitCode, 2);
  assert.match(stderr, /UNREAD_OR_STALE/);
});

test('gate ON, non-gated file → record-only allow (exit 0), pre-file written', () => {
  const repo = mkRepo();
  writeConfig(repo, ['**/*.ts']);
  const file = path.join(repo, 'notes.md'); // not matched
  fs.writeFileSync(file, 'x');
  const { exitCode } = runHook(repo, toolInput('Edit', file));
  assert.equal(exitCode, 0);
  assert.equal(preFiles(repo, 'write').length, 1);
});

test('gate ON, Read then Edit on a gated file passes (allow, pre_sha recorded)', () => {
  const repo = mkRepo();
  writeConfig(repo, ['**/*.ts']);
  const file = path.join(repo, 'src.ts');
  fs.writeFileSync(file, 'code');
  // Simulate the full Read cycle: PreToolUse Read + PostToolUse Read record.
  runHook(repo, toolInput('Read', file));
  const POST = path.join(__dirname, '..', 'hooks', 'post-tool-use.js');
  spawnSync('node', [POST], { cwd: repo, input: JSON.stringify({ ...toolInput('Read', file), tool_response: { type: 'text', file: {} } }), encoding: 'utf8', env: process.env });
  // Now Edit must be allowed.
  const { exitCode } = runHook(repo, toolInput('Edit', file));
  assert.equal(exitCode, 0);
  assert.equal(preFiles(repo, 'write').length, 1);
  assert.equal(preFiles(repo, 'write')[0].pre_sha, crypto2.createHash('sha256').update('code').digest('hex'));
});

test('gate ON, new-file Write on a gated path is allowed (pre_sha null, R4 handles)', () => {
  const repo = mkRepo();
  writeConfig(repo, ['**/*.ts']);
  const file = path.join(repo, 'fresh.ts'); // does not exist
  const { exitCode } = runHook(repo, toolInput('Write', file));
  assert.equal(exitCode, 0);
  const recs = preFiles(repo, 'write');
  assert.equal(recs.length, 1);
  assert.equal(recs[0].pre_sha, null);
});
