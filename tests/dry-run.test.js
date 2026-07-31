'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const HOOKS = path.join(__dirname, '..', 'hooks');
const INIT_SCRIPT = path.join(HOOKS, 'init.js');
const SID = '11111111-1111-4111-8111-111111111111';

function mkRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-dryrun-')));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('node', [INIT_SCRIPT], { cwd: dir });
  return dir;
}

function stateDirOf(repo) {
  return path.join(repo, '.claude', 'state', 'eghs');
}

// Every file under the state dir with its bytes — a dry-run must leave this
// snapshot untouched (PRD §857: no state writes, not even a debug log line).
function snapshot(dir) {
  const out = {};
  const walk = (d, rel) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      const r = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) walk(p, r);
      else out[r] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir, '');
  return out;
}

function dryRun(repo, hook, input, extraEnv = {}) {
  const r = spawnSync('node', [path.join(HOOKS, hook), '--dry-run'], {
    cwd: repo,
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  return {
    exitCode: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    decision: lines.length === 1 ? JSON.parse(lines[0]) : null,
  };
}

function toolInput(tool, file, event) {
  return { session_id: SID, hook_event_name: event, tool_name: tool, tool_input: { file_path: file } };
}

test('pre-tool-use --dry-run prints one decision line, writes nothing, lists would_write', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'a.txt');
  fs.writeFileSync(file, 'hello');
  const before = snapshot(stateDirOf(repo));

  const { exitCode, decision, stderr } = dryRun(repo, 'pre-tool-use.js', toolInput('Edit', file, 'PreToolUse'));

  assert.equal(exitCode, 0);
  assert.equal(decision.decision, 'skip'); // state_gate_paths [] → gate not applicable
  assert.match(stderr, /dry-run: no state writes performed/);
  const stateDir = stateDirOf(repo);
  assert.ok(decision.would_write.includes(path.join(stateDir, 'sessions', `${SID}.guard.lock`)));
  assert.ok(decision.would_write.includes(path.join(stateDir, 'sessions', `${SID}.json`)));
  assert.ok(decision.would_write.includes(path.join(stateDir, 'baselines', `${SID}.txt`)));
  assert.ok(decision.would_write.some((p) => p.endsWith('.write.json')));
  assert.deepEqual(snapshot(stateDir), before);
});

test('pre-tool-use --dry-run reports the R3 gate deny (exit 2) without writing state', () => {
  const repo = mkRepo();
  fs.writeFileSync(path.join(repo, '.claude', 'eghs.config.json'), JSON.stringify({ state_gate_paths: ['*.txt'] }));
  const file = path.join(repo, 'gated.txt');
  fs.writeFileSync(file, 'unread');
  const before = snapshot(stateDirOf(repo));

  const { exitCode, decision } = dryRun(repo, 'pre-tool-use.js', toolInput('Edit', file, 'PreToolUse'));

  assert.equal(exitCode, 2);
  assert.equal(decision.decision, 'block');
  assert.equal(decision.deny_code, 'UNREAD_OR_STALE');
  assert.deepEqual(snapshot(stateDirOf(repo)), before);
});

test('pre-tool-use --dry-run surfaces the NO_SESSION fail-closed block', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'a.txt');
  fs.writeFileSync(file, 'x');
  const input = toolInput('Edit', file, 'PreToolUse');
  delete input.session_id;

  const { exitCode, decision } = dryRun(repo, 'pre-tool-use.js', input);

  assert.equal(exitCode, 2);
  assert.equal(decision.decision, 'block');
  assert.equal(decision.deny_code, 'NO_SESSION');
});

test('kill switch and CI passthrough report decision kill_switch (exit 0)', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'a.txt');
  fs.writeFileSync(file, 'x');

  fs.writeFileSync(path.join(repo, '.claude', 'eghs-off'), '');
  const killed = dryRun(repo, 'pre-tool-use.js', toolInput('Edit', file, 'PreToolUse'));
  assert.equal(killed.exitCode, 0);
  assert.equal(killed.decision.decision, 'kill_switch');
  fs.unlinkSync(path.join(repo, '.claude', 'eghs-off'));

  const ci = dryRun(repo, 'pre-tool-use.js', toolInput('Edit', file, 'PreToolUse'), { CI: '1' });
  assert.equal(ci.exitCode, 0);
  assert.equal(ci.decision.decision, 'kill_switch');
});

test('post-tool-use --dry-run reports allow + the record paths, writes nothing', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'a.txt');
  fs.writeFileSync(file, 'hello');
  const before = snapshot(stateDirOf(repo));

  const { exitCode, decision } = dryRun(repo, 'post-tool-use.js', toolInput('Read', file, 'PostToolUse'));

  assert.equal(exitCode, 0);
  assert.equal(decision.decision, 'allow');
  assert.ok(decision.would_write.some((p) => p.startsWith(path.join(stateDirOf(repo), 'reads'))));
  assert.deepEqual(snapshot(stateDirOf(repo)), before);
});

test('stop --dry-run allows without running verification', () => {
  const repo = mkRepo();
  fs.writeFileSync(
    path.join(repo, '.claude', 'eghs.config.json'),
    JSON.stringify({ verification_commands: { typecheck: 'touch VERIFICATION_RAN' } })
  );
  const before = snapshot(stateDirOf(repo));

  const { exitCode, decision, stderr } = dryRun(repo, 'stop.js', { session_id: SID, hook_event_name: 'Stop' });

  assert.equal(exitCode, 0);
  assert.equal(decision.decision, 'allow');
  assert.match(decision.reason, /verification not executed/);
  assert.match(stderr, /dry-run: no state writes performed/);
  assert.ok(!fs.existsSync(path.join(repo, 'VERIFICATION_RAN')));
  assert.deepEqual(snapshot(stateDirOf(repo)), before);
});

test('user-prompt-submit --dry-run prints the decision JSON, not the context envelope', () => {
  const repo = mkRepo();
  const before = snapshot(stateDirOf(repo));

  const { exitCode, decision, stdout } = dryRun(repo, 'user-prompt-submit.js', {
    session_id: SID,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'hi',
  });

  assert.equal(exitCode, 0);
  assert.equal(decision.decision, 'allow');
  assert.ok(!stdout.includes('hookSpecificOutput'));
  assert.deepEqual(snapshot(stateDirOf(repo)), before);
});

test('unparseable stdin dry-runs as skip/input_parse (exit 0)', () => {
  const repo = mkRepo();
  const { exitCode, decision } = dryRun(repo, 'pre-tool-use.js', '{ not json');
  assert.equal(exitCode, 0);
  assert.equal(decision.decision, 'skip');
  assert.equal(decision.reason, 'input_parse');
});

test('a cleared sid (tombstone) dry-runs as the INFRA_NOT_READY sid_cleared block', () => {
  const repo = mkRepo();
  const file = path.join(repo, 'a.txt');
  fs.writeFileSync(file, 'x');
  fs.writeFileSync(
    path.join(stateDirOf(repo), 'sessions', `${SID}.tombstone`),
    JSON.stringify({ cleared_by_pid: 1, cleared_by_uid: process.getuid(), ts_ms: Date.now(), reason: 'test' })
  );

  const { exitCode, decision } = dryRun(repo, 'pre-tool-use.js', toolInput('Edit', file, 'PreToolUse'));

  assert.equal(exitCode, 2);
  assert.equal(decision.deny_code, 'INFRA_NOT_READY');
  assert.equal(decision.reason, 'sid_cleared');
  // The tombstone short-circuit precedes the guard: nothing was "would-written".
  assert.deepEqual(decision.would_write, []);
});
