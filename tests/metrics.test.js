'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { computeMetrics } = require('../hooks/lib/metrics');
const CLI = path.join(__dirname, '..', 'hooks', 'metrics.js');

const SID_A = '11111111-1111-4111-8111-111111111111';
const SID_B = '22222222-2222-4222-8222-222222222222';

function mkStateDir() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-metrics-')));
  fs.mkdirSync(path.join(dir, 'debug'), { recursive: true });
  return dir;
}

// One §5 event with the schema's defaults filled in, so each test only spells
// out the fields it is actually asserting on.
function ev(overrides) {
  return {
    schema_version: 1,
    ts_ms: 1000,
    sid: SID_A,
    hook: 'PreToolUse',
    tool: 'Edit',
    path: '/repo/a.ts',
    gate_applicable: false,
    has_gate_passing_state: false,
    evidence_kind: null,
    kill_switch: 'off',
    decision: 'allow',
    deny_code: null,
    latency_ms: 10,
    ...overrides,
  };
}

function writeLog(stateDir, sid, events) {
  fs.writeFileSync(
    path.join(stateDir, 'debug', `${sid}.jsonl`),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  );
}

// ---- evidence-bearing edit ratio ----

test('evidence-bearing edit ratio counts only gate-applicable write events', () => {
  const dir = mkStateDir();
  writeLog(dir, SID_A, [
    ev({ gate_applicable: true, has_gate_passing_state: true, decision: 'allow' }),
    ev({ gate_applicable: true, has_gate_passing_state: true, decision: 'allow', tool: 'Write' }),
    ev({ gate_applicable: true, decision: 'block', deny_code: 'UNREAD_OR_STALE' }),
    ev({ gate_applicable: false, decision: 'allow' }), // non-gated: out of both
    ev({ hook: 'PreToolUse', tool: 'Read', decision: 'allow' }), // Read: out of both
  ]);
  const m = computeMetrics(dir, {});
  assert.equal(m.evidence_bearing_edit_ratio.n, 2);
  assert.equal(m.evidence_bearing_edit_ratio.d, 3);
  assert.ok(Math.abs(m.evidence_bearing_edit_ratio.value - 2 / 3) < 1e-9);
});

test('a zero denominator yields null, not 0 — "no data" is not "nothing passed"', () => {
  const dir = mkStateDir();
  writeLog(dir, SID_A, [ev({ gate_applicable: false })]);
  const m = computeMetrics(dir, {});
  assert.equal(m.evidence_bearing_edit_ratio.value, null);
  assert.equal(m.evidence_bearing_edit_ratio.d, 0);
  assert.equal(m.gate_deny_ratio.value, null);
  assert.equal(m.stop_verification_pass_rate.value, null);
});

test('gate deny ratio is blocks over all gate-applicable PreToolUse events', () => {
  const dir = mkStateDir();
  writeLog(dir, SID_A, [
    ev({ gate_applicable: true, decision: 'block', deny_code: 'RACE_DETECTED' }),
    ev({ gate_applicable: true, decision: 'allow', has_gate_passing_state: true }),
    ev({ gate_applicable: true, decision: 'allow', has_gate_passing_state: true }),
    ev({ gate_applicable: true, decision: 'allow', has_gate_passing_state: true }),
  ]);
  const m = computeMetrics(dir, {});
  assert.equal(m.gate_deny_ratio.n, 1);
  assert.equal(m.gate_deny_ratio.d, 4);
  assert.equal(m.gate_deny_ratio.value, 0.25);
});

// ---- Stop metrics ----

test('stop verification pass rate excludes kill_switch events', () => {
  const dir = mkStateDir();
  writeLog(dir, SID_A, [
    ev({ hook: 'Stop', tool: null, decision: 'allow' }),
    ev({ hook: 'Stop', tool: null, decision: 'allow' }),
    ev({ hook: 'Stop', tool: null, decision: 'block', deny_code: 'VERIFICATION_FAILED' }),
    ev({ hook: 'Stop', tool: null, decision: 'kill_switch', kill_switch: 'file' }),
  ]);
  const m = computeMetrics(dir, {});
  assert.equal(m.stop_verification_pass_rate.n, 2);
  assert.equal(m.stop_verification_pass_rate.d, 3);
});

test('stop latency percentiles use nearest-rank on the Stop sample only', () => {
  const dir = mkStateDir();
  writeLog(dir, SID_A, [
    ev({ hook: 'Stop', tool: null, latency_ms: 10 }),
    ev({ hook: 'Stop', tool: null, latency_ms: 20 }),
    ev({ hook: 'Stop', tool: null, latency_ms: 30 }),
    ev({ hook: 'Stop', tool: null, latency_ms: 40 }),
    ev({ hook: 'PreToolUse', latency_ms: 9999 }), // not a Stop sample
  ]);
  const m = computeMetrics(dir, {});
  assert.equal(m.stop_latency_ms.n, 4);
  assert.equal(m.stop_latency_ms.p50, 20); // ceil(0.5*4)=2 -> 2nd value
  assert.equal(m.stop_latency_ms.p95, 40); // ceil(0.95*4)=4 -> 4th value
});

test('an empty Stop sample reports null percentiles', () => {
  const dir = mkStateDir();
  writeLog(dir, SID_A, [ev({})]);
  const m = computeMetrics(dir, {});
  assert.equal(m.stop_latency_ms.n, 0);
  assert.equal(m.stop_latency_ms.p50, null);
  assert.equal(m.stop_latency_ms.p95, null);
});

// ---- kill switch: measurably unmeasurable ----

test('kill switch usage is reported as unmeasurable with its G5 rationale', () => {
  const dir = mkStateDir();
  writeLog(dir, SID_A, [ev({})]);
  const m = computeMetrics(dir, {});
  assert.equal(m.kill_switch_usage.value, null);
  assert.match(m.kill_switch_usage.reason, /no disk write/i);
});

// ---- filtering + robustness ----

test('--sid restricts the window to one session log', () => {
  const dir = mkStateDir();
  writeLog(dir, SID_A, [ev({ gate_applicable: true, has_gate_passing_state: true })]);
  writeLog(dir, SID_B, [
    ev({ sid: SID_B, gate_applicable: true, decision: 'block', deny_code: 'WRONG_SID' }),
  ]);
  assert.equal(computeMetrics(dir, {}).evidence_bearing_edit_ratio.d, 2);
  assert.equal(computeMetrics(dir, { sid: SID_B }).evidence_bearing_edit_ratio.d, 1);
  assert.equal(computeMetrics(dir, { sid: SID_B }).evidence_bearing_edit_ratio.value, 0);
});

test('sinceMs drops older events', () => {
  const dir = mkStateDir();
  writeLog(dir, SID_A, [
    ev({ ts_ms: 1000, gate_applicable: true, has_gate_passing_state: true }),
    ev({ ts_ms: 5000, gate_applicable: true, decision: 'block', deny_code: 'UNREAD_OR_STALE' }),
  ]);
  const m = computeMetrics(dir, { sinceMs: 2000 });
  assert.equal(m.evidence_bearing_edit_ratio.d, 1);
  assert.equal(m.evidence_bearing_edit_ratio.value, 0);
});

test('a truncated or malformed line is skipped, not fatal', () => {
  const dir = mkStateDir();
  const good = JSON.stringify(ev({ gate_applicable: true, has_gate_passing_state: true }));
  fs.writeFileSync(
    path.join(dir, 'debug', `${SID_A}.jsonl`),
    `${good}\n{"ts_ms":123,"hook":\nnot json at all\n${good}\n`
  );
  const m = computeMetrics(dir, {});
  assert.equal(m.evidence_bearing_edit_ratio.d, 2);
  assert.equal(m.events_skipped, 2);
});

test('an absent debug dir is an empty window, not a crash', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-metrics-bare-')));
  const m = computeMetrics(dir, {});
  assert.equal(m.events, 0);
  assert.equal(m.evidence_bearing_edit_ratio.value, null);
});

test('the bypass-watcher log is not counted as hook events', () => {
  const dir = mkStateDir();
  writeLog(dir, SID_A, [ev({ gate_applicable: true, has_gate_passing_state: true })]);
  fs.writeFileSync(
    path.join(dir, 'debug', 'bypass-watcher.jsonl'),
    JSON.stringify({ schema_version: 1, ts_ms: 1, event: 'bypass_observed', path: '/repo/a.ts' }) + '\n'
  );
  const m = computeMetrics(dir, {});
  assert.equal(m.events, 1);
});

// ---- bypass detection rate (correlates the watcher log with hook events) ----

function writeBypassLog(stateDir, events) {
  fs.writeFileSync(
    path.join(stateDir, 'debug', 'bypass-watcher.jsonl'),
    events
      .map((e) => JSON.stringify({ schema_version: 1, event: 'bypass_observed', ...e }))
      .join('\n') + '\n'
  );
}

test('a bypass followed by RACE_DETECTED on the same path counts as detected', () => {
  const dir = mkStateDir();
  writeBypassLog(dir, [{ ts_ms: 1000, path: '/repo/a.ts' }]);
  writeLog(dir, SID_A, [
    ev({ ts_ms: 2000, path: '/repo/a.ts', gate_applicable: true, decision: 'block', deny_code: 'RACE_DETECTED' }),
  ]);
  const m = computeMetrics(dir, {});
  assert.equal(m.bypass_detection_rate.detected, 1);
  assert.equal(m.bypass_detection_rate.missed, 0);
  assert.equal(m.bypass_detection_rate.value, 1);
});

test('a bypass followed by an allowed edit counts as missed', () => {
  const dir = mkStateDir();
  writeBypassLog(dir, [{ ts_ms: 1000, path: '/repo/a.ts' }]);
  writeLog(dir, SID_A, [
    ev({ ts_ms: 2000, path: '/repo/a.ts', gate_applicable: true, decision: 'allow', has_gate_passing_state: true }),
  ]);
  const m = computeMetrics(dir, {});
  assert.equal(m.bypass_detection_rate.detected, 0);
  assert.equal(m.bypass_detection_rate.missed, 1);
  assert.equal(m.bypass_detection_rate.value, 0);
});

test('only the EARLIEST subsequent write event on that path decides the outcome', () => {
  const dir = mkStateDir();
  writeBypassLog(dir, [{ ts_ms: 1000, path: '/repo/a.ts' }]);
  writeLog(dir, SID_A, [
    ev({ ts_ms: 3000, path: '/repo/a.ts', gate_applicable: true, decision: 'block', deny_code: 'RACE_DETECTED' }),
    ev({ ts_ms: 2000, path: '/repo/a.ts', gate_applicable: true, decision: 'allow', has_gate_passing_state: true }),
  ]);
  const m = computeMetrics(dir, {});
  assert.equal(m.bypass_detection_rate.missed, 1);
  assert.equal(m.bypass_detection_rate.detected, 0);
});

test('a bypass with no later write attempt is undetermined and leaves the denominator', () => {
  const dir = mkStateDir();
  writeBypassLog(dir, [
    { ts_ms: 1000, path: '/repo/a.ts' },
    { ts_ms: 1000, path: '/repo/never-edited.ts' },
  ]);
  writeLog(dir, SID_A, [
    // earlier than the bypass: does not count as a follow-up
    ev({ ts_ms: 500, path: '/repo/a.ts', gate_applicable: true, decision: 'block', deny_code: 'RACE_DETECTED' }),
    ev({ ts_ms: 2000, path: '/repo/a.ts', gate_applicable: true, decision: 'block', deny_code: 'RACE_DETECTED' }),
  ]);
  const m = computeMetrics(dir, {});
  assert.equal(m.bypass_detection_rate.detected, 1);
  assert.equal(m.bypass_detection_rate.missed, 0);
  assert.equal(m.bypass_detection_rate.undetermined, 1);
  assert.equal(m.bypass_detection_rate.value, 1);
});

test('follow-up events are correlated across sessions', () => {
  const dir = mkStateDir();
  writeBypassLog(dir, [{ ts_ms: 1000, path: '/repo/a.ts' }]);
  writeLog(dir, SID_A, [ev({ ts_ms: 500, path: '/repo/a.ts', gate_applicable: true, decision: 'allow' })]);
  writeLog(dir, SID_B, [
    ev({ sid: SID_B, ts_ms: 2000, path: '/repo/a.ts', gate_applicable: true, decision: 'block', deny_code: 'RACE_DETECTED' }),
  ]);
  const m = computeMetrics(dir, {});
  assert.equal(m.bypass_detection_rate.detected, 1);
});

test('with no bypass observations the rate is null, not 0', () => {
  const dir = mkStateDir();
  writeLog(dir, SID_A, [ev({})]);
  const m = computeMetrics(dir, {});
  assert.equal(m.bypass_detection_rate.value, null);
  assert.equal(m.bypass_detection_rate.detected, 0);
  assert.equal(m.bypass_detection_rate.undetermined, 0);
});

test('sinceMs also filters bypass observations', () => {
  const dir = mkStateDir();
  writeBypassLog(dir, [{ ts_ms: 1000, path: '/repo/a.ts' }]);
  writeLog(dir, SID_A, [
    ev({ ts_ms: 2000, path: '/repo/a.ts', gate_applicable: true, decision: 'block', deny_code: 'RACE_DETECTED' }),
  ]);
  const m = computeMetrics(dir, { sinceMs: 1500 });
  assert.equal(m.bypass_detection_rate.value, null);
});

// ---- CLI ----

test('CLI --json prints the metric object and exits 0', () => {
  const dir = mkStateDir();
  writeLog(dir, SID_A, [ev({ gate_applicable: true, has_gate_passing_state: true })]);
  const r = spawnSync('node', [CLI, '--json', '--state-dir', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.evidence_bearing_edit_ratio.value, 1);
  assert.equal(out.kill_switch_usage.value, null);
});

test('CLI human output names every §5 metric row', () => {
  const dir = mkStateDir();
  writeLog(dir, SID_A, [ev({ hook: 'Stop', tool: null, decision: 'allow', latency_ms: 50 })]);
  const r = spawnSync('node', [CLI, '--state-dir', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  for (const row of [
    'evidence_bearing_edit_ratio',
    'gate_deny_ratio',
    'bypass_detection_rate',
    'stop_verification_pass_rate',
    'stop_latency_ms',
    'kill_switch_usage',
  ]) {
    assert.match(r.stdout, new RegExp(row));
  }
});

test('CLI --since accepts 7d / 24h / ISO and rejects garbage', () => {
  const dir = mkStateDir();
  writeLog(dir, SID_A, [ev({})]);
  for (const since of ['7d', '24h', '2026-01-01T00:00:00Z']) {
    const r = spawnSync('node', [CLI, '--json', '--state-dir', dir, '--since', since], { encoding: 'utf8' });
    assert.equal(r.status, 0, `--since ${since} should be accepted`);
  }
  const bad = spawnSync('node', [CLI, '--state-dir', dir, '--since', 'yesterday'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--since/);
});
