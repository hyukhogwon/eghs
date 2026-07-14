'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { runPrecedence } = require('../hooks/lib/precedence');

const INIT_SCRIPT = path.join(__dirname, '..', 'hooks', 'init.js');
const SID = '11111111-1111-4111-8111-111111111111';

function mkRepo({ init = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-run-')));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  });
  if (init) execFileSync('node', [INIT_SCRIPT], { cwd: dir });
  return dir;
}

function stateDirOf(repo) {
  return path.join(repo, '.claude', 'state', 'eghs');
}

function run(kind, repo, { sid = SID, env = {} } = {}) {
  return runPrecedence(kind, { session_id: sid }, { env, cwd: repo, nowMs: Date.now() });
}

function closeGuard(r) {
  if (r.ctx && typeof r.ctx.guardFd === 'number') fs.closeSync(r.ctx.guardFd);
}

test('healthy state: continue with a live lease/baseline written and ctx populated', () => {
  const repo = mkRepo();
  const r = run('pre-write', repo);
  assert.equal(r.outcome, 'continue');
  assert.equal(r.ctx.sid, SID);
  assert.ok(r.ctx.lease && r.ctx.lease.pid === process.ppid);
  assert.ok(fs.existsSync(path.join(stateDirOf(repo), 'sessions', `${SID}.json`)));
  assert.ok(fs.existsSync(path.join(stateDirOf(repo), 'baselines', `${SID}.txt`)));
  assert.ok(r.ctx.config && Array.isArray(r.ctx.config.state_gate_paths));
  closeGuard(r);
});

test('kill switch short-circuits before any lease write', () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, '.claude', 'eghs-off'), '');
  const r = run('pre-write', repo);
  assert.equal(r.outcome, 'exit0');
  assert.ok(!fs.existsSync(path.join(stateDirOf(repo), 'sessions', `${SID}.json`)));
});

test('#7 NOT_INITIALIZED per-hook: pre → SCHEMA_NOT_INITIALIZED, stop → INFRA block, ups → soft', () => {
  const repo = mkRepo({ init: false });
  const pre = run('pre-write', repo);
  assert.equal(pre.outcome, 'deny');
  assert.equal(pre.denyCode, 'SCHEMA_NOT_INITIALIZED');
  assert.equal(pre.autoUnblock, true);

  const stop = run('stop', repo);
  assert.equal(stop.outcome, 'deny');
  assert.equal(stop.denyCode, 'INFRA_NOT_READY');
  assert.equal(stop.autoUnblock, false);

  const ups = run('ups', repo);
  assert.equal(ups.outcome, 'exit0');
  assert.match(ups.additionalContext, /eghs-init/);

  assert.equal(run('post-write', repo).outcome, 'exit0');
  assert.equal(run('post-read', repo).outcome, 'exit0');
});

test('#7 FS_INFO_MISSING: pre → FS_INFO_MISSING(auto Yes); stop still verifies (continue)', () => {
  const repo = mkRepo();
  fs.rmSync(path.join(stateDirOf(repo), 'fs-info.json'));
  const pre = run('pre-write', repo);
  assert.equal(pre.denyCode, 'FS_INFO_MISSING');
  assert.equal(pre.autoUnblock, true);
  const stop = run('stop', repo);
  assert.equal(stop.outcome, 'continue', 'Stop runs verification even with fs-info missing');
  closeGuard(stop);
});

test('#7 INVALID schema: pre → INFRA_NOT_READY(No); post-write → marker schema_invalid + exit0', () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(stateDirOf(repo), 'schema_version'), '01\n'); // strict-regex INVALID
  const pre = run('pre-write', repo);
  assert.equal(pre.denyCode, 'INFRA_NOT_READY');
  assert.equal(pre.autoUnblock, false);
  const pw = run('post-write', repo);
  assert.equal(pw.outcome, 'marker_exit0');
  assert.equal(pw.markerReason, 'schema_invalid');
});

test('#7 MISMATCH (higher on-disk schema): pre → SCHEMA_MISMATCH(No)', () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(stateDirOf(repo), 'schema_version'), '2\n');
  const pre = run('pre-write', repo);
  assert.equal(pre.denyCode, 'SCHEMA_MISMATCH');
  assert.equal(pre.autoUnblock, false);
});

test('#4 live migrate.lock: pre → MIGRATE_IN_PROGRESS, no lease written', () => {
  const repo = mkRepo();
  fs.writeFileSync(
    path.join(stateDirOf(repo), 'migrate.lock'),
    JSON.stringify({ pid: process.pid, uid: process.getuid(), start_ms: Date.now(), role: 'migrate' })
  );
  const r = run('pre-write', repo);
  assert.equal(r.denyCode, 'MIGRATE_IN_PROGRESS');
  assert.ok(!fs.existsSync(path.join(stateDirOf(repo), 'sessions', `${SID}.json`)));
});

test('#6 SID_COLLISION: a live foreign lease under our sid → deny SID_COLLISION', () => {
  const repo = mkRepo();
  const sd = stateDirOf(repo);
  // Seed a live foreign lease (parent pid) + matching baseline anchor.
  fs.writeFileSync(
    path.join(sd, 'sessions', `${SID}.json`),
    JSON.stringify({ schema_version: 1, pid: process.pid, uid: process.getuid(), start_ms: 5, renewed_ms: 5 })
  );
  fs.writeFileSync(
    path.join(sd, 'baselines', `${SID}.txt`),
    JSON.stringify({ commit: 'X', lease_start_ms: 5, lease_pid: process.pid })
  );
  // The hook runs as ppid; process.pid is a live foreign pid from its view.
  const r = run('pre-write', repo);
  assert.equal(r.denyCode, 'SID_COLLISION');
  assert.equal(r.autoUnblock, false);
});

test('#3.7 tombstone: pre → INFRA_NOT_READY sid_cleared', () => {
  const repo = mkRepo();
  fs.writeFileSync(
    path.join(stateDirOf(repo), 'sessions', `${SID}.tombstone`),
    JSON.stringify({ cleared_by_pid: 1, cleared_by_uid: process.getuid(), ts_ms: 1, reason: 'clear-sid' })
  );
  const r = run('pre-write', repo);
  assert.equal(r.denyCode, 'INFRA_NOT_READY');
  assert.equal(r.reason, 'sid_cleared');
});

test('NO_SESSION: pre fail-closed deny, post short-circuit exit0', () => {
  const repo = mkRepo();
  assert.equal(run('pre-write', repo, { sid: 'bad' }).denyCode, 'NO_SESSION');
  assert.equal(run('post-write', repo, { sid: 'bad' }).outcome, 'exit0');
});
