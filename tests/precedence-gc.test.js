'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { gcPass } = require('../hooks/lib/precedence');
const { DEFAULT_CONFIG } = require('../hooks/lib/config');

const INIT_SCRIPT = path.join(__dirname, '..', 'hooks', 'init.js');
const SID = '11111111-1111-4111-8111-111111111111';
const DEAD_SID = '99999999-9999-4999-8999-999999999999';

// gcPass reads staleness knobs off the config; the P4 keys land in unit 9's
// config change, so tests inject them explicitly for now.
const CFG = { ...DEFAULT_CONFIG, session_stale_seconds: 86400, tombstone_stale_seconds: 3600 };

function mkRepo({ init = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-gc-')));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  if (init) execFileSync('node', [INIT_SCRIPT], { cwd: dir });
  return dir;
}

function stateDirOf(repo) {
  return path.join(repo, '.claude', 'state', 'eghs');
}

function ctxFor(repo, { diskSchema = 1 } = {}) {
  return { stateDir: stateDirOf(repo), sid: SID, diskSchema, nowMs: Date.now() };
}

test('#5b: gcPass cascades a dead stale lease (guard/baseline/pre/failed/stop-locks all gone)', () => {
  const repo = mkRepo();
  const sd = stateDirOf(repo);
  const deadPid = spawnSync('node', ['-e', '']).pid;
  fs.writeFileSync(
    path.join(sd, 'sessions', `${DEAD_SID}.json`),
    JSON.stringify({ pid: deadPid, uid: process.getuid(), start_ms: 1, renewed_ms: 1 })
  );
  fs.writeFileSync(path.join(sd, 'sessions', `${DEAD_SID}.guard.lock`), '');
  fs.writeFileSync(path.join(sd, 'baselines', `${DEAD_SID}.txt`), '{}');
  fs.mkdirSync(path.join(sd, 'pre', DEAD_SID), { recursive: true });
  fs.writeFileSync(path.join(sd, 'pre', DEAD_SID, 'aa.toolu_A.write.json'), '{}');
  fs.writeFileSync(path.join(sd, 'locks', `stop-${DEAD_SID}.lock`), '{}');
  assert.equal(gcPass(ctxFor(repo), CFG), null);
  assert.ok(!fs.existsSync(path.join(sd, 'sessions', `${DEAD_SID}.json`)));
  assert.ok(!fs.existsSync(path.join(sd, 'sessions', `${DEAD_SID}.guard.lock`)));
  assert.ok(!fs.existsSync(path.join(sd, 'baselines', `${DEAD_SID}.txt`)));
  assert.ok(!fs.existsSync(path.join(sd, 'pre', DEAD_SID)));
  assert.ok(!fs.existsSync(path.join(sd, 'locks', `stop-${DEAD_SID}.lock`)));
});

test('#5a: gcPass reclaims an own-uid dead recover.lock past its grace, keeps foreign ones', () => {
  const repo = mkRepo();
  const sd = stateDirOf(repo);
  const deadPid = spawnSync('node', ['-e', '']).pid;
  const mine = path.join(sd, 'locks', `stop-${DEAD_SID}.recover.lock`);
  const foreign = path.join(sd, 'locks', `stop-${SID}.recover.lock`);
  fs.writeFileSync(mine, JSON.stringify({ pid: deadPid, uid: process.getuid(), start_ms: Date.now() - 70000, recovery_grace_ms: 60000 }));
  fs.writeFileSync(foreign, JSON.stringify({ pid: deadPid, uid: process.getuid() + 1, start_ms: 1, recovery_grace_ms: 60000 }));
  gcPass(ctxFor(repo), CFG);
  assert.ok(!fs.existsSync(mine));
  assert.ok(fs.existsSync(foreign));
});

test('#5b: 24h-old pre/ files are GCed here (and only here)', () => {
  const repo = mkRepo();
  const sd = stateDirOf(repo);
  fs.mkdirSync(path.join(sd, 'pre', SID), { recursive: true });
  const oldFile = path.join(sd, 'pre', SID, 'aa.toolu_A.write.json');
  fs.writeFileSync(oldFile, '{}');
  const old = new Date(Date.now() - 25 * 3600 * 1000);
  fs.utimesSync(oldFile, old, old);
  gcPass(ctxFor(repo), CFG);
  assert.ok(!fs.existsSync(oldFile));
});

test('#5c: missing subdir with healthy schema → INFRA_NOT_READY candidate', () => {
  const repo = mkRepo();
  fs.rmSync(path.join(stateDirOf(repo), 'reads'), { recursive: true, force: true });
  const r = gcPass(ctxFor(repo), CFG);
  assert.equal(r.candidate, 'INFRA_NOT_READY');
  assert.equal(r.reason, 'infra_not_ready');
});

test('#5c: clean install (diskSchema null) defers to #7 — no candidate, no mkdir', () => {
  const repo = mkRepo({ init: false });
  fs.mkdirSync(stateDirOf(repo), { recursive: true });
  assert.equal(gcPass(ctxFor(repo, { diskSchema: null }), CFG), null);
  assert.ok(!fs.existsSync(path.join(stateDirOf(repo), 'reads')), 'gcPass must never bootstrap dirs');
});

test('#5b: a sid with a tombstone is skipped (clear-sid owns its cascade)', () => {
  const repo = mkRepo();
  const sd = stateDirOf(repo);
  const deadPid = spawnSync('node', ['-e', '']).pid;
  fs.writeFileSync(
    path.join(sd, 'sessions', `${DEAD_SID}.json`),
    JSON.stringify({ pid: deadPid, uid: process.getuid(), start_ms: 1, renewed_ms: 1 })
  );
  fs.writeFileSync(
    path.join(sd, 'sessions', `${DEAD_SID}.tombstone`),
    JSON.stringify({ cleared_by_pid: process.pid, cleared_by_uid: process.getuid(), ts_ms: Date.now(), reason: 'clear-sid' })
  );
  gcPass(ctxFor(repo), CFG);
  assert.ok(fs.existsSync(path.join(sd, 'sessions', `${DEAD_SID}.json`)), 'tombstoned sid must be left to --clear-sid');
});

// ---- P4 finale: orphan baseline sweep ----

test('#5b: a baseline with no lease, aged past the grace, is swept', () => {
  const repo = mkRepo();
  const sd = stateDirOf(repo);
  const bp = path.join(sd, 'baselines', `${DEAD_SID}.txt`);
  fs.writeFileSync(bp, '{}');
  const old = Date.now() / 1000 - 7200;
  fs.utimesSync(bp, old, old);
  assert.equal(gcPass(ctxFor(repo), CFG), null);
  assert.ok(!fs.existsSync(bp));
});

test('#5b: a fresh baseline with no lease is kept (grace covers the write window)', () => {
  const repo = mkRepo();
  const bp = path.join(stateDirOf(repo), 'baselines', `${DEAD_SID}.txt`);
  fs.writeFileSync(bp, '{}');
  assert.equal(gcPass(ctxFor(repo), CFG), null);
  assert.ok(fs.existsSync(bp));
});

test('#5b: a baseline whose lease still exists is never swept, however old', () => {
  const repo = mkRepo();
  const sd = stateDirOf(repo);
  fs.writeFileSync(
    path.join(sd, 'sessions', `${SID}.json`),
    JSON.stringify({ pid: process.pid, uid: process.getuid(), start_ms: 1, renewed_ms: Date.now() })
  );
  const bp = path.join(sd, 'baselines', `${SID}.txt`);
  fs.writeFileSync(bp, '{}');
  const old = Date.now() / 1000 - 7200;
  fs.utimesSync(bp, old, old);
  assert.equal(gcPass(ctxFor(repo), CFG), null);
  assert.ok(fs.existsSync(bp));
});
