#!/usr/bin/env node
'use strict';
// eghs-metrics (PRD §5) — read-only report over the hooks' own debug JSONL.
//   node hooks/metrics.js                 human table
//   node hooks/metrics.js --json          machine output
//   node hooks/metrics.js --sid <SID>     one session
//   node hooks/metrics.js --since 7d      7d / 24h / 30m / <ISO-8601> window
// Writes nothing, takes no lock, and needs no session: it only reads the logs
// the hooks already produced.
const { getRepoRoot } = require('./lib/git');
const { resolveStateDir } = require('./lib/state-dir');
const { computeMetrics } = require('./lib/metrics');
const { checkKillSwitch } = require('./lib/kill-switch');
const { isCI } = require('./lib/ci');

const RELATIVE_SINCE = /^(\d+)([dhm])$/;
const UNIT_MS = { d: 86400000, h: 3600000, m: 60000 };

function parseSince(value, nowMs) {
  const relative = RELATIVE_SINCE.exec(value);
  if (relative) return nowMs - Number(relative[1]) * UNIT_MS[relative[2]];
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`--since expects <N>d|<N>h|<N>m or an ISO-8601 timestamp, got "${value}"`);
  }
  return parsed;
}

function parseArgs(argv, nowMs) {
  const opts = { json: false, sid: null, sinceMs: null, stateDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      i += 1;
      return v;
    };
    if (arg === '--json') opts.json = true;
    else if (arg === '--sid') opts.sid = next();
    else if (arg === '--since') opts.sinceMs = parseSince(next(), nowMs);
    else if (arg === '--state-dir') opts.stateDir = next();
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

// The kill-switch row cannot report a count (see lib/metrics.js), so it
// reports the one thing that IS observable: whether the switch is on now.
function currentKillSwitch(repoRoot, env) {
  if (repoRoot === null) return 'unknown';
  try {
    const ks = checkKillSwitch({ repoRoot, env });
    if (ks.active) return ks.reason;
  } catch (err) {
    return `unreadable: ${err.code || err.message}`;
  }
  return isCI(env) ? 'ci' : 'off';
}

function formatRatio(row) {
  if (row.value === null) return `n/a (no data, d=${row.d})`;
  return `${(row.value * 100).toFixed(1)}%  (${row.n}/${row.d})`;
}

function render(m, killSwitchState) {
  const bypass = m.bypass_detection_rate;
  const lines = [
    `state_dir  ${m.state_dir}`,
    `window     ${m.sid === null ? 'all sessions' : `sid=${m.sid}`}${m.since_ms === null ? '' : `, since ${new Date(m.since_ms).toISOString()}`}`,
    `events     ${m.events}${m.events_skipped > 0 ? ` (${m.events_skipped} unparseable line(s) skipped)` : ''}`,
    '',
    `evidence_bearing_edit_ratio   ${formatRatio(m.evidence_bearing_edit_ratio)}          target > 0.9`,
    `gate_deny_ratio               ${formatRatio(m.gate_deny_ratio)}          target < 0.2`,
    `bypass_detection_rate         ${
      bypass.value === null
        ? `n/a (no decided observations)`
        : `${(bypass.value * 100).toFixed(1)}%  (${bypass.detected}/${bypass.detected + bypass.blocked_other + bypass.missed})`
    }          target > 0.9`,
    `                              blocked by another deny_code: ${bypass.blocked_other} (edit stopped, just not by race detection)`,
    `                              escaped (edit allowed): ${bypass.missed}`,
    `                              undetermined: ${bypass.undetermined} (observed, never followed by an edit)`,
    `stop_verification_pass_rate   ${formatRatio(m.stop_verification_pass_rate)}          target > 0.95`,
    `stop_latency_ms               p50=${m.stop_latency_ms.p50 ?? 'n/a'} p95=${m.stop_latency_ms.p95 ?? 'n/a'} (n=${m.stop_latency_ms.n})   target p50<60000 p95<90000`,
    `kill_switch_usage             ${m.kill_switch_usage.reason}`,
    `                              current state: ${killSwitchState}`,
  ];
  return lines.join('\n') + '\n';
}

function main(argv) {
  const nowMs = Date.now();
  const opts = parseArgs(argv, nowMs);
  const repoRoot = opts.stateDir === null ? getRepoRoot(process.cwd()) || process.cwd() : null;
  const stateDir = opts.stateDir === null ? resolveStateDir(repoRoot) : opts.stateDir;

  const metrics = computeMetrics(stateDir, { sid: opts.sid, sinceMs: opts.sinceMs });
  const killSwitchState = currentKillSwitch(repoRoot, process.env);

  if (opts.json) {
    process.stdout.write(JSON.stringify({ ...metrics, kill_switch_state: killSwitchState }, null, 2) + '\n');
    return;
  }
  process.stdout.write(render(metrics, killSwitchState));
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`[eghs] metrics: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { main, parseSince };
