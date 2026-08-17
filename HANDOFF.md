# EGHS Handoff

Agent-facing handoff for the next session. Human-facing overview lives in `README.md`; full spec in `PRD.md`.

## Project State (as of 2026-08-17)

Evidence-Gated Hook System for Claude Code. Rollout per PRD §6 — **all five phases done**:

| Phase | Scope | Status |
|-------|-------|--------|
| P1 | Stop hook — typecheck/lint/test verification gate | **DONE** (reviewed, 96 tests) |
| P2 | UserPromptSubmit — fail-soft prompt-discipline injection | **DONE** (reviewed, +17 tests) |
| P3 | Pre/PostToolUse Read/Edit state writer — gate off, records only | **DONE** (reviewed per unit, +102 tests) |
| P4 | Edit state-gate on core source paths | **DONE** (units 1-14 + finale, +210 tests) |
| P5 | matcher expansion to source/config + measurement CLIs | **DONE** (units 1-4, +42 tests) |

- Branch: `main`, pushed to https://github.com/hyukhogwon/eghs (public). Everything after P2 is local-only until the user asks for a push.
- Suite: **469/469** via `npm test`. Do NOT use `node --test tests/` (bare directory form) — broken on Node v24; single-file `node --test tests/<file>.js` works.
- **The R3 gate is LIVE in this repo, now over source AND config**: `.claude/eghs.config.json` sets
  `state_gate_paths: ["hooks/**/*.js", "tests/**/*.js", "package.json", ".claude/*.json"]`, so editing any of
  those without a same-session `full_read`/`post_edit_success` record is denied (exit 2). Read the file
  first, or use the kill switch below. Docs (`*.md`) are deliberately NOT gated — neither source nor config.
- All hooks (Stop, UserPromptSubmit, PreToolUse + PostToolUse with matcher `Read|Write|Edit|MultiEdit`) are registered in `.claude/settings.json` and live in this repo's own Claude Code sessions (dogfooding).

## Process Conventions (established across P1/P2, kept through P5)

1. brainstorm → design spec (`docs/superpowers/specs/`) → implementation plan (`docs/superpowers/plans/`) → subagent-driven execution (fresh implementer per task + task review) → final checkpoint: senior whole-branch review **+ Codex review**, fix all Critical/Major, re-review.
2. TDD per task; commit per task; Conventional Commits; work directly on `main`; never push without explicit user request.
3. Plan code blocks are verbatim — implementers transcribe, they don't improvise.
4. Session scratch/ledger in `.superpowers/sdd/` (self-gitignored).

Deviation to know about: the P4 finale and all of P5 ran **without subagents** — those sessions'
system prompts forbade spawning them unless the user asked. Reviews were whole-branch self-review
passes instead. The senior + Codex whole-branch review in convention 1 is therefore still OPEN for
P4 and P5 if the user wants it.

## Key Design Decisions (do not re-litigate)

- **Stop is fail-closed (exit 2 blocks); UserPromptSubmit is fail-soft (exit 0 ALWAYS)** — exit 2 there would erase the user's prompt. `hooks/user-prompt-submit.js` has a top-level try/catch AND a `process.stdout.on('error', ...)` no-op (EPIPE from a dying host arrives async, bypassing try/catch — found by final review, regression-tested).
- CI passthrough applies to UserPromptSubmit but NOT Stop (PRD §6 line 688).
- UserPromptSubmit writes no state, runs no git; repo root = `CLAUDE_PROJECT_DIR || cwd`.
- `$CLAUDE_PROJECT_DIR` in settings.json hook commands has no shell fallback — reviewed, user decided keep-as-is (Claude Code always sets it; symmetric with P1).
- Stop output contract (fixed 2026-07-02): allow = exit 0 + EMPTY stdout (Claude Code's zod output schema rejects `decision:"allow"` — enum is `approve|block`); block = exit 2 + reason on STDERR (`[eghs] block <deny_code>: <reason>` + per-check lines — stdout is not parsed on exit 2). UserPromptSubmit stdout carries only the `hookSpecificOutput` envelope. All other diagnostics stderr-only.
- **Glob semantics are bash-glob (picomatch v4, `{ dot: true }`), NOT gitignore(5)** — user decision 2026-07-02 after a spec audit proved picomatch has no `gitignore` option (PRD §R4 amended; nested matches need `**/`, no trailing-`/` dirs, no order-dependent `!` negation). Non-ASCII filenames are handled by forcing `core.quotePath=false` in every git call (hooks/lib/git.js).
- **verify.js timeout design is deliberate**: manual timer + detached process-group SIGTERM→SIGKILL (hooks/lib/verify.js). Do NOT "simplify" to child_process's built-in `timeout` option — it signals only the direct child and leaks grandchildren.
- No `CLAUDE_CODE_PID` env var exists in Claude Code (verified v2.1.198); lease/lock pid is `process.ppid` by design. NO_SESSION fail-open path logs `[eghs] NO_SESSION` to stderr for observability (docs only guarantee session_id is a string, not UUIDv4).

## P3 Design Decisions (do not re-litigate)

- **P3 includes PreToolUse record-only hooks** (not just PostToolUse): the R4 write matrix consumes `pre/<sid>/<hash>.write.json`; without PreToolUse, R4 would sit permanently in its miss-path. Plan: `docs/superpowers/plans/2026-07-02-eghs-p3-state-writer.md`.
- **Both tool hooks ALWAYS exit 0** — exit 2 on PreToolUse would deny the tool call; every abnormal path degrades to "skip recording". Denies are P4.
- Canonical key = realpath, then `lowercase(NFC(...))` iff caseless FS (`fs-info.json`, probed once by init via `.cs-probe`/`.CS-PROBE` dev+ino compare; NFC amendment 2026-07-03). New-file Writes use deep-new-path resolution (`canonicalKeyAllowMissing`). Out-of-repo keys skip.
- SHA-256 is streamed (64KiB chunks) — `readFileSync` whole-file breaks at 2GiB.
- Evidence grades: `full_read`, `partial_read` (offset/limit or > `max_full_read_bytes`, sha null — must never pass a gate), `stale_read` (PreToolUse sha mismatch = TOCTOU), `post_edit_success`, `post_edit_partial`.
- Failed markers: key-scoped `failed/<hash>.json` + sid-scoped `failed/<sid>/<hash>.json`. Clear policy (PRD 170): own-sid always; other-sid key-scoped only if `ts_ms < lease start_ms`; other-sid sid-scoped NEVER (cascade GC's job).
- Orphan pre-file 2nd pass: a sid is dead only on lease ENOENT or dead pid; a present-but-corrupt lease is LIVE (fail-closed); lease re-checked immediately before the unlink.
- Lease pid = `process.ppid` (see CLAUDE_CODE_PID note above); lease failure in a tool hook → sid-scoped `lease_unavailable` marker, skip.

## Carried Items for P4 — all closed in unit 14

1. **Schema MISMATCH handling** — closed by P4 units 8/12: precedence #7 classifies MISMATCH per hook, and `eghs-migrate` performs the version move.
2. **Zero-commit git repo edge** — closed: `getChangedFiles` detects a repo with no commits and reports untracked files only, so Stop runs verification instead of failing `INFRA_NOT_READY`.
3. **`CLAUDE_PROJECT_DIR` unset → cwd fallback** — closed: two regression tests in `tests/user-prompt-submit.test.js`. (Tests still leave `mkdtemp` dirs; OS-reaped, matches suite convention.)

## P5 Design Decisions (do not re-litigate)

- **"matcher 확장" is the `state_gate_paths` glob matcher, not the Claude Code hook `matcher` field.**
  §6's Scope column is a *path* scope on every row; adding tools (NotebookEdit/Bash) would be an §R3
  spec change, and §3 lists direct Bash blocking as a non-goal. PRD §6 amended to say so.
- **`gate_applicable` is false for new-file Writes.** §R3 defines applicability as "matches
  `state_gate_paths` AND exists on disk". The old `true` parked every new file in the Evidence-bearing
  Edit ratio denominator with `has_gate_passing_state:false` — permanently depressing the exact metric
  P4/P5 gate on. PRD §5 event-schema note amended.
- **Kill switch usage is NOT measurable** and the PRD said otherwise. §R6 #2 forbids any disk write once
  the switch is active, and that no-write rule is the single basis for G5 — so it outranks the metric.
  `eghs-metrics` reports the *current* kill-switch state instead; the count is an operator's out-of-band
  observation (kill switch is human-intent-only per §3). PRD §5 amended, same resolution as False-deny rate.
- **Zero-denominator ratios report `null`, never `0`.** "No data" and "nothing passed" are different
  answers and §6's exit criteria act on them differently.
- **Bypass outcomes are four-way, not two-way**: `detected` (block + RACE_DETECTED), `blocked_other`
  (block with a different deny_code — the edit WAS stopped, just not by race detection), `missed`
  (allowed through), `undetermined` (no follow-up edit; excluded from the denominator — an edit that
  never happened cannot be denied). Forced by the first end-to-end smoke: a bypass on a file the session
  never read denies `UNREAD_OR_STALE`. The headline rate keeps §5's literal definition; the breakdown
  stops a block from reading as an escape.
- **Creations/deletions are snapshot-only.** An Edit on a file EGHS never saw denies `UNREAD_OR_STALE`,
  not `RACE_DETECTED`, so §5's rate is undefined over them.
- **The watcher writes only into `debug/`** (`bypass-watcher.jsonl` + `.bypass-snapshot.json`) — an
  existing §R2.5 subdir, so no layout change and no `schema_version` bump. `debug/` GC is per-sid and
  never touches those two, so the watcher rotates its own log at 5 MiB (§G5).
- **The watcher is not a hook**: no lease, no guard, no precedence chain. It honours the kill switch
  before any write, requires a healthy schema + fs-info, and prunes `.git`, `node_modules`, and the
  state dir from its walk.
- `eghs-metrics` and `eghs-bypass-watcher` share `gate.js`'s picomatch call semantics (v4, `{dot:true}`,
  repo-relative) — §R3's "picomatch 단일 reference" rule.

## Deferred: Codex CLI Port (comes AFTER P5)

User decision 2026-07-02: make EGHS usable from OpenAI Codex CLI, but only once every
Claude Code phase is done. **P5 closed 2026-08-17, so this is now the next thing on deck.**
Research is complete and preserved in
`docs/research/2026-07-02-codex-hooks-research.md` — Codex ships a Claude Code-compatible
hooks.json subsystem (same events/exit-2-stderr contract), so the port is mostly
registration (`.codex/hooks.json`, trust-gated) plus small payload/env deltas. Re-verify
against the then-installed Codex version before designing.

## P4 Design Decisions (do not re-litigate)

- **One precedence driver**: `lib/precedence.js` `runPrecedence(hookKind, input, opts)` implements PRD §R6 #1-#7 exactly once; every entrypoint calls it and then does its own #8. Outcomes are `continue | exit0 | marker_exit0 | deny`, translated per hook (PreToolUse deny → exit 2, PostToolUse → fail-closed marker + exit 0, Stop → masked deny, UPS → fail-soft).
- **#1-#3.7 are mutation-free**, with exactly two sanctioned exceptions: the #3.7 guard.lock create, and the #3.3 fs-info anchor-mismatch re-probe (2026-07-19 amendment — APFS `st_dev` churns across reboots, so a mismatch self-heals under `.init.lock` instead of denying). ALL GC happens in #5b.
- **flock comes from `fs-ext@2.1.1`** (native dep). `EAGAIN` is the `EWOULDBLOCK` alias; blocking-with-timeout acquires are `exnb` poll loops (100ms), never blocking flock — CLIs stay interruptible.
- **`fs_statfs_id` deviates from the PRD letter**: Node core exposes only the numeric `fs.statfsSync().type`, so the anchor is `"<platform>:<decimal type>"` (e.g. `darwin:26`). Same anchor strength, no native code.
- **Lease pid is `process.ppid`** — `CLAUDE_CODE_PID` does not exist (verified v2.1.198).
- **`tool_use_id` is real** (verified Claude Code 2.1.207): Pre/PostToolUse share it, so `pre/<sid>/<hash>.<tool_use_id>.{write,read}.json` keeps parallel same-file calls from sharing a pre-record. Absent → literal `none`.
- **Gate scope is config, not code**: `state_gate_paths` is `[]` in `DEFAULT_CONFIG` (dark for every consumer repo); this repo opts in via `.claude/eghs.config.json`. Matching is bash-glob (picomatch v4, `{dot:true}`) against the repo-root-relative canonical key.
- **Escape hatches ship before the gate** (units 12-13 precede 14) so no deny message ever names a CLI that does not exist: `eghs-migrate --clear-sid <SID>` (corrupt lease/baseline), `--clear-migrate-lock`, `--clear-init-lock`.
- The R3 gate reads exactly what `node hooks/inspect.js --dry-run` prints (state record, key marker, sid marker, pre-files) — inspect is the gate's preview.
- NFC/NFD normalization DECIDED at P3 finale (2026-07-03): canonical key on caseless FS is `lowercase(NFC(realpath))` — PRD §R2 amended, implemented in `hooks/lib/canonical.js` (`caselessKey`).

## Admin CLIs

```bash
node hooks/init.js                      # bootstrap (schema_version written LAST)
node hooks/init.js --repair             # Cases 1-5: INVALID schema, missing subdir, fs-info absent/unhealthy, no-op
node hooks/migrate.js                   # schema move: sessions GC -> empty-state precondition -> record wipe -> atomic bump
node hooks/migrate.js --dry-run         # zero-write trace of the whole plan
node hooks/migrate.js --clear-sid <SID> # corrupt lease/baseline escape (add --force / --force-foreign-cleanup as the gates demand)
node hooks/migrate.js --clear-migrate-lock
node hooks/migrate.js --clear-init-lock
```

Lock order for every admin op: `admin-mutex → migrate.lock → sid guard`.

## Measurement CLIs (P5, read-only — no lock, no sid)

```bash
node hooks/metrics.js                       # PRD §5 metric table
node hooks/metrics.js --json                # machine output
node hooks/metrics.js --sid <SID> --since 7d
node hooks/bypass-watcher.js --once         # one poll (first poll = baseline only)
node hooks/bypass-watcher.js --interval-seconds 30
```

`bypass_detection_rate` stays `n/a` until the watcher has produced observations AND a later
Write/Edit touched the same path — run the watcher before/after a shell edit to exercise it.

## Verification Quick Reference

```bash
npm test                                   # full suite, expect 469 passing
printf '{"session_id":"11111111-1111-4111-8111-111111111111"}' \
  | node hooks/stop.js; echo " exit=$?"    # Stop smoke (this repo: exit 0, EMPTY stdout when clean)
printf '{}' | node hooks/user-prompt-submit.js; echo " exit=$?"  # UPS smoke: principles JSON + exit 0
# NO_SESSION fail-closed: exit 2. A bare `{}` exits 0 instead — with no
# tool_name the hook is not applicable and never reaches precedence.
printf '{"tool_name":"Edit","tool_input":{"file_path":"'$PWD'/hooks/lib/gate.js"}}' \
  | node hooks/pre-tool-use.js; echo " exit=$?"

node hooks/inspect.js                      # state dump (schema/fs-info/sessions/reads/markers/pre)
node hooks/migrate.js --dry-run            # migrate plan, writes nothing

# What the gate would decide for one file, without touching state:
printf '{"session_id":"<sid>","tool_name":"Edit","tool_input":{"file_path":"'$PWD'/hooks/lib/gate.js"}}' \
  | node hooks/pre-tool-use.js --dry-run   # {"decision":...,"deny_code":...,"would_write":[...]}
```

Running a hook by hand with a LIVE sid returns `SID_COLLISION` — the lease pid is
`process.ppid`, which is your shell, not the Claude Code process that owns the lease.
Use a throwaway sid for manual end-to-end smokes and clean it up afterwards with
`node hooks/migrate.js --clear-sid <SID> --force`.

Kill switch for local debugging: `touch .claude/eghs-off` (remove after) or `EGHS_DISABLED=1`.
