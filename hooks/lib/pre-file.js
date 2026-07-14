'use strict';
const fs = require('fs');
const path = require('path');
const { atomicWriteFile } = require('./atomic-write');
const { keyHash } = require('./canonical');

// PreToolUse scratch records (PRD §R2.5 pre/<sid>/): *.write.json carries the
// target's pre-edit SHA for the R4 matrix; *.read.json carries the
// PreToolUse-time SHA for R2 TOCTOU comparison. PostToolUse loads and deletes
// them; anything left behind (crash, deny) is GC'd after 24h.
//
// Filenames carry the Claude Code tool_use_id (R16 amendment): parallel
// same-sid calls on one file must not share a record, or a Read A → Read B →
// PostRead-A-delete race records B's stale SHA as full_read.

const KINDS = new Set(['read', 'write']);
const PRE_FILE_MAX_AGE_MS = 24 * 3600 * 1000;

// tool_use_id verified on Claude Code 2.1.207: `toolu_` + alnum in both Pre
// and Post hook inputs. Anything else (absent, or a hostile value that could
// traverse as a path segment) collapses to the literal 'none' — parallel
// calls then degrade to pre-R16 sharing, never to a crash or an escape.
function normalizeToolUseId(raw) {
  return typeof raw === 'string' && /^[A-Za-z0-9_-]+$/.test(raw) ? raw : 'none';
}

function preFilePath(stateDir, sid, key, toolUseId, kind) {
  if (!KINDS.has(kind)) {
    throw new Error(`unknown pre-file kind: ${kind}`);
  }
  // Defense-in-depth (same rule as read-state's markerPath): sid and
  // toolUseId become path components — never let a stray value traverse out
  // of pre/.
  if (typeof sid !== 'string' || !/^[0-9a-f-]+$/.test(sid)) {
    throw new Error(`unsafe sid for pre-file path: ${sid}`);
  }
  if (typeof toolUseId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(toolUseId)) {
    throw new Error(`unsafe tool_use_id for pre-file path: ${toolUseId}`);
  }
  return path.join(stateDir, 'pre', sid, `${keyHash(key)}.${toolUseId}.${kind}.json`);
}

function writePreFile(stateDir, sid, key, toolUseId, kind, body) {
  if (!KINDS.has(kind)) {
    throw new Error(`unknown pre-file kind: ${kind}`);
  }
  try {
    // atomicWriteFile's tmp helper mkdirs <destdir>/tmp recursively, which
    // lazily creates pre/<sid>/ on first write (PRD §R2.5).
    atomicWriteFile(preFilePath(stateDir, sid, key, toolUseId, kind), `${JSON.stringify({ ...body, schema_version: 1 })}\n`);
  } catch {
    // Best-effort: a lost pre-record degrades to "no SHA comparison"
    // (PRD §R2 allows PostToolUse-only recording), never a crashed hook.
  }
}

function readPreFile(stateDir, sid, key, toolUseId, kind) {
  if (!KINDS.has(kind)) {
    throw new Error(`unknown pre-file kind: ${kind}`);
  }
  try {
    const record = JSON.parse(fs.readFileSync(preFilePath(stateDir, sid, key, toolUseId, kind), 'utf8'));
    return record !== null && typeof record === 'object' && !Array.isArray(record) ? record : null;
  } catch {
    return null;
  }
}

function deletePreFile(stateDir, sid, key, toolUseId, kind) {
  if (!KINDS.has(kind)) {
    throw new Error(`unknown pre-file kind: ${kind}`);
  }
  try {
    fs.unlinkSync(preFilePath(stateDir, sid, key, toolUseId, kind));
  } catch {
    // ENOENT or a bad sid: nothing to delete.
  }
}

// Every pre-record for one key hash under one sid, across tool_use_ids —
// the R4 2nd-pass orphan scan can't know which tool_use_id a dead session
// used. Returns [{toolUseId, path}].
function listPreFilesForHash(stateDir, sid, hash, kind) {
  if (!KINDS.has(kind)) {
    throw new Error(`unknown pre-file kind: ${kind}`);
  }
  let names;
  try {
    names = fs.readdirSync(path.join(stateDir, 'pre', sid));
  } catch {
    return [];
  }
  const suffix = `.${kind}.json`;
  const out = [];
  for (const name of names) {
    if (!name.startsWith(`${hash}.`) || !name.endsWith(suffix)) continue;
    const toolUseId = name.slice(hash.length + 1, name.length - suffix.length);
    if (!toolUseId || toolUseId.includes('.')) continue; // other kind or foreign shape
    out.push({ toolUseId, path: path.join(stateDir, 'pre', sid, name) });
  }
  return out;
}

// PRD §R2.5 / R6 #5b: delete pre/<sid>/ files older than 24h. Covers tmp/
// leftovers too (their atomic-write temps live under pre/<sid>/tmp/).
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

module.exports = {
  writePreFile,
  readPreFile,
  deletePreFile,
  gcPreFiles,
  normalizeToolUseId,
  listPreFilesForHash,
};
