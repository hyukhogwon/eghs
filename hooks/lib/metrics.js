'use strict';
const fs = require('fs');
const path = require('path');

// PRD §5 success metrics, computed from the debug JSONL the hooks already
// write. Strictly read-only — nothing in this module touches disk state.
//
// Two logs feed it:
//   debug/<sid>.jsonl          one line per hook decision (§5 event schema)
//   debug/bypass-watcher.jsonl one line per unattributed on-disk change
//                              (eghs-bypass-watcher, §5 측정 방법)

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const BYPASS_LOG = 'bypass-watcher.jsonl';

// A ratio with nothing in its denominator is `null`, never 0: "no data" and
// "nothing passed" are different answers, and the §6 exit criteria act on
// them differently.
function ratio(n, d) {
  return { value: d === 0 ? null : n / d, n, d };
}

// Nearest-rank (no interpolation). The sample here is tens of events, not
// thousands — interpolating would invent precision the data does not have.
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

// Parses one JSONL file into objects, counting rather than throwing on bad
// lines: a hook killed mid-append leaves a truncated tail, and one torn line
// must not cost the whole report.
function readJsonl(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { rows: [], skipped: 0 };
  }
  const rows = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const row = JSON.parse(line);
      if (row !== null && typeof row === 'object' && !Array.isArray(row)) rows.push(row);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { rows, skipped };
}

function debugFiles(debugDir) {
  try {
    return fs.readdirSync(debugDir).filter((n) => n.endsWith('.jsonl') && n !== BYPASS_LOG);
  } catch {
    return []; // never initialized, or state dir removed — an empty window
  }
}

function inWindow(row, sinceMs) {
  return sinceMs === null || (typeof row.ts_ms === 'number' && row.ts_ms >= sinceMs);
}

// §5: "Bash로 파일이 변경된 직후 같은 파일의 Edit 호출이 RACE_DETECTED로 deny된
// 비율". The decisive event is the EARLIEST write-tool PreToolUse on that path
// after the observation — a later one sees a state the first call already
// changed. An observation with no follow-up at all is `undetermined`: an edit
// that never happened cannot be denied, so counting it as a miss would report
// the gate as failing when it was simply never asked.
function bypassDetection(bypassRows, hookRows) {
  const byPath = new Map();
  for (const row of hookRows) {
    if (row.hook !== 'PreToolUse' || !WRITE_TOOLS.has(row.tool)) continue;
    if (typeof row.path !== 'string' || typeof row.ts_ms !== 'number') continue;
    if (!byPath.has(row.path)) byPath.set(row.path, []);
    byPath.get(row.path).push(row);
  }
  for (const rows of byPath.values()) rows.sort((a, b) => a.ts_ms - b.ts_ms);

  let detected = 0;
  let missed = 0;
  let undetermined = 0;
  for (const obs of bypassRows) {
    if (obs.event !== 'bypass_observed') continue;
    const followUp = (byPath.get(obs.path) || []).find((r) => r.ts_ms > obs.ts_ms);
    if (!followUp) undetermined += 1;
    else if (followUp.decision === 'block' && followUp.deny_code === 'RACE_DETECTED') detected += 1;
    else missed += 1;
  }
  const decided = detected + missed;
  return {
    value: decided === 0 ? null : detected / decided,
    detected,
    missed,
    undetermined,
  };
}

// opts: {sid?: string, sinceMs?: number}
function computeMetrics(stateDir, { sid = null, sinceMs = null } = {}) {
  const debugDir = path.join(stateDir, 'debug');
  const wanted = sid === null ? debugFiles(debugDir) : [`${sid}.jsonl`];

  const hookRows = [];
  let skipped = 0;
  for (const name of wanted) {
    const { rows, skipped: bad } = readJsonl(path.join(debugDir, name));
    skipped += bad;
    for (const row of rows) if (inWindow(row, sinceMs)) hookRows.push(row);
  }

  const bypass = readJsonl(path.join(debugDir, BYPASS_LOG));
  skipped += bypass.skipped;
  const bypassRows = bypass.rows.filter((r) => inWindow(r, sinceMs));

  const gateApplicable = hookRows.filter((r) => r.hook === 'PreToolUse' && r.gate_applicable === true);
  const gatedWrites = gateApplicable.filter((r) => WRITE_TOOLS.has(r.tool));
  const stops = hookRows.filter((r) => r.hook === 'Stop' && r.kill_switch === 'off');
  const stopLatencies = hookRows
    .filter((r) => r.hook === 'Stop' && typeof r.latency_ms === 'number')
    .map((r) => r.latency_ms)
    .sort((a, b) => a - b);

  return {
    state_dir: stateDir,
    sid,
    since_ms: sinceMs,
    events: hookRows.length,
    events_skipped: skipped,

    evidence_bearing_edit_ratio: ratio(
      gatedWrites.filter((r) => r.decision === 'allow' && r.has_gate_passing_state === true).length,
      gatedWrites.length
    ),
    gate_deny_ratio: ratio(
      gateApplicable.filter((r) => r.decision === 'block').length,
      gateApplicable.length
    ),
    bypass_detection_rate: bypassDetection(bypassRows, hookRows),
    stop_verification_pass_rate: ratio(stops.filter((r) => r.decision === 'allow').length, stops.length),
    stop_latency_ms: {
      p50: percentile(stopLatencies, 0.5),
      p95: percentile(stopLatencies, 0.95),
      n: stopLatencies.length,
    },
    // PRD §887 lists this as MVP-measurable, but §R6 #2 forbids ANY disk write
    // once the kill switch is active — that no-write rule is the single basis
    // for G5 ("즉시 비활성화"), so it outranks the metric. Amended in §5.
    kill_switch_usage: {
      value: null,
      reason: 'not measurable — §R6 kill switch performs no disk write (G5 invariant)',
    },
  };
}

module.exports = { computeMetrics, percentile, ratio };
