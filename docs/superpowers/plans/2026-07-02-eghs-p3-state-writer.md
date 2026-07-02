# EGHS P3: Read/Edit State Writer (gate off) — Unit Plan

> Process (user-directed, replaces subagent-driven pipeline for P3):
> per unit — develop (TDD) → simplify → review (senior + Codex) → fix Critical/Major immediately → commit.
> Minor findings accumulate in `.superpowers/sdd/p3-minors.md`, batch-fixed after all units.

**Goal:** PostToolUse Read/Edit state recording per PRD §R2/§R2.5/§R4 — gate OFF, records only, no denies.

**Spec:** PRD §R2 (lines 88-173), §R2.5 (176-280), §R4 (430-485), §6 rollout P3 row + line 760 (eghs-inspect).

## Design Decisions (locked)

1. **P3 includes PreToolUse record-only hooks.** R4's matrix consumes `pre/<sid>/<key>.write.json`
   written by PreToolUse; without it every Edit lands in the matrix miss path (failed marker, no
   `post_edit_success` ever recorded) and the P3 exit criterion "state 생성/갱신 정상" is unmeetable.
   PreToolUse Read also pre-records SHA so PostToolUse Read can detect `stale_read` (R2 TOCTOU).
2. **Every P3 hook ALWAYS exits 0** (fail-soft, like UserPromptSubmit). Gate is off: no deny, ever.
   PreToolUse exit 2 would deny the tool call — forbidden in P3. Crash backstop exits 0.
3. **Two entrypoints, not four**: `hooks/pre-tool-use.js` and `hooks/post-tool-use.js`, each
   dispatching on `tool_name` (Read vs Write|Edit|MultiEdit). Matchers in settings.json select tools.
4. **NO_SESSION short-circuit** (PRD R4 line 436): missing/invalid session_id → skip everything,
   debug log one line, exit 0.
5. **FS_INFO_MISSING in P3**: gate off → no deny; skip recording + stderr note (deny is P4).
6. **Schema MISMATCH handling stays deferred** (bundled with eghs-migrate, not P3 — HANDOFF carried item 2).
7. Glob semantics N/A in P3 (no gate paths consumed yet).

## Units

| # | Unit | Files | Task |
|---|------|-------|------|
| 1 | shared readStdin (+EAGAIN sleep fix) | hooks/lib/stdin.js; stop.js, user-prompt-submit.js call sites | #18 |
| 2 | P3 subdirs + fs-info probe | hooks/lib/state-dir.js, hooks/init.js, hooks/lib/fs-info.js | #19 |
| 3 | canonical path + SHA-256 | hooks/lib/canonical.js | #20 |
| 4 | read-state record + failed markers | hooks/lib/read-state.js | #21 |
| 5 | pre-file records | hooks/lib/pre-file.js | #22 |
| 6 | PreToolUse entrypoint | hooks/pre-tool-use.js | #23 |
| 7 | PostToolUse Read handler | hooks/post-tool-use.js (+config max_full_read_bytes) | #24 |
| 8 | PostToolUse Write/Edit R4 matrix | hooks/post-tool-use.js | #25 |
| 9 | inspect CLI + settings wiring + docs | hooks/inspect.js, .claude/settings.json, HANDOFF.md, README.md | #26 |
| F | Minor batch (+carried: zero-commit edge, CLAUDE_PROJECT_DIR test) | — | #27 |

## Key spec values (verbatim from PRD)

- State record: `{schema_version:1, file:<canonical-path>, sha:<sha256-hex>, size, ts_ms, sid, evidence}`
- Evidence grades: full_read, partial_read, stale_read, grep_hit, glob_hit, post_edit_success, post_edit_partial
- Failed marker: `{schema_version:1, origin_sid, ts_ms, reason}`; reasons include stale_read,
  state_record_failed, post_edit_partial, overwrite_race, lease_unavailable
- Marker paths: key-scoped `failed/<sha1(key)>.json`, sid-scoped `failed/<sid>/<sha1(key)>.json`
- Marker self-clear: same-sid success clears both; other-sid marker clears only if marker.ts_ms < current lease start_ms
- Canonical key: realpath → lowercase iff fs-info.json caseless_fs; filename = sha1(canonical_key) hex
- fs-info.json: `{schema_version:1, caseless_fs:bool, ts_ms}` — probe via .cs-probe/.CS-PROBE same-inode
- partial_read: tool_input has offset/limit OR file > max_full_read_bytes (default 5MB); sha:null
- R4 matrix rows: see PRD lines 459-468 (pre_sha × post_sha × tool error → 8 classifications)
- pre files: `pre/<sid>/<sha1(key)>.{read,write}.json`, lazy mkdir 0700, PostToolUse deletes after use, 24h GC
- Atomic write: destination-local tmp/ + fsync(fd) + same-dir rename + fsync(dirfd) (reuse lib/atomic-write.js)
