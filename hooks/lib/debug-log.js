'use strict';
const fs = require('fs');
const path = require('path');

// Best-effort JSONL append — never throws, matches PRD §R5 measurement schema.
function appendDebugLog(stateDir, sid, event) {
  try {
    const dir = path.join(stateDir, 'debug');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const line = JSON.stringify({ schema_version: 1, sid, ...event }) + '\n';
    fs.appendFileSync(path.join(dir, `${sid}.jsonl`), line);
  } catch {
    // best-effort: debug logging must never break the hook decision path.
  }
}

module.exports = { appendDebugLog };
