# EGHS Handoff

Agent-facing handoff for the next session. Human-facing overview lives in `README.md`; full spec in `PRD.md`.

## Project State (as of 2026-07-02)

Evidence-Gated Hook System for Claude Code. Rollout per PRD §6:

| Phase | Scope | Status |
|-------|-------|--------|
| P1 | Stop hook — typecheck/lint/test verification gate | **DONE** (reviewed, 96 tests) |
| P2 | UserPromptSubmit — fail-soft prompt-discipline injection | **DONE** (reviewed, +17 tests) |
| P3 | Pre/PostToolUse Read/Edit state writer — gate off, records only | **DONE** (reviewed per unit, +85 tests) |
| P4 | Edit state-gate on core source paths | NOT STARTED |

- Branch: `main`, pushed to https://github.com/hyukhogwon/eghs (public). HEAD at P2 completion: `e1371d7`.
- Suite: **200/200** via `npm test`. Do NOT use `node --test tests/` (bare directory form) — broken on Node v24; single-file `node --test tests/<file>.js` works.
- All hooks (Stop, UserPromptSubmit, PreToolUse + PostToolUse with matcher `Read|Write|Edit|MultiEdit`) are registered in `.claude/settings.json` and live in this repo's own Claude Code sessions (dogfooding).

## Process Conventions (established across P1/P2, keep for P3)

1. brainstorm → design spec (`docs/superpowers/specs/`) → implementation plan (`docs/superpowers/plans/`) → subagent-driven execution (fresh implementer per task + task review) → final checkpoint: senior whole-branch review **+ Codex review**, fix all Critical/Major, re-review.
2. TDD per task; commit per task; Conventional Commits; work directly on `main`; never push without explicit user request.
3. Plan code blocks are verbatim — implementers transcribe, they don't improvise.
4. Session scratch/ledger in `.superpowers/sdd/` (self-gitignored).

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
- Canonical key = realpath + lowercase iff caseless FS (`fs-info.json`, probed once by init via `.cs-probe`/`.CS-PROBE` dev+ino compare). New-file Writes use deep-new-path resolution (`canonicalKeyAllowMissing`). Out-of-repo keys skip.
- SHA-256 is streamed (64KiB chunks) — `readFileSync` whole-file breaks at 2GiB.
- Evidence grades: `full_read`, `partial_read` (offset/limit or > `max_full_read_bytes`, sha null — must never pass a gate), `stale_read` (PreToolUse sha mismatch = TOCTOU), `post_edit_success`, `post_edit_partial`.
- Failed markers: key-scoped `failed/<hash>.json` + sid-scoped `failed/<sid>/<hash>.json`. Clear policy (PRD 170): own-sid always; other-sid key-scoped only if `ts_ms < lease start_ms`; other-sid sid-scoped NEVER (cascade GC's job).
- Orphan pre-file 2nd pass: a sid is dead only on lease ENOENT or dead pid; a present-but-corrupt lease is LIVE (fail-closed); lease re-checked immediately before the unlink.
- Lease pid = `process.ppid` (see CLAUDE_CODE_PID note above); lease failure in a tool hook → sid-scoped `lease_unavailable` marker, skip.

## Carried Items for P4 (adjudicated)

1. **Schema MISMATCH handling** — `readSchemaVersion` returns `ok` for any well-formed version; no hook compares against `HOOK_SCHEMA_VERSION`. Bundle the PRD §R6 migrate-guidance rows with whichever phase lands `eghs-migrate`.
2. **Zero-commit git repo edge (P1/Stop)** — fresh repo with no commits → `git diff HEAD` fails → confusing `INFRA_NOT_READY`. Known limitation, fix opportunistically.
3. Minor: one test for `CLAUDE_PROJECT_DIR` unset → cwd fallback; tests leave `mkdtemp` dirs (OS-reaped, matches suite convention).

## Deferred: Codex CLI Port (comes AFTER P4)

User decision 2026-07-02: make EGHS usable from OpenAI Codex CLI, but only once every
Claude Code phase is done. Research is complete and preserved in
`docs/research/2026-07-02-codex-hooks-research.md` — Codex ships a Claude Code-compatible
hooks.json subsystem (same events/exit-2-stderr contract), so the port is mostly
registration (`.codex/hooks.json`, trust-gated) plus small payload/env deltas. Re-verify
against the then-installed Codex version before designing.

## P4 Pointers

- Spec: PRD §R3 (Edit gate — evidence check + deny codes, lines ~300-430), §R4 deny rows, §6 P4 exit criteria (evidence-bearing Edit ratio > 0.9, zero perceived false-denies).
- P4 flips PreToolUse Write/Edit from record-only to gating: `full_read`/`post_edit_success` evidence with matching sha passes; `failed/<current_sid>/` markers deny. Scope: core source paths only (matcher/config).
- The R3 gate reads exactly what `node hooks/inspect.js --dry-run` prints today (state record, key marker, sid marker, pre-files) — inspect is the gate's preview.
- NFC/NFD Unicode normalization spec gap (PRD says `lowercase(realpath)` only) — decision deferred at P3 finale; revisit before P4 widens matchers.

## Verification Quick Reference

```bash
npm test                                   # full suite, expect 200 passing
printf '{"session_id":"11111111-1111-4111-8111-111111111111"}' \
  | node hooks/stop.js; echo " exit=$?"    # Stop smoke (this repo: exit 0, EMPTY stdout when clean)
printf '{}' | node hooks/user-prompt-submit.js; echo " exit=$?"  # UPS smoke: principles JSON + exit 0
node hooks/inspect.js                      # P3 state dump (schema/fs-info/sessions/reads/markers/pre)
```

Kill switch for local debugging: `touch .claude/eghs-off` (remove after) or `EGHS_DISABLED=1`.
