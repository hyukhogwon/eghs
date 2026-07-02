'use strict';
const fs = require('fs');
const path = require('path');
const { atomicWriteFile } = require('./atomic-write');
const { keyHash } = require('./canonical');

// PreToolUse scratch records (PRD §R2.5 pre/<sid>/): *.write.json carries the
// target's pre-edit SHA for the R4 matrix; *.read.json carries the
// PreToolUse-time SHA for R2 TOCTOU comparison. PostToolUse loads and deletes
// them; anything left behind (crash, deny) is GC'd after 24h.

const KINDS = new Set(['read', 'write']);
const PRE_FILE_MAX_AGE_MS = 24 * 3600 * 1000;

function preFilePath(stateDir, sid, key, kind) {
  if (!KINDS.has(kind)) {
    throw new Error(`unknown pre-file kind: ${kind}`);
  }
  // Defense-in-depth (same rule as read-state's markerPath): sid becomes a
  // directory name — never let a stray value traverse out of pre/.
  if (typeof sid !== 'string' || !/^[0-9a-f-]+$/.test(sid)) {
    throw new Error(`unsafe sid for pre-file path: ${sid}`);
  }
  return path.join(stateDir, 'pre', sid, `${keyHash(key)}.${kind}.json`);
}

function writePreFile(stateDir, sid, key, kind, body) {
  if (!KINDS.has(kind)) {
    throw new Error(`unknown pre-file kind: ${kind}`);
  }
  try {
    // atomicWriteFile's tmp helper mkdirs <destdir>/tmp recursively, which
    // lazily creates pre/<sid>/ on first write (PRD §R2.5).
    atomicWriteFile(preFilePath(stateDir, sid, key, kind), `${JSON.stringify({ ...body, schema_version: 1 })}\n`);
  } catch {
    // Best-effort: a lost pre-record degrades to "no SHA comparison"
    // (PRD §R2 allows PostToolUse-only recording), never a crashed hook.
  }
}

function readPreFile(stateDir, sid, key, kind) {
  if (!KINDS.has(kind)) {
    throw new Error(`unknown pre-file kind: ${kind}`);
  }
  try {
    const record = JSON.parse(fs.readFileSync(preFilePath(stateDir, sid, key, kind), 'utf8'));
    return record !== null && typeof record === 'object' && !Array.isArray(record) ? record : null;
  } catch {
    return null;
  }
}

function deletePreFile(stateDir, sid, key, kind) {
  if (!KINDS.has(kind)) {
    throw new Error(`unknown pre-file kind: ${kind}`);
  }
  try {
    fs.unlinkSync(preFilePath(stateDir, sid, key, kind));
  } catch {
    // ENOENT or a bad sid: nothing to delete.
  }
}

// PRD §R2.5: delete pre/<sid>/ files older than 24h at hook start. Covers
// tmp/ leftovers too (their atomic-write temps live under pre/<sid>/tmp/).
function gcPreFiles(stateDir, { nowMs }) {
  const preRoot = path.join(stateDir, 'pre');
  let sids;
  try {
    sids = fs.readdirSync(preRoot);
  } catch {
    return;
  }
  for (const sid of sids) {
    for (const dir of [path.join(preRoot, sid), path.join(preRoot, sid, 'tmp')]) {
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const p = path.join(dir, name);
        try {
          const st = fs.statSync(p);
          if (st.isFile() && nowMs - st.mtimeMs > PRE_FILE_MAX_AGE_MS) {
            fs.unlinkSync(p);
          }
        } catch {
          // Raced with another GC or PostToolUse delete: fine.
        }
      }
    }
  }
}

module.exports = { writePreFile, readPreFile, deletePreFile, gcPreFiles };
