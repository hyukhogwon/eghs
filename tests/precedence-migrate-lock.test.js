'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { checkMigrateLock, classifyCandidate } = require('../hooks/lib/precedence');

function mkStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-mlock-'));
}

function writeLock(dir, body) {
  fs.writeFileSync(path.join(dir, 'migrate.lock'), typeof body === 'string' ? body : JSON.stringify(body));
}

const UID = process.getuid();

test('#4 absent migrate.lock → null (continue)', () => {
  assert.equal(checkMigrateLock(mkStateDir(), { uid: UID, nowMs: Date.now() }), null);
});

test('#4 live same-uid lock → MIGRATE_IN_PROGRESS candidate', () => {
  const dir = mkStateDir();
  writeLock(dir, { pid: process.pid, uid: UID, start_ms: Date.now(), role: 'migrate' });
  const r = checkMigrateLock(dir, { uid: UID, nowMs: Date.now() });
  assert.equal(r.candidate, 'MIGRATE_IN_PROGRESS');
  assert.ok(fs.existsSync(path.join(dir, 'migrate.lock')), 'live lock must survive');
});

test('#4 same-uid dead lock past 600s grace → stale-deleted, null', () => {
  const dir = mkStateDir();
  const deadPid = spawnSync('node', ['-e', '']).pid;
  writeLock(dir, { pid: deadPid, uid: UID, start_ms: Date.now() - 700000, role: 'migrate' });
  assert.equal(checkMigrateLock(dir, { uid: UID, nowMs: Date.now() }), null);
  assert.ok(!fs.existsSync(path.join(dir, 'migrate.lock')));
});

test('#4 same-uid dead lock WITHIN grace → MIGRATE_IN_PROGRESS (crash protection)', () => {
  const dir = mkStateDir();
  const deadPid = spawnSync('node', ['-e', '']).pid;
  writeLock(dir, { pid: deadPid, uid: UID, start_ms: Date.now() - 1000, role: 'migrate' });
  const r = checkMigrateLock(dir, { uid: UID, nowMs: Date.now() });
  assert.equal(r.candidate, 'MIGRATE_IN_PROGRESS');
  assert.ok(fs.existsSync(path.join(dir, 'migrate.lock')));
});

test('#4 corrupt body → INFRA_NOT_READY with reason migrate_lock_corrupt (after 1 retry)', () => {
  const dir = mkStateDir();
  writeLock(dir, '{ nope');
  const r = checkMigrateLock(dir, { uid: UID, nowMs: Date.now() });
  assert.equal(r.candidate, 'INFRA_NOT_READY');
  assert.equal(r.reason, 'migrate_lock_corrupt');
  assert.ok(fs.existsSync(path.join(dir, 'migrate.lock')), 'corrupt lock is never auto-deleted');
});

test('#4 non-regular type (directory) → INFRA_NOT_READY migrate_lock_corrupt', () => {
  const dir = mkStateDir();
  fs.mkdirSync(path.join(dir, 'migrate.lock'));
  const r = checkMigrateLock(dir, { uid: UID, nowMs: Date.now() });
  assert.equal(r.candidate, 'INFRA_NOT_READY');
  assert.equal(r.reason, 'migrate_lock_corrupt');
});

test('#4 foreign-uid lock within 2h grace → MIGRATE_IN_PROGRESS; past grace → INFRA_NOT_READY', () => {
  const dir = mkStateDir();
  writeLock(dir, { pid: 1, uid: UID + 1, start_ms: Date.now() - 1000, role: 'migrate' });
  assert.equal(checkMigrateLock(dir, { uid: UID, nowMs: Date.now() }).candidate, 'MIGRATE_IN_PROGRESS');
  writeLock(dir, { pid: 1, uid: UID + 1, start_ms: Date.now() - 7300000, role: 'migrate' });
  const stale = checkMigrateLock(dir, { uid: UID, nowMs: Date.now() });
  assert.equal(stale.candidate, 'INFRA_NOT_READY');
  assert.equal(stale.reason, 'infra_not_ready');
  assert.ok(fs.existsSync(path.join(dir, 'migrate.lock')), 'foreign lock is never auto-deleted');
});

// ---- hook-type reclassification matrix (PRD R6 #4 table) ----

test('matrix: UserPromptSubmit is fail-soft exit0 for every candidate', () => {
  for (const candidate of ['MIGRATE_IN_PROGRESS', 'INFRA_NOT_READY', 'SID_COLLISION']) {
    const a = classifyCandidate('ups', { candidate, reason: 'infra_not_ready' });
    assert.equal(a.action, 'exit0');
    assert.equal(typeof a.additionalContext, 'string');
  }
});

test('matrix: Stop masks MIGRATE_IN_PROGRESS as INFRA_NOT_READY (auto-unblock No), keeps SID_COLLISION', () => {
  assert.equal(classifyCandidate('stop', { candidate: 'MIGRATE_IN_PROGRESS' }).denyCode, 'INFRA_NOT_READY');
  assert.equal(classifyCandidate('stop', { candidate: 'INFRA_NOT_READY', reason: 'infra_not_ready' }).denyCode, 'INFRA_NOT_READY');
  assert.equal(classifyCandidate('stop', { candidate: 'SID_COLLISION' }).denyCode, 'SID_COLLISION');
  assert.equal(classifyCandidate('stop', { candidate: 'MIGRATE_IN_PROGRESS' }).action, 'deny');
});

test('matrix: PostToolUse Write/Edit → marker + exit0 with the root-cause reason', () => {
  assert.deepEqual(classifyCandidate('post-write', { candidate: 'MIGRATE_IN_PROGRESS' }), {
    action: 'marker_exit0',
    markerReason: 'migrate_in_progress',
  });
  assert.deepEqual(classifyCandidate('post-write', { candidate: 'INFRA_NOT_READY', reason: 'migrate_lock_corrupt' }), {
    action: 'marker_exit0',
    markerReason: 'migrate_lock_corrupt',
  });
  assert.deepEqual(classifyCandidate('post-write', { candidate: 'INFRA_NOT_READY', reason: 'sid_cleared' }), {
    action: 'marker_exit0',
    markerReason: 'sid_cleared',
  });
  assert.deepEqual(classifyCandidate('post-write', { candidate: 'SID_COLLISION' }), {
    action: 'marker_exit0',
    markerReason: 'sid_collision',
  });
});

test('matrix: PostToolUse Read → plain exit0 (read-only fallback)', () => {
  for (const candidate of ['MIGRATE_IN_PROGRESS', 'INFRA_NOT_READY', 'SID_COLLISION']) {
    assert.equal(classifyCandidate('post-read', { candidate, reason: 'infra_not_ready' }).action, 'exit0');
  }
});

test('matrix: PreToolUse Write/Read → deny with the candidate code and auto-unblock flag', () => {
  for (const kind of ['pre-write', 'pre-read']) {
    const mig = classifyCandidate(kind, { candidate: 'MIGRATE_IN_PROGRESS' });
    assert.deepEqual(mig, { action: 'deny', denyCode: 'MIGRATE_IN_PROGRESS', autoUnblock: true, reason: undefined });
    const infra = classifyCandidate(kind, { candidate: 'INFRA_NOT_READY', reason: 'sid_cleared' });
    assert.deepEqual(infra, { action: 'deny', denyCode: 'INFRA_NOT_READY', autoUnblock: false, reason: 'sid_cleared' });
    const col = classifyCandidate(kind, { candidate: 'SID_COLLISION' });
    assert.equal(col.denyCode, 'SID_COLLISION');
    assert.equal(col.autoUnblock, false);
  }
});

// ---- P4 finale: the read rows must stay mutation-free under a live lock ----

test('#4 a live migrate.lock leaves the state dir byte-identical for the read rows', () => {
  const { execFileSync } = require('child_process');
  const { runPrecedence } = require('../hooks/lib/precedence');
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-mlock-repo-')));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('node', [path.join(__dirname, '..', 'hooks', 'init.js')], { cwd: repo });
  const stateDir = path.join(repo, '.claude', 'state', 'eghs');
  writeLock(stateDir, { pid: process.pid, uid: UID, start_ms: Date.now(), role: 'migrate' });

  const snapshot = () =>
    fs
      .readdirSync(stateDir, { recursive: true })
      .sort()
      .join('\n');
  const before = snapshot();

  for (const kind of ['post-read', 'ups']) {
    const r = runPrecedence(kind, { session_id: '11111111-1111-4111-8111-111111111111' }, {
      env: {},
      cwd: repo,
      nowMs: Date.now(),
    });
    assert.notEqual(r.outcome, 'continue');
  }
  // The guard.lock create in #3.7 is the one sanctioned write; nothing else
  // (no lease, no baseline, no debug log) may appear while migrate holds.
  const after = snapshot()
    .split('\n')
    .filter((n) => !n.endsWith('.guard.lock'))
    .join('\n');
  assert.equal(after, before);
});
