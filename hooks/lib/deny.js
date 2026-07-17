'use strict';

// Deny stderr contract (PRD §8.7). On exit 2, stderr is the ONLY channel
// Claude Code relays to the model, so the block line + a remediation line go
// there. Format: `[eghs] block <deny_code>: <reason> sid=<sid>` then the
// remediation. `sid` is 'none' when absent (NO_SESSION) so the user can still
// tell there is no sid to copy for --clear-sid.

function remediation(denyCode, reason, sid) {
  switch (denyCode) {
    case 'UNREAD_OR_STALE':
    case 'WRONG_SID':
    case 'STATE_RECORD_FAILED':
      return 'Read the target file again in this session, then retry the edit';
    case 'RACE_DETECTED':
      return 'the file changed on disk since it was read — Read it again, then retry';
    case 'OVERWRITE_RACE':
      return 'Read the file, then use Edit instead of Write';
    case 'SCHEMA_MISMATCH':
      return 'run: eghs-migrate';
    case 'SCHEMA_NOT_INITIALIZED':
      return 'run: eghs-init';
    case 'FS_INFO_MISSING':
      return 'run: eghs-init --repair';
    case 'MIGRATE_IN_PROGRESS':
      return 'eghs-migrate is running — retry shortly';
    case 'SID_COLLISION':
      return 'two active sessions share this sid — end one and retry';
    case 'NO_SESSION':
      return 'session_id missing or malformed — restart Claude Code to get a fresh sid';
    case 'FILE_UNREADABLE':
      return 'check that the file exists and is readable';
    case 'INFRA_NOT_READY':
      switch (reason) {
        case 'lease_unavailable':
          return `run: eghs-migrate --clear-sid ${sid} [--force]`;
        case 'sid_cleared':
          return 'this session was cleared — restart Claude Code to get a fresh sid';
        case 'migrate_lock_corrupt':
          return 'run: eghs-migrate --clear-migrate-lock';
        default: // infra_not_ready / schema_invalid
          return 'run: eghs-init --repair';
      }
    default:
      return 'see EGHS docs';
  }
}

function formatBlock(denyCode, { reason, sid } = {}) {
  const sidStr = typeof sid === 'string' && sid.length > 0 ? sid : 'none';
  const reasonStr = reason ? `${reason}` : denyCode.toLowerCase();
  return (
    `[eghs] block ${denyCode}: ${reasonStr} sid=${sidStr}\n` +
    `  → ${remediation(denyCode, reason, sidStr)}\n`
  );
}

module.exports = { formatBlock, remediation };
