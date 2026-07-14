# EGHS P4: Edit State Gate — Unit Plan

> **For agentic workers:** process per unit (established in P3, keep for P4):
> develop (TDD) → simplify → review (senior + Codex when available) → fix Critical/Major immediately → commit.
> Minor findings accumulate in `.superpowers/sdd/p4-minors.md`, batch-fixed in the finale.
> PRD sections are the verbatim spec — implementers transcribe procedures from the PRD, they don't improvise.

**Goal:** Flip PreToolUse Write/Edit/MultiEdit from record-only to the R3 evidence gate on core
source paths, with the full R6 precedence chain, R16-R20 infra (guard locks, tombstones,
admin mutex, flock-capable fs-info), and the `eghs-migrate` escape-hatch CLI.

**Architecture:** A shared `runPrecedence(hookType, input)` driver implements PRD §R6 #1–#7
exactly once; each hook entrypoint calls it and then its own hook logic (#8). The R3 gate is a
separate lib consumed only by `pre-tool-use.js`. All flock-dependent primitives go through one
`lib/flock.js` wrapper around `fs-ext`.

**Tech Stack:** Node ≥ 18.15 (dev on v24), CommonJS, `node --test`, picomatch v4, fs-ext 2.1.1 (new dep).

**Spec:** PRD §R3 (lines 423–503), §R4 (506–568), §R2.5 (177–421), §R6 precedence (665–858),
§5 debug schema (889–916), §8 MVP items 7/14/17 (974–988). All line numbers as of commit c7d7498.

## Global Constraints

- Every deny goes out as exit 2 + stderr `[eghs] block <deny_code>: <reason> sid=<sid>` (+ per-check remediation lines; `sid=none` when NO_SESSION; `--clear-sid` guidance line on `reason=lease_unavailable`) — PRD §8.7.
- Precedence #1–#3.7 are mutation-free (sole exception: #3.7 guard.lock create) — PRD §R6 invariant, G5.
- No GC at hook start; ALL GC happens in precedence #5b (pre/ 24h GC moves there) — R16-R20 amendment.
- Atomic writes: destination-local `tmp/` + fsync(fd) + same-dir rename + fsync(dirfd) (existing `lib/atomic-write.js`).
- Lease/baseline/stop-lock creation uses link(2) exclusive create, never rename-overwrite.
- Glob matching: picomatch v4 `{ dot: true }`, bash-glob semantics, repo-root-relative keys.
- Canonical key: realpath → `lowercase(NFC(...))` iff caseless FS (existing `lib/canonical.js`).
- Hooks always leave `process.exitCode` deliberate: 0 = allow/skip/kill-switch, 2 = block, anything else = crash.
- Conventional Commits, one commit per unit, work on `main`, never push without explicit user request.

## Locked Design Decisions (verified 2026-07-14 — do not re-litigate)

1. **flock via `fs-ext@2.1.1`** (new runtime dependency, native module). Verified on Node
   v24.14.0 / macOS arm64: builds clean, cross-process semantics correct (concurrent LOCK_SH
   OK; LOCK_EX|LOCK_NB against held SH → EAGAIN). EAGAIN is the EWOULDBLOCK alias — treat
   `err.code === 'EAGAIN'` as EWOULDBLOCK everywhere. Blocking-with-timeout acquires
   (admin-mutex 30s, `--clear-sid` drain 90s) are implemented as `exnb` polls (100ms interval),
   not blocking flock (no timeout support in flockSync; polling keeps CLIs interruptible).
2. **`tool_use_id` is real**: verified on Claude Code 2.1.207 — Pre/PostToolUse hook input both
   carry the same `tool_use_id` (`toolu_` + alnum). Sanitize with `/^[A-Za-z0-9_-]+$/` before
   using it in a filename (defense-in-depth, same pattern as the sid check). If the field is
   ever absent, substitute the literal `none` (degrades to pre-R16 collision behavior for
   parallel same-file calls only; PostToolUse joins on the same fallback).
3. **`fs_statfs_id` deviates from the PRD letter**: PRD §R2.5 step 6d wants macOS
   `statfs.f_fstypename` ("darwin:apfs"). Node core exposes only the numeric `fs.statfsSync().type`
   on every platform, and fs-ext has no statfs. Store `"<platform>:<decimal type>"` (e.g.
   `darwin:26`, `linux:61267`) — same anchor strength, no native code. Queue a PRD §R2.5/§R6#3.3
   amendment for the finale (same pattern as P3's NFC amendment).
4. **Lease pid stays `process.ppid`** (HANDOFF: `CLAUDE_CODE_PID` does not exist, verified
   v2.1.198). PRD §R2.5 §230 priority order is honored in code shape (env var checked first if
   ever set + alive), but ppid is the expected live path.
5. **Gate ships dark, flips by config in the last unit**: `state_gate_paths` defaults to `[]`
   in DEFAULT_CONFIG (gate applies to zero paths → never denies). The final unit writes this
   repo's `.claude/eghs.config.json` with real core-source globs. Escape-hatch CLIs
   (units 12–13) land BEFORE the flip so no deny message ever references a CLI that doesn't
   exist. Infra denies (NO_SESSION fail-closed etc.) do go live when unit 9 lands — accepted:
   this repo's state dir is healthy, and the kill switch (`.claude/eghs-off` / `EGHS_DISABLED=1`)
   remains the universal out.
6. **P4 includes `eghs-migrate`** (PRD carried item 1): the R3/R6 remediation matrix names
   `eghs-migrate --clear-sid/--clear-migrate-lock/--clear-init-lock`; landing the gate without
   them would deny with dead-end guidance. SCHEMA_MISMATCH read-only-mode rows land with the
   precedence #7 unit; migrate-guidance stderr rows land with the migrate units.
7. **Config keys added to DEFAULT_CONFIG** (all PRD defaults):
   `state_gate_paths: []`, `stale_after_seconds: 1800`, `session_stale_seconds: 86400`,
   `verify_logs_stale_seconds: 604800`, `read_state_stale_seconds: 2592000`,
   `failed_marker_stale_seconds: 2592000`, `tombstone_stale_seconds: 3600`.
   Fixed constants (not config): `migrate_lock_grace_ms=600000`, `foreign_migrate_lock_grace_ms=7200000`,
   `recovery_grace_ms=60000`, `init_lock_grace_ms=60000`, `far_future_grace_ms=86400000`,
   `wait_grace_ms=90000`, `admin_mutex_timeout_ms=30000`, `grace_ms=5000` (stop-lock).

## Units

| # | Unit | Files (create/modify) | Spec |
|---|------|------------------------|------|
| 1 | flock wrapper lib | C: hooks/lib/flock.js, tests/flock.test.js; M: package.json (+fs-ext) | R6 #3.7, R2.5 admin-mutex |
| 2 | tool_use_id retrofit on pre/ files | M: hooks/lib/pre-file.js, hooks/pre-tool-use.js, hooks/post-tool-use.js, hooks/inspect.js + their tests | R2.5 §221–228, R4 §517–530 |
| 3 | fs-info v2 (flock probe + FS anchor) + shared health predicate | M: hooks/lib/fs-info.js, hooks/init.js; C: tests additions | R2.5 init step 6, R6 #3.3 |
| 4 | eghs-init R16-R20 upgrade (admin-mutex, migrate.lock mutex, .init.lock body/stale rules, --repair Cases 1–5, schema-last ordering) | M: hooks/init.js, hooks/lib/state-dir.js | R2.5 §344–386, §290–300 |
| 5 | precedence #1–#3.7 (schema stat, kill switch, CI, fs-info check, NO_SESSION per-hook, tombstone + guard SH) | C: hooks/lib/precedence.js, hooks/lib/guard.js | R6 §669–736 |
| 6 | precedence #4 migrate.lock matrix + hook-type reclassification | M: hooks/lib/precedence.js | R6 §737–760 |
| 7 | precedence #5 GC pass (recover.lock GC, sessions GC cascade-before-lease + full cascade set, orphan tombstone sweep, pre/ 24h GC relocation, subdir check) | M: hooks/lib/precedence.js, hooks/lib/session.js, hooks/lib/pre-file.js (gc export moves), hooks/lib/lock.js | R6 §761–775, R2.5 §236–242 |
| 8 | precedence #6–#7 (lease link-create/renew, baseline anchor 6-branch tree, stale-cleanup i–vi, SID_COLLISION, schema/fs-info classification per hook) + `runPrecedence` assembly | M: hooks/lib/precedence.js, hooks/lib/session.js, hooks/lib/baseline.js | R6 §776–838 |
| 9 | R3 gate + pre-tool-use.js P4 rewrite (gate paths matching, conditions 1–5, deny enum, stderr contract, pre-file write/cleanup-on-deny) | C: hooks/lib/gate.js; M: hooks/pre-tool-use.js, hooks/lib/config.js | R3 §423–503, §8.7 |
| 10 | post-tool-use/stop/user-prompt-submit precedence integration (matrix marker reasons, Stop masking, UPS fail-soft rows) | M: hooks/post-tool-use.js, hooks/stop.js, hooks/user-prompt-submit.js | R4 §510–513, R6 matrix rows |
| 11 | debug log §5 event schema (uniform fields, all hooks, default ON) + --dry-run normative mode (`{decision, deny_code?, reason?, would_write[]}`) + inspect.js alignment | M: hooks/lib/debug-log.js, all entrypoints, hooks/inspect.js | §5 §889–916, R6 §850–858 |
| 12 | eghs-migrate CLI core (steps 0–8, --force-foreign-cleanup, --dry-run trace) | C: hooks/migrate.js, tests/migrate.test.js | R2.5 §387–406 |
| 13 | eghs-migrate --clear-sid / --clear-migrate-lock / --clear-init-lock (tombstone + guard EX side) | M: hooks/migrate.js | R2.5 §301–343, R6 #3.7 clear-sid |
| 14 | Flip + docs: this repo's `.claude/eghs.config.json` gate paths, HANDOFF/README, live smoke, carried minors (zero-commit git edge, CLAUDE_PROJECT_DIR unset test) | M: config, docs | §6 P4 row |
| F | Finale: p4-minors batch, PRD `fs_statfs_id` amendment, whole-branch senior + Codex review, fix wave, re-review | — | — |

## Unit Interfaces (what later units consume)

- `lib/flock.js`: `flockShNb(fd)->{ok, wouldBlock}`, `flockExNb(fd)`, `flockUn(fd)`,
  `acquireExWithTimeout(fd, timeoutMs, pollMs=100)->{ok}` (poll loop), all throwing only on
  non-EAGAIN errno.
- `lib/pre-file.js` (unit 2 signature change): every fn takes `toolUseId` after `key`
  (`preFilePath(stateDir, sid, key, toolUseId, kind)`); `findPreFiles(stateDir, sid, keyHash)`
  added for PostToolUse 2nd-pass (any tool_use_id for a hash).
- `lib/fs-info.js` (unit 3): `readFsInfo` returns `{status:'ok', caseless, flockOk, anchor}` only
  when the FULL unhealthy predicate passes; `fsInfoUnhealthyReason(stateDir)->string|null` shared
  by hooks (#3.3) and init --repair Case 4; `probeAndWriteFsInfo` writes v2 body
  `{schema_version, caseless_fs, flock_ok, fs_st_dev, fs_statfs_id, ts_ms}`.
- `lib/precedence.js` (units 5–8): `runPrecedence(hookType, input, {env, cwd, nowMs})` →
  `{outcome:'continue', ctx}` | `{outcome:'exit0', reason}` | `{outcome:'deny', denyCode, reason, remediation[]}`
  where `ctx = {stateDir, repoRoot, sid, caseless, config, guardFd, diskSchema, toolUseId}`.
  Hook entrypoints translate outcomes: PreToolUse deny → exit 2; PostToolUse deny candidates →
  marker + exit 0 per matrix; Stop deny → exit 2 masked per matrix; UPS → fail-soft.
- `lib/gate.js` (unit 9): `evaluateGate(ctx, key, {nowMs})` →
  `{allow:true, preSha}` | `{allow:false, denyCode, reason}` | `{skip:'not_applicable'|'outside_repo'|'new_file', preSha:null}`.

## Key spec values (verbatim from PRD)

- Gate pass evidence: `evidence ∈ {full_read, post_edit_success}` AND `state.sid == current sid`
  AND `state.sha == disk sha` AND `ts_ms` within `stale_after_seconds` (1800) AND no marker in
  either `failed/<sha1(key)>.json` or `failed/<current_sid>/<sha1(key)>.json` (after clear-policy attempt).
- Deny enum: UNREAD_OR_STALE, WRONG_SID, RACE_DETECTED, STATE_RECORD_FAILED, OVERWRITE_RACE,
  SCHEMA_MISMATCH, SCHEMA_NOT_INITIALIZED(Y), FS_INFO_MISSING(Y), MIGRATE_IN_PROGRESS(Y),
  INFRA_NOT_READY(reason-field matrix), SID_COLLISION, FILE_UNREADABLE(Y-limited), INPUT_PARSE(Y),
  NO_SESSION. (Y) = auto-unblock yes.
- INFRA_NOT_READY reason values: `infra_not_ready`, `lease_unavailable`, `sid_cleared`,
  `migrate_lock_corrupt`, `schema_invalid` (marker reasons reuse these strings).
- NO_SESSION: PreToolUse (all four tools) fail-closed block; PostToolUse short-circuit exit 0
  with single stderr line; UPS fail-soft; Stop block.
- Guard files: `sessions/<sid>.guard.lock` (empty, 0600, SH in hooks, EX in --clear-sid),
  `sessions/<sid>.tombstone` (JSON `{cleared_by_pid, cleared_by_uid, ts_ms, reason}`, link(2) create).
- Sessions GC cascade set (verbatim, order matters): guard.lock (before lease) → lease →
  baselines/<sid>.txt → verify-logs/<sid>/ → debug/<sid>.jsonl → pre/<sid>/ → failed/<sid>/ →
  locks/stop-<sid>.lock → locks/stop-<sid>.recover.lock → sessions/<sid>.tombstone; cascade
  BEFORE lease unlink; EPERM on any target → keep lease, log `sessions_gc_partial`.
- Debug event: `{schema_version, ts_ms, sid, hook, tool, path, gate_applicable,
  has_gate_passing_state, evidence_kind, kill_switch, decision, deny_code, latency_ms}`.
- Dry-run: #1–#3.5 real; #3.7 tombstone stat real, guard create/flock suppressed → would_write;
  #4–#7 mutations suppressed, decisions computed as if succeeded; stdout one-line decision JSON;
  stderr `[eghs] dry-run: no state writes performed`.

## Ordering rationale / risk notes

- Units 1–4 are pure infra with zero behavior change for live hooks (fs-info v2 is
  backward-compatible only via `eghs-init --repair`; run it on this repo right after unit 4
  lands — the hooks' #3.3 check does not exist until unit 5, so a v1 cache never blocks P3-era hooks).
- Units 5–8 build `runPrecedence` bottom-up but NO entrypoint calls it until unit 9/10 —
  each unit is lib+tests only, so live dogfooding stays on P3 behavior through unit 8.
- Unit 9 is the first live behavior change (PreToolUse can exit 2). Gate paths are `[]`,
  so only infra/NO_SESSION denies are reachable. Keep `.claude/eghs-off` in easy reach.
- Units 12–13 must precede unit 14 (decision 5).
- After every unit: `npm test` green; after units 9–14 additionally run the live smokes in
  HANDOFF §Verification.

## Verification quick reference

```bash
npm test                                    # full suite green (217 + new)
printf '{}' | node hooks/pre-tool-use.js; echo " exit=$?"          # NO_SESSION → exit 2 after unit 9
node hooks/pre-tool-use.js --dry-run < input.json                  # decision JSON after unit 11
node hooks/inspect.js                       # state dump incl. gate preview
node hooks/migrate.js --dry-run             # after unit 12
```
