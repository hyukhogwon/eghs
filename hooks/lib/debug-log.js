'use strict';
const fs = require('fs');
const path = require('path');

// PRD §5 measurement log. Default ON (only `debug: false` in the config turns
// it off); dry-run disables it too, since a log line is a state write.
let enabled = true;

function setDebugEnabled(on) {
  enabled = on !== false;
}

// Best-effort JSONL append — never throws.
function appendDebugLog(stateDir, sid, event) {
  if (!enabled) return;
  try {
    const dir = path.join(stateDir, 'debug');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const line = JSON.stringify({ schema_version: 1, sid, ...event }) + '\n';
    fs.appendFileSync(path.join(dir, `${sid}.jsonl`), line);
  } catch {
    // best-effort: debug logging must never break the hook decision path.
  }
}

// PRD §5 event schema (lines 889-916): every hook decision is ONE line with
// the SAME field set, so the success metrics are computable from the log
// alone. Extra diagnostic keys (masked_from, ...) are appended after them.
//
// `decision` enum: allow | block | skip | kill_switch. `kill_switch` is
// always 'off' in practice — the chain's #2/#3 rows exit before any state
// write is permitted (PRD §R6 로그 rule) — but the field stays for schema
// conformance. `latency_ms` is measured from process start (performance.now()
// is ms since timeOrigin), which is what the p50/p95 metrics want.
function logDecision(
  stateDir,
  sid,
  {
    tsMs,
    hook,
    tool = null,
    path: filePath = null,
    gateApplicable = false,
    hasGatePassingState = false,
    evidenceKind = null,
    killSwitch = 'off',
    decision,
    denyCode = null,
    ...extra
  }
) {
  appendDebugLog(stateDir, sid, {
    ts_ms: tsMs,
    hook,
    tool,
    path: filePath,
    gate_applicable: gateApplicable,
    has_gate_passing_state: hasGatePassingState,
    evidence_kind: evidenceKind,
    kill_switch: killSwitch,
    decision,
    deny_code: denyCode,
    latency_ms: Math.round(performance.now()),
    ...extra,
  });
}

module.exports = { appendDebugLog, logDecision, setDebugEnabled };
