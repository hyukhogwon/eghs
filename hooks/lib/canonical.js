'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Canonical key (PRD §R2): realpath resolves symlinks and ./.. segments,
// then lowercase iff the state dir's fs-info cache says the filesystem is
// caseless (macOS APFS default, NTFS). Failures classify as FILE_UNREADABLE
// rather than throwing — the P3 hooks are record-only and must degrade to
// "skip", never crash. `missing` distinguishes ENOENT (file absent — R4
// needs post_sha=null, R3 allows new-file Write) from EACCES-class errors
// (file present but unreadable — must NOT be treated as a clean absence).
function canonicalKey(filePath, { caseless }) {
  let resolved;
  try {
    resolved = fs.realpathSync(filePath);
  } catch (err) {
    return { ok: false, code: 'FILE_UNREADABLE', missing: err.code === 'ENOENT' };
  }
  return { ok: true, key: caseless ? resolved.toLowerCase() : resolved };
}

// Deep-new-path canonical key (PRD §R3): when the file does not exist yet
// (new Write intent), walk up to the first existing ancestor, realpath it,
// and re-append the not-yet-existing segments. `missing: true` on the ok
// result tells the caller to record pre_sha: null.
function canonicalKeyAllowMissing(filePath, { caseless }) {
  const direct = canonicalKey(filePath, { caseless });
  if (direct.ok) return { ...direct, missing: false };
  if (!direct.missing) return direct; // EACCES-class: not a new-file case
  const pending = [];
  let p = path.resolve(filePath);
  while (true) {
    pending.unshift(path.basename(p));
    const parent = path.dirname(p);
    if (parent === p) return { ok: false, code: 'FILE_UNREADABLE', missing: true };
    let real;
    try {
      real = fs.realpathSync(parent);
    } catch (err) {
      if (err.code === 'ENOENT') {
        p = parent;
        continue;
      }
      return { ok: false, code: 'FILE_UNREADABLE', missing: false };
    }
    const key = path.join(real, ...pending);
    return { ok: true, key: caseless ? key.toLowerCase() : key, missing: true };
  }
}

// reads/failed state filenames are sha1(canonical_key) hex (PRD §R2.5).
function keyHash(key) {
  return crypto.createHash('sha1').update(key).digest('hex');
}

// SHA-256 of raw disk bytes — no line-ending or encoding normalization
// (PRD §R2: the hash pins what is on disk, not what the Read tool rendered).
// Streamed in 64KiB chunks: R4's post_sha has no size cap, and readFileSync
// would both buffer whole multi-GB files in a synchronous hook and throw
// ERR_FS_FILE_TOO_LARGE (≥2GiB) — misreporting a readable file as unreadable.
function sha256File(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (err) {
    return { ok: false, code: 'FILE_UNREADABLE', missing: err.code === 'ENOENT' };
  }
  try {
    const hash = crypto.createHash('sha256');
    const buf = Buffer.alloc(65536);
    let size = 0;
    while (true) {
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
      size += bytesRead;
    }
    return { ok: true, sha: hash.digest('hex'), size };
  } catch {
    return { ok: false, code: 'FILE_UNREADABLE', missing: false };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { canonicalKey, canonicalKeyAllowMissing, keyHash, sha256File };
