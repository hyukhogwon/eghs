'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn, spawnSync } = require('child_process');

const WATCHER = path.join(__dirname, '..', 'hooks', 'bypass-watcher.js');
const INIT_SCRIPT = path.join(__dirname, '..', 'hooks', 'init.js');

function mkRepo(gatePaths = ['**/*.ts']) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-watcher-')));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('node', [INIT_SCRIPT], { cwd: dir });
  fs.writeFileSync(
    path.join(dir, '.claude', 'eghs.config.json'),
    JSON.stringify({ state_gate_paths: gatePaths })
  );
  return dir;
}

function stateDir(repo) {
  return path.join(repo, '.claude', 'state', 'eghs');
}

function run(repo, args = ['--once'], extraEnv = {}) {
  const r = spawnSync('node', [WATCHER, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

function observations(repo) {
  const p = path.join(stateDir(repo), 'debug', 'bypass-watcher.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// The same canonical key the hooks compute (PRD §R2): realpath, then
// lowercase(NFC(...)) iff this repo's probe says the filesystem is caseless.
function canonicalKeyOf(repo, file) {
  const info = JSON.parse(fs.readFileSync(path.join(stateDir(repo), 'fs-info.json'), 'utf8'));
  const real = fs.realpathSync(file);
  return info.caseless_fs ? real.normalize('NFC').toLowerCase() : real;
}

// Fake the evidence a completed Read/Edit cycle would have left, so the
// watcher can tell an EGHS-observed edit from an unattributed one.
function recordEvidence(repo, file, contents, evidence = 'post_edit_success') {
  const key = canonicalKeyOf(repo, file);
  const hash = crypto.createHash('sha1').update(key).digest('hex');
  fs.writeFileSync(
    path.join(stateDir(repo), 'reads', `${hash}.json`),
    JSON.stringify({ schema_version: 1, file: key, sha: sha256(contents), ts_ms: Date.now(), sid: 'x', evidence })
  );
}

test('the first poll only records a baseline — nothing is a bypass yet', () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'a.ts'), 'one');
  const { exitCode } = run(repo);
  assert.equal(exitCode, 0);
  assert.deepEqual(observations(repo), []);
  const snap = JSON.parse(fs.readFileSync(path.join(stateDir(repo), 'debug', '.bypass-snapshot.json'), 'utf8'));
  assert.equal(Object.keys(snap.files).length, 1);
});

test('an unattributed change to a watched file is reported', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'a.ts');
  fs.writeFileSync(file, 'one');
  run(repo);
  fs.writeFileSync(file, 'two'); // as if by Bash
  run(repo);
  const obs = observations(repo);
  assert.equal(obs.length, 1);
  assert.equal(obs[0].event, 'bypass_observed');
  assert.equal(obs[0].prev_sha, sha256('one'));
  assert.equal(obs[0].new_sha, sha256('two'));
  assert.equal(obs[0].path, canonicalKeyOf(repo, file));
  assert.equal(typeof obs[0].ts_ms, 'number');
});

test('a change already attributed to post_edit_success evidence is NOT a bypass', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'a.ts');
  fs.writeFileSync(file, 'one');
  run(repo);
  fs.writeFileSync(file, 'two');
  recordEvidence(repo, file, 'two');
  run(repo);
  assert.deepEqual(observations(repo), []);
});

test('evidence for a DIFFERENT sha does not attribute the change', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'a.ts');
  fs.writeFileSync(file, 'one');
  run(repo);
  fs.writeFileSync(file, 'two');
  recordEvidence(repo, file, 'stale-contents'); // records some other sha
  run(repo);
  assert.equal(observations(repo).length, 1);
});

test('a full_read record does not attribute a change — only an edit can', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'a.ts');
  fs.writeFileSync(file, 'one');
  run(repo);
  fs.writeFileSync(file, 'two');
  recordEvidence(repo, file, 'two', 'full_read');
  run(repo);
  assert.equal(observations(repo).length, 1);
});

test('files outside state_gate_paths are not watched', () => {
  const repo = mkRepo(['**/*.ts']);
  const file = path.join(repo, 'notes.md');
  fs.writeFileSync(file, 'one');
  run(repo);
  fs.writeFileSync(file, 'two');
  run(repo);
  assert.deepEqual(observations(repo), []);
});

// Creations and deletions are snapshot-only by design: a subsequent Edit on a
// newly created file denies with UNREAD_OR_STALE, never RACE_DETECTED, so
// emitting them would drag §5's detection rate down for a case the metric was
// never defined over.
test('a newly created watched file is baselined, not reported', () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'a.ts'), 'one');
  run(repo);
  fs.writeFileSync(path.join(repo, 'b.ts'), 'new file');
  run(repo);
  assert.deepEqual(observations(repo), []);
  const snap = JSON.parse(fs.readFileSync(path.join(stateDir(repo), 'debug', '.bypass-snapshot.json'), 'utf8'));
  assert.equal(Object.keys(snap.files).length, 2);
});

test('a deleted watched file drops out of the snapshot without an observation', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'a.ts');
  fs.writeFileSync(file, 'one');
  run(repo);
  fs.unlinkSync(file);
  run(repo);
  assert.deepEqual(observations(repo), []);
  const snap = JSON.parse(fs.readFileSync(path.join(stateDir(repo), 'debug', '.bypass-snapshot.json'), 'utf8'));
  assert.deepEqual(snap.files, {});
});

test('the kill switch stops the watcher with zero writes (G5)', () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'a.ts'), 'one');
  const { exitCode, stderr } = run(repo, ['--once'], { EGHS_DISABLED: '1' });
  assert.equal(exitCode, 0);
  assert.match(stderr, /kill-switch/);
  assert.equal(fs.existsSync(path.join(stateDir(repo), 'debug', '.bypass-snapshot.json')), false);
  assert.deepEqual(observations(repo), []);
});

test('a corrupt snapshot is treated as a first poll, not a crash', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'a.ts');
  fs.writeFileSync(file, 'one');
  run(repo);
  fs.writeFileSync(path.join(stateDir(repo), 'debug', '.bypass-snapshot.json'), '{not json');
  fs.writeFileSync(file, 'two');
  const { exitCode } = run(repo);
  assert.equal(exitCode, 0);
  assert.deepEqual(observations(repo), []); // re-baselined
  const snap = JSON.parse(fs.readFileSync(path.join(stateDir(repo), 'debug', '.bypass-snapshot.json'), 'utf8'));
  assert.equal(Object.keys(snap.files).length, 1);
});

test('the observation log rotates once it exceeds its size cap', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'a.ts');
  const logPath = path.join(stateDir(repo), 'debug', 'bypass-watcher.jsonl');
  fs.writeFileSync(file, 'one');
  run(repo);
  fs.writeFileSync(logPath, 'x'.repeat(200) + '\n');
  fs.writeFileSync(file, 'two');
  run(repo, ['--once', '--max-log-bytes', '100']);
  assert.ok(fs.existsSync(`${logPath}.1`));
  assert.equal(observations(repo).length, 1); // fresh log holds only the new line
});

test('an uninitialized state dir aborts with the eghs-init remediation', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-watcher-bare-')));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const { exitCode, stderr } = run(dir);
  assert.equal(exitCode, 1);
  assert.match(stderr, /init\.js/);
});

test('the EGHS state dir and .git are never walked', () => {
  const repo = mkRepo(['**/*.json']);
  run(repo); // baseline
  // Touch a file inside the state dir that WOULD match the glob.
  fs.writeFileSync(path.join(stateDir(repo), 'fs-info.json'), '{"tampered":true}');
  run(repo);
  const paths = observations(repo).map((o) => o.path);
  assert.equal(paths.some((p) => p.includes(path.join('state', 'eghs'))), false);
});

// One-shot must fail loudly; a daemon that is meant to run for hours must not
// be killed by a single bad poll (a config saved mid-edit, a transient EACCES).
test('a broken config aborts --once', () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'a.ts'), 'one');
  fs.writeFileSync(path.join(repo, '.claude', 'eghs.config.json'), '{not json');
  const { exitCode, stderr } = run(repo);
  assert.equal(exitCode, 1);
  assert.match(stderr, /eghs\.config\.json/);
});

test('in daemon mode a failing poll is logged and the watcher keeps running', async () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, 'a.ts'), 'one');
  const child = spawn('node', [WATCHER, '--interval-seconds', '1'], { cwd: repo, encoding: 'utf8' });
  let stderr = '';
  child.stderr.setEncoding('utf8');

  try {
    // Break the config only AFTER the first poll succeeded, so the failure
    // lands on a subsequent tick rather than on startup.
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`watcher never polled: ${stderr}`)), 10000);
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        if (stderr.includes('baseline recorded')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.on('exit', (code) => reject(new Error(`watcher exited early (${code}): ${stderr}`)));
    });

    fs.writeFileSync(path.join(repo, '.claude', 'eghs.config.json'), '{not json');

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`no retry line: ${stderr}`)), 10000);
      const check = () => {
        if (stderr.includes('retrying next tick')) {
          clearTimeout(timeout);
          resolve();
        }
      };
      child.stderr.on('data', check);
      child.on('exit', (code) => reject(new Error(`watcher died on a bad poll (${code}): ${stderr}`)));
      check();
    });

    assert.equal(child.exitCode, null, 'watcher should still be running');
  } finally {
    child.removeAllListeners('exit');
    child.kill('SIGKILL');
  }
});
