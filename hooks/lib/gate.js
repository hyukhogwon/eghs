'use strict';
const fs = require('fs');
const path = require('path');
const picomatch = require('picomatch');
const { canonicalKey, canonicalKeyAllowMissing, keyHash, sha256File } = require('./canonical');
const { readReadState } = require('./read-state');
const { isOutsideRepo } = require('./tool-hook');

// R3 Edit state gate (PRD §R3 lines 423-503). Evaluated as precedence #8 for
// PreToolUse Write/Edit/MultiEdit, so the ctx it receives already has a live
// lease and a healthy schema. Returns:
//   {allow:true, preSha}            — record pre_sha, allow the edit
//   {allow:true, preSha:null, newFile:true} — new-file Write; R4 classifies
//   {allow:false, denyCode, reason?}
//   {skip:'not_applicable'|'outside_repo', preSha:null}

const GATE_EVIDENCE = new Set(['full_read', 'post_edit_success']);

// bash-glob (picomatch v4, {dot:true}) against the repo-relative key — NOT
// gitignore semantics (PRD §R3 매칭 문법). An empty/invalid pattern list
// matches nothing (the dark default).
function pathMatchesGate(relPath, globs) {
  const valid = (globs || []).filter((g) => typeof g === 'string' && g.length > 0);
  if (valid.length === 0) return false;
  return picomatch(valid, { dot: true })(relPath);
}

function markerDenyCode(reason) {
  return reason === 'overwrite_race' ? 'OVERWRITE_RACE' : 'STATE_RECORD_FAILED';
}

function readMarker(p) {
  try {
    const m = JSON.parse(fs.readFileSync(p, 'utf8'));
    return m !== null && typeof m === 'object' ? m : null;
  } catch {
    return null;
  }
}

// Gate condition 5 (PRD §468-471, §566): both marker scopes are checked. The
// own sid-scoped marker always blocks (cleared only by a successful re-Read).
// A key-scoped marker blocks unless it is releasable — own origin, or older
// than our immutable lease start (a newer one belongs to a live session).
function markerDeny(stateDir, key, sid, leaseStartMs) {
  const hash = keyHash(key);
  const sidMarker = readMarker(path.join(stateDir, 'failed', sid, `${hash}.json`));
  if (sidMarker) return markerDenyCode(sidMarker.reason);

  const keyMarker = readMarker(path.join(stateDir, 'failed', `${hash}.json`));
  if (keyMarker) {
    const releasable =
      keyMarker.origin_sid === sid ||
      (typeof keyMarker.ts_ms === 'number' && keyMarker.ts_ms < leaseStartMs);
    if (!releasable) return markerDenyCode(keyMarker.reason);
  }
  return null;
}

function evaluateGate(ctx, filePath, { nowMs }) {
  const { stateDir, repoRoot, sid, caseless, config, lease } = ctx;

  const resolved = canonicalKeyAllowMissing(filePath, { caseless });
  if (!resolved.ok) return { allow: false, denyCode: 'FILE_UNREADABLE', reason: resolved.code };
  const key = resolved.key;

  if (isOutsideRepo(key, repoRoot, caseless)) return { skip: 'outside_repo', preSha: null, key };

  const repoKey = canonicalKey(repoRoot, { caseless });
  const rel = repoKey.ok ? path.relative(repoKey.key, key) : key;
  if (!pathMatchesGate(rel, config.state_gate_paths)) return { skip: 'not_applicable', preSha: null, key, missing: resolved.missing };

  // Matched but the file does not exist: new-file Write. PreToolUse records
  // pre_sha null and allows; R4's OVERWRITE_RACE row catches a racing create.
  if (resolved.missing) return { allow: true, preSha: null, newFile: true, key };

  const disk = sha256File(key);
  if (!disk.ok) return { allow: false, denyCode: 'FILE_UNREADABLE', key };

  // Conditions 1-4 (PRD §464-467).
  const state = readReadState(stateDir, key);
  if (!state || !GATE_EVIDENCE.has(state.evidence)) return { allow: false, denyCode: 'UNREAD_OR_STALE', key };
  if (state.sid !== sid) return { allow: false, denyCode: 'WRONG_SID', key };
  if (state.sha !== disk.sha) return { allow: false, denyCode: 'RACE_DETECTED', key };
  if (nowMs - state.ts_ms > config.stale_after_seconds * 1000) return { allow: false, denyCode: 'UNREAD_OR_STALE', key };

  // Condition 5 (PRD §468-471).
  const denyCode = markerDeny(stateDir, key, sid, lease.start_ms);
  if (denyCode) return { allow: false, denyCode, key };

  return { allow: true, preSha: state.sha, key };
}

module.exports = { evaluateGate };
