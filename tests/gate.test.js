'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { evaluateGate } = require('../hooks/lib/gate');
const { canonicalKey, keyHash } = require('../hooks/lib/canonical');
const { writeReadState, writeFailedMarker } = require('../hooks/lib/read-state');

const INIT_SCRIPT = path.join(__dirname, '..', 'hooks', 'init.js');
const SID = '11111111-1111-4111-8111-111111111111';
const OTHER_SID = '22222222-2222-4222-8222-222222222222';

function mkRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-gate-')));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('node', [INIT_SCRIPT], { cwd: dir });
  return dir;
}

function stateDirOf(repo) {
  return path.join(repo, '.claude', 'state', 'eghs');
}

function caselessOf(repo) {
  return JSON.parse(fs.readFileSync(path.join(stateDirOf(repo), 'fs-info.json'), 'utf8')).caseless_fs;
}

function ctxFor(repo, { gatePaths = ['**/*.ts'], leaseStartMs = 1000 } = {}) {
  const caseless = caselessOf(repo);
  return {
    stateDir: stateDirOf(repo),
    repoRoot: repo,
    sid: SID,
    caseless,
    config: { state_gate_paths: gatePaths, stale_after_seconds: 1800 },
    lease: { start_ms: leaseStartMs, pid: process.ppid },
  };
}

function sha(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function keyOf(repo, file, caseless) {
  return canonicalKey(file, { caseless }).key;
}

test('non-matching path → skip not_applicable (dark default of [] never gates)', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'src', 'x.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'code');
  const ctx = ctxFor(repo, { gatePaths: [] });
  const r = evaluateGate(ctx, file, { nowMs: 2000 });
  assert.equal(r.skip, 'not_applicable');
  assert.equal(r.preSha, null);
});

test('matching path but out-of-repo → skip outside_repo', () => {
  const repo = mkRepo();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-out-')));
  const file = path.join(outside, 'a.ts');
  fs.writeFileSync(file, 'x');
  const r = evaluateGate(ctxFor(repo), file, { nowMs: 2000 });
  assert.equal(r.skip, 'outside_repo');
});

test('matched + no state → UNREAD_OR_STALE', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'a.ts');
  fs.writeFileSync(file, 'code');
  const r = evaluateGate(ctxFor(repo), file, { nowMs: 2000 });
  assert.equal(r.allow, false);
  assert.equal(r.denyCode, 'UNREAD_OR_STALE');
});

test('matched + full_read for our sid + matching sha + fresh → allow with preSha', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'a.ts');
  fs.writeFileSync(file, 'code');
  const ctx = ctxFor(repo);
  const key = keyOf(repo, file, ctx.caseless);
  writeReadState(ctx.stateDir, key, { file: key, sha: sha('code'), size: 4, ts_ms: 1500, sid: SID, evidence: 'full_read' });
  const r = evaluateGate(ctx, file, { nowMs: 2000 });
  assert.equal(r.allow, true);
  assert.equal(r.preSha, sha('code'));
});

test('post_edit_success evidence also passes', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'a.ts');
  fs.writeFileSync(file, 'code');
  const ctx = ctxFor(repo);
  const key = keyOf(repo, file, ctx.caseless);
  writeReadState(ctx.stateDir, key, { file: key, sha: sha('code'), size: 4, ts_ms: 1500, sid: SID, evidence: 'post_edit_success' });
  assert.equal(evaluateGate(ctx, file, { nowMs: 2000 }).allow, true);
});

test('partial_read / stale_read evidence never passes → UNREAD_OR_STALE', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'a.ts');
  fs.writeFileSync(file, 'code');
  const ctx = ctxFor(repo);
  const key = keyOf(repo, file, ctx.caseless);
  for (const evidence of ['partial_read', 'stale_read']) {
    writeReadState(ctx.stateDir, key, { file: key, sha: sha('code'), size: 4, ts_ms: 1500, sid: SID, evidence });
    assert.equal(evaluateGate(ctx, file, { nowMs: 2000 }).denyCode, 'UNREAD_OR_STALE');
  }
});

test('evidence from another sid → WRONG_SID', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'a.ts');
  fs.writeFileSync(file, 'code');
  const ctx = ctxFor(repo);
  const key = keyOf(repo, file, ctx.caseless);
  writeReadState(ctx.stateDir, key, { file: key, sha: sha('code'), size: 4, ts_ms: 1500, sid: OTHER_SID, evidence: 'full_read' });
  assert.equal(evaluateGate(ctx, file, { nowMs: 2000 }).denyCode, 'WRONG_SID');
});

test('disk sha changed since the Read → RACE_DETECTED', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'a.ts');
  fs.writeFileSync(file, 'code');
  const ctx = ctxFor(repo);
  const key = keyOf(repo, file, ctx.caseless);
  writeReadState(ctx.stateDir, key, { file: key, sha: sha('OLD'), size: 3, ts_ms: 1500, sid: SID, evidence: 'full_read' });
  assert.equal(evaluateGate(ctx, file, { nowMs: 2000 }).denyCode, 'RACE_DETECTED');
});

test('state older than stale_after_seconds → UNREAD_OR_STALE', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'a.ts');
  fs.writeFileSync(file, 'code');
  const ctx = ctxFor(repo);
  const key = keyOf(repo, file, ctx.caseless);
  writeReadState(ctx.stateDir, key, { file: key, sha: sha('code'), size: 4, ts_ms: 1000, sid: SID, evidence: 'full_read' });
  // nowMs - ts_ms = 1_800_001 ms > 1800s
  assert.equal(evaluateGate(ctx, file, { nowMs: 1000 + 1800 * 1000 + 1 }).denyCode, 'UNREAD_OR_STALE');
});

test('own sid-scoped marker blocks even with valid evidence → STATE_RECORD_FAILED', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'a.ts');
  fs.writeFileSync(file, 'code');
  const ctx = ctxFor(repo);
  const key = keyOf(repo, file, ctx.caseless);
  writeReadState(ctx.stateDir, key, { file: key, sha: sha('code'), size: 4, ts_ms: 1500, sid: SID, evidence: 'full_read' });
  writeFailedMarker(ctx.stateDir, key, { sid: SID, tsMs: 1600, reason: 'state_record_failed', sidScoped: true });
  assert.equal(evaluateGate(ctx, file, { nowMs: 2000 }).denyCode, 'STATE_RECORD_FAILED');
});

test('own sid-scoped marker with reason overwrite_race → OVERWRITE_RACE code', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'a.ts');
  fs.writeFileSync(file, 'code');
  const ctx = ctxFor(repo);
  const key = keyOf(repo, file, ctx.caseless);
  writeReadState(ctx.stateDir, key, { file: key, sha: sha('code'), size: 4, ts_ms: 1500, sid: SID, evidence: 'full_read' });
  writeFailedMarker(ctx.stateDir, key, { sid: SID, tsMs: 1600, reason: 'overwrite_race', sidScoped: true });
  assert.equal(evaluateGate(ctx, file, { nowMs: 2000 }).denyCode, 'OVERWRITE_RACE');
});

test('foreign key-scoped marker NEWER than our lease start blocks → STATE_RECORD_FAILED', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'a.ts');
  fs.writeFileSync(file, 'code');
  const ctx = ctxFor(repo, { leaseStartMs: 1000 });
  const key = keyOf(repo, file, ctx.caseless);
  writeReadState(ctx.stateDir, key, { file: key, sha: sha('code'), size: 4, ts_ms: 1500, sid: SID, evidence: 'full_read' });
  writeFailedMarker(ctx.stateDir, key, { sid: OTHER_SID, tsMs: 1600, reason: 'stale_read' }); // key-scoped, newer than lease
  assert.equal(evaluateGate(ctx, file, { nowMs: 2000 }).denyCode, 'STATE_RECORD_FAILED');
});

test('foreign key-scoped marker OLDER than our lease start is releasable → allow', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'a.ts');
  fs.writeFileSync(file, 'code');
  const ctx = ctxFor(repo, { leaseStartMs: 2000 });
  const key = keyOf(repo, file, ctx.caseless);
  writeReadState(ctx.stateDir, key, { file: key, sha: sha('code'), size: 4, ts_ms: 1900, sid: SID, evidence: 'full_read' });
  writeFailedMarker(ctx.stateDir, key, { sid: OTHER_SID, tsMs: 500, reason: 'stale_read' }); // predates lease
  assert.equal(evaluateGate(ctx, file, { nowMs: 2500 }).allow, true);
});

test('new-file Write (file absent) on a matched path → allow with preSha null (R4 handles)', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'new.ts'); // does not exist
  const r = evaluateGate(ctxFor(repo), file, { nowMs: 2000 });
  assert.equal(r.allow, true);
  assert.equal(r.preSha, null);
  assert.equal(r.newFile, true);
});
