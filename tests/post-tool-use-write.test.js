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
const DEAD_SID = '99999999-9999-4999-8999-999999999999';

function mkRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-r4-')));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('node', [INIT_SCRIPT], { cwd: dir });
  return dir;
}

function runHook(script, repo, input) {
  const r = spawnSync('node', [script], {
    cwd: repo,
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: process.env,
  });
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

function editInput(event, file, { error } = {}) {
  return {
    session_id: SID,
    hook_event_name: event,
    tool_name: 'Edit',
    tool_input: { file_path: file },
    tool_response: error ? { error } : {},
  };
}

function canonKey(repo, file) {
  const info = JSON.parse(
    fs.readFileSync(path.join(repo, '.claude', 'state', 'eghs', 'fs-info.json'), 'utf8')
  );
  // Deep-new-path: resolve the nearest existing ancestor like the hooks do.
  let resolved;
  try {
    resolved = fs.realpathSync(file);
  } catch {
    resolved = path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
  }
  return info.caseless_fs ? resolved.toLowerCase() : resolved;
}

function statePath(repo, file) {
  return path.join(repo, '.claude', 'state', 'eghs', 'reads', `${keyHash(canonKey(repo, file))}.json`);
}

function readState(repo, file) {
  const p = statePath(repo, file);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

function marker(repo, file, sid) {
  const base = path.join(repo, '.claude', 'state', 'eghs', 'failed');
  const p = sid
    ? path.join(base, sid, `${keyHash(canonKey(repo, file))}.json`)
    : path.join(base, `${keyHash(canonKey(repo, file))}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

function preWriteFileCount(repo, sid) {
  const dir = path.join(repo, '.claude', 'state', 'eghs', 'pre', sid);
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => f.endsWith('.write.json')).length;
}

test('R4 new-file success: pre_sha null + file now exists + no error → post_edit_success', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'fresh.txt');
  runHook(PRE_HOOK, repo, editInput('PreToolUse', file));
  fs.writeFileSync(file, 'created');
  const { exitCode, stdout } = runHook(POST_HOOK, repo, editInput('PostToolUse', file));
  assert.equal(exitCode, 0);
  assert.equal(stdout, '');
  const state = readState(repo, file);
  assert.equal(state.evidence, 'post_edit_success');
  assert.equal(state.sha, crypto.createHash('sha256').update('created').digest('hex'));
  assert.equal(state.sid, SID);
  assert.equal(preWriteFileCount(repo, SID), 0);
});

test('R4 edit success: pre_sha changed + no error → post_edit_success and own markers cleared', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'e.txt');
  fs.writeFileSync(file, 'v1');
  runHook(PRE_HOOK, repo, editInput('PreToolUse', file));
  // Seed an own-sid key marker from an earlier failure; success must clear it.
  fs.writeFileSync(
    path.join(repo, '.claude', 'state', 'eghs', 'failed', `${keyHash(canonKey(repo, file))}.json`),
    JSON.stringify({ schema_version: 1, origin_sid: SID, ts_ms: 1, reason: 'stale_read' })
  );
  fs.writeFileSync(file, 'v2');
  runHook(POST_HOOK, repo, editInput('PostToolUse', file));
  assert.equal(readState(repo, file).evidence, 'post_edit_success');
  assert.equal(marker(repo, file, null), null);
  assert.equal(preWriteFileCount(repo, SID), 0);
});

test('R4 no-op edit: pre_sha unchanged + no error → state untouched, pre-file still consumed', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'n.txt');
  fs.writeFileSync(file, 'same');
  runHook(PRE_HOOK, repo, editInput('PreToolUse', file));
  runHook(POST_HOOK, repo, editInput('PostToolUse', file));
  assert.equal(readState(repo, file), null);
  assert.equal(marker(repo, file, null), null);
  assert.equal(preWriteFileCount(repo, SID), 0);
});

test('R4 unexpected: pre_sha null + file still missing + no error → marker + stderr warning', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'ghost.txt');
  runHook(PRE_HOOK, repo, editInput('PreToolUse', file));
  const { stderr } = runHook(POST_HOOK, repo, editInput('PostToolUse', file));
  assert.equal(readState(repo, file), null);
  assert.equal(marker(repo, file, null).reason, 'state_record_failed');
  assert.match(stderr, /\[eghs\]/);
});

test('R4 overwrite race: pre_sha null + file exists + tool error → overwrite_race marker + partial evidence', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'o.txt');
  runHook(PRE_HOOK, repo, editInput('PreToolUse', file));
  fs.writeFileSync(file, 'landed anyway');
  runHook(POST_HOOK, repo, editInput('PostToolUse', file, { error: 'boom' }));
  assert.equal(marker(repo, file, null).reason, 'overwrite_race');
  assert.equal(readState(repo, file).evidence, 'post_edit_partial');
});

test('R4 partial apply: pre_sha changed + tool error → post_edit_partial marker + evidence', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'p.txt');
  fs.writeFileSync(file, 'v1');
  runHook(PRE_HOOK, repo, editInput('PreToolUse', file));
  fs.writeFileSync(file, 'v1 plus partial garbage');
  runHook(POST_HOOK, repo, editInput('PostToolUse', file, { error: 'edit failed midway' }));
  assert.equal(marker(repo, file, null).reason, 'post_edit_partial');
  assert.equal(readState(repo, file).evidence, 'post_edit_partial');
});

test('R4 clean failures (error + no disk change) leave no state and no marker', () => {
  const repo = mkRepo();
  const missing = path.join(repo, 'never.txt');
  runHook(PRE_HOOK, repo, editInput('PreToolUse', missing));
  runHook(POST_HOOK, repo, editInput('PostToolUse', missing, { error: 'refused' }));
  assert.equal(readState(repo, missing), null);
  assert.equal(marker(repo, missing, null), null);
  const existing = path.join(repo, 'stable.txt');
  fs.writeFileSync(existing, 'untouched');
  runHook(PRE_HOOK, repo, editInput('PreToolUse', existing));
  runHook(POST_HOOK, repo, editInput('PostToolUse', existing, { error: 'refused' }));
  assert.equal(readState(repo, existing), null);
  assert.equal(marker(repo, existing, null), null);
});

test('R4 missing pre-file with no orphans → sid-scoped state_record_failed marker for this sid', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'm.txt');
  fs.writeFileSync(file, 'x');
  runHook(POST_HOOK, repo, editInput('PostToolUse', file)); // PreToolUse never ran
  assert.equal(readState(repo, file), null);
  assert.equal(marker(repo, file, SID).reason, 'state_record_failed');
  assert.equal(marker(repo, file, SID).origin_sid, SID);
});

test("R4 orphan pre-file from a dead sid → dead sid's marker, orphan unlinked, current sid unaffected", () => {
  const repo = mkRepo();
  const file = path.join(repo, 'orph.txt');
  fs.writeFileSync(file, 'x');
  const preDir = path.join(repo, '.claude', 'state', 'eghs', 'pre', DEAD_SID);
  fs.mkdirSync(preDir, { recursive: true });
  const orphan = path.join(preDir, `${keyHash(canonKey(repo, file))}.none.write.json`);
  fs.writeFileSync(
    orphan,
    JSON.stringify({ schema_version: 1, pre_sha: null, pretool_sid: DEAD_SID })
  ); // no sessions/<DEAD_SID>.json lease → dead
  runHook(POST_HOOK, repo, editInput('PostToolUse', file));
  assert.ok(!fs.existsSync(orphan));
  assert.equal(marker(repo, file, DEAD_SID).origin_sid, DEAD_SID);
  assert.equal(readState(repo, file), null);
});

test('R4 orphan scan claims a pre-file whose lease names a DEAD pid', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'deadpid.txt');
  fs.writeFileSync(file, 'x');
  const preDir = path.join(repo, '.claude', 'state', 'eghs', 'pre', DEAD_SID);
  fs.mkdirSync(preDir, { recursive: true });
  const orphan = path.join(preDir, `${keyHash(canonKey(repo, file))}.none.write.json`);
  fs.writeFileSync(
    orphan,
    JSON.stringify({ schema_version: 1, pre_sha: null, pretool_sid: DEAD_SID })
  );
  // A freshly exited child's pid is provably dead (no reuse this fast).
  // renewed_ms stays FRESH: a time-stale dead lease would be swept by the
  // precedence #5b sessions GC before the R4 2nd-pass orphan scan ever ran.
  const deadPid = spawnSync('node', ['-e', '']).pid;
  fs.writeFileSync(
    path.join(repo, '.claude', 'state', 'eghs', 'sessions', `${DEAD_SID}.json`),
    JSON.stringify({ pid: deadPid, uid: process.getuid(), start_ms: 1, renewed_ms: Date.now() })
  );
  runHook(POST_HOOK, repo, editInput('PostToolUse', file));
  assert.ok(!fs.existsSync(orphan));
  assert.equal(marker(repo, file, DEAD_SID).origin_sid, DEAD_SID);
});

test('R4 orphan scan never touches a pre-file whose sid holds a LIVE lease', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'live.txt');
  fs.writeFileSync(file, 'x');
  const preDir = path.join(repo, '.claude', 'state', 'eghs', 'pre', DEAD_SID);
  fs.mkdirSync(preDir, { recursive: true });
  const orphan = path.join(preDir, `${keyHash(canonKey(repo, file))}.none.write.json`);
  fs.writeFileSync(
    orphan,
    JSON.stringify({ schema_version: 1, pre_sha: null, pretool_sid: DEAD_SID })
  );
  // Live lease: this test process's own pid is definitely alive.
  fs.writeFileSync(
    path.join(repo, '.claude', 'state', 'eghs', 'sessions', `${DEAD_SID}.json`),
    JSON.stringify({ pid: process.pid, uid: process.getuid(), start_ms: 1, renewed_ms: Date.now() })
  );
  runHook(POST_HOOK, repo, editInput('PostToolUse', file));
  assert.ok(fs.existsSync(orphan), 'live session pre-file must survive');
  assert.equal(marker(repo, file, DEAD_SID), null);
  // No claimable orphan → falls back to current-sid marker.
  assert.equal(marker(repo, file, SID).reason, 'state_record_failed');
});

test('R4 orphan scan treats a CORRUPT lease as live (fail-closed, pre-file untouched)', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'corrupt.txt');
  fs.writeFileSync(file, 'x');
  const preDir = path.join(repo, '.claude', 'state', 'eghs', 'pre', DEAD_SID);
  fs.mkdirSync(preDir, { recursive: true });
  const orphan = path.join(preDir, `${keyHash(canonKey(repo, file))}.none.write.json`);
  fs.writeFileSync(
    orphan,
    JSON.stringify({ schema_version: 1, pre_sha: null, pretool_sid: DEAD_SID })
  );
  // Present-but-unparseable lease: the session may be alive; must not unlink.
  fs.writeFileSync(
    path.join(repo, '.claude', 'state', 'eghs', 'sessions', `${DEAD_SID}.json`),
    '{ not json'
  );
  runHook(POST_HOOK, repo, editInput('PostToolUse', file));
  assert.ok(fs.existsSync(orphan), 'pre-file behind a corrupt lease must survive');
  assert.equal(marker(repo, file, DEAD_SID), null);
  assert.equal(marker(repo, file, SID).reason, 'state_record_failed');
});

test('R4 pretool_sid mismatch is treated as a failed record (poisoned pre-file consumed)', () => {
  const repo = mkRepo();
  const file = path.join(repo, 's.txt');
  fs.writeFileSync(file, 'x');
  const preDir = path.join(repo, '.claude', 'state', 'eghs', 'pre', SID);
  fs.mkdirSync(preDir, { recursive: true });
  fs.writeFileSync(
    path.join(preDir, `${keyHash(canonKey(repo, file))}.none.write.json`),
    JSON.stringify({ schema_version: 1, pre_sha: null, pretool_sid: DEAD_SID })
  );
  runHook(POST_HOOK, repo, editInput('PostToolUse', file));
  assert.equal(readState(repo, file), null);
  assert.equal(marker(repo, file, SID).reason, 'state_record_failed');
  assert.equal(preWriteFileCount(repo, SID), 0);
});

test('Write and MultiEdit run the same matrix as Edit', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'w.txt');
  fs.writeFileSync(file, 'v1');
  const asTool = (tool, event) => ({ ...editInput(event, file), tool_name: tool });
  runHook(PRE_HOOK, repo, asTool('Write', 'PreToolUse'));
  fs.writeFileSync(file, 'v2');
  runHook(POST_HOOK, repo, asTool('Write', 'PostToolUse'));
  assert.equal(readState(repo, file).evidence, 'post_edit_success');
  runHook(PRE_HOOK, repo, asTool('MultiEdit', 'PreToolUse'));
  fs.writeFileSync(file, 'v3');
  runHook(POST_HOOK, repo, asTool('MultiEdit', 'PostToolUse'));
  assert.equal(
    readState(repo, file).sha,
    crypto.createHash('sha256').update('v3').digest('hex')
  );
});

// ---- P4 unit 10: R6 precedence rows (PostToolUse Write/Edit/MultiEdit) ----
// R4 §510-513 NO_SESSION short-circuit + the #4 hook-type matrix row (§755):
// every deny candidate degrades to a sid-scoped fail-closed marker + exit 0.

function stateDirOf(repo) {
  return path.join(repo, '.claude', 'state', 'eghs');
}

test('P4: NO_SESSION short-circuits exit 0 with one stderr line, no marker, no state', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'ns.txt');
  fs.writeFileSync(file, 'x');
  const input = editInput('PostToolUse', file);
  input.session_id = 'not-a-uuid';
  const { exitCode, stdout, stderr } = runHook(POST_HOOK, repo, input);
  assert.equal(exitCode, 0);
  assert.equal(stdout, '');
  assert.match(stderr, /NO_SESSION/);
  assert.equal(readState(repo, file), null);
  // R4 §512: no marker write, no pre/ lookup, no debug write.
  assert.equal(fs.readdirSync(path.join(stateDirOf(repo), 'failed')).filter((n) => n !== 'tmp').length, 0);
  assert.ok(!fs.existsSync(path.join(stateDirOf(repo), 'debug', 'not-a-uuid.jsonl')));
});

test('P4: live migrate.lock → sid-scoped migrate_in_progress marker, pre-file consumed, exit 0', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'mig.txt');
  fs.writeFileSync(file, 'v1');
  runHook(PRE_HOOK, repo, editInput('PreToolUse', file));
  assert.equal(preWriteFileCount(repo, SID), 1);
  fs.writeFileSync(
    path.join(stateDirOf(repo), 'migrate.lock'),
    JSON.stringify({ pid: process.pid, uid: process.getuid(), start_ms: Date.now() })
  );
  fs.writeFileSync(file, 'v2');
  const { exitCode, stdout } = runHook(POST_HOOK, repo, editInput('PostToolUse', file));
  assert.equal(exitCode, 0);
  assert.equal(stdout, '');
  assert.equal(marker(repo, file, SID).reason, 'migrate_in_progress');
  assert.equal(preWriteFileCount(repo, SID), 0);
  assert.equal(readState(repo, file), null); // no evidence write behind a migrate
});

test('P4: corrupt migrate.lock (non-regular file) → marker migrate_lock_corrupt', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'miglc.txt');
  fs.writeFileSync(file, 'v1');
  runHook(PRE_HOOK, repo, editInput('PreToolUse', file));
  fs.mkdirSync(path.join(stateDirOf(repo), 'migrate.lock')); // directory, not a file
  const { exitCode } = runHook(POST_HOOK, repo, editInput('PostToolUse', file));
  assert.equal(exitCode, 0);
  assert.equal(marker(repo, file, SID).reason, 'migrate_lock_corrupt');
  assert.equal(preWriteFileCount(repo, SID), 0);
});

test('P4: sid tombstone → marker sid_cleared, pre-file consumed, exit 0', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'tomb.txt');
  fs.writeFileSync(file, 'v1');
  runHook(PRE_HOOK, repo, editInput('PreToolUse', file));
  fs.writeFileSync(
    path.join(stateDirOf(repo), 'sessions', `${SID}.tombstone`),
    JSON.stringify({ cleared_by_pid: 1, cleared_by_uid: process.getuid(), ts_ms: 1, reason: 'clear-sid' })
  );
  const { exitCode } = runHook(POST_HOOK, repo, editInput('PostToolUse', file));
  assert.equal(exitCode, 0);
  assert.equal(marker(repo, file, SID).reason, 'sid_cleared');
  assert.equal(preWriteFileCount(repo, SID), 0);
});

test('P4: INVALID schema → marker schema_invalid (INVALID never fail-OPEN), exit 0', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'inv.txt');
  fs.writeFileSync(file, 'v1');
  runHook(PRE_HOOK, repo, editInput('PreToolUse', file));
  fs.writeFileSync(path.join(stateDirOf(repo), 'schema_version'), '01\n'); // strict-regex INVALID
  const { exitCode } = runHook(POST_HOOK, repo, editInput('PostToolUse', file));
  assert.equal(exitCode, 0);
  assert.equal(marker(repo, file, SID).reason, 'schema_invalid');
  assert.equal(preWriteFileCount(repo, SID), 0);
  assert.equal(readState(repo, file), null);
});

test('P4: corrupt own lease → marker lease_unavailable (root cause preserved)', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'cl.txt');
  fs.writeFileSync(file, 'v1');
  runHook(PRE_HOOK, repo, editInput('PreToolUse', file));
  fs.writeFileSync(path.join(stateDirOf(repo), 'sessions', `${SID}.json`), '{ not json');
  const { exitCode } = runHook(POST_HOOK, repo, editInput('PostToolUse', file));
  assert.equal(exitCode, 0);
  assert.equal(marker(repo, file, SID).reason, 'lease_unavailable');
  assert.equal(preWriteFileCount(repo, SID), 0);
});

test('P4: SID_COLLISION (live foreign lease under our sid) → marker sid_collision', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'coll.txt');
  fs.writeFileSync(file, 'x');
  // Live foreign lease (pid 1) + anchor-matching baseline → #6 branch-2
  // collision. isAlive treats the EPERM from kill(1,0) as alive (fail-closed).
  fs.writeFileSync(
    path.join(stateDirOf(repo), 'sessions', `${SID}.json`),
    JSON.stringify({ schema_version: 1, pid: 1, uid: process.getuid(), start_ms: 5, renewed_ms: Date.now() })
  );
  fs.writeFileSync(
    path.join(stateDirOf(repo), 'baselines', `${SID}.txt`),
    JSON.stringify({ commit: 'X', lease_start_ms: 5, lease_pid: 1 })
  );
  const { exitCode } = runHook(POST_HOOK, repo, editInput('PostToolUse', file));
  assert.equal(exitCode, 0);
  assert.equal(marker(repo, file, SID).reason, 'sid_collision');
});

test('tool_use_id keys the Pre→Post join: parallel calls on one file stay distinct (R16)', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'par.txt');
  fs.writeFileSync(file, 'v1');
  const withId = (event, id) => ({ ...editInput(event, file), tool_use_id: id });
  // Two overlapping PreToolUse calls, distinct tool_use_ids.
  runHook(PRE_HOOK, repo, withId('PreToolUse', 'toolu_AAA'));
  fs.writeFileSync(file, 'v2'); // call A applies
  runHook(PRE_HOOK, repo, withId('PreToolUse', 'toolu_BBB'));
  assert.equal(preWriteFileCount(repo, SID), 2);
  const preDir = path.join(repo, '.claude', 'state', 'eghs', 'pre', SID);
  const hash = keyHash(canonKey(repo, file));
  assert.ok(fs.existsSync(path.join(preDir, `${hash}.toolu_AAA.write.json`)));
  assert.ok(fs.existsSync(path.join(preDir, `${hash}.toolu_BBB.write.json`)));
  // Post for A consumes only A's record; B's stays for its own Post.
  runHook(POST_HOOK, repo, withId('PostToolUse', 'toolu_AAA'));
  assert.ok(!fs.existsSync(path.join(preDir, `${hash}.toolu_AAA.write.json`)));
  assert.ok(fs.existsSync(path.join(preDir, `${hash}.toolu_BBB.write.json`)));
  assert.equal(readState(repo, file).evidence, 'post_edit_success'); // v1→v2 changed, no error
});
