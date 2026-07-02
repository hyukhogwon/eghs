# EGHS Handoff

Agent-facing handoff for the next session. Human-facing overview lives in `README.md`; full spec in `PRD.md`.

## Project State (as of 2026-07-02)

Evidence-Gated Hook System for Claude Code. Rollout per PRD §6:

| Phase | Scope | Status |
|-------|-------|--------|
| P1 | Stop hook — typecheck/lint/test verification gate | **DONE** (reviewed, 96 tests) |
| P2 | UserPromptSubmit — fail-soft prompt-discipline injection | **DONE** (reviewed, +17 tests) |
| P3 | PostToolUse Read/Edit state writer — gate off, records only | NOT STARTED |
| P4 | Edit state-gate on core source paths | NOT STARTED |

- Branch: `main`, pushed to https://github.com/hyukhogwon/eghs (public). HEAD at P2 completion: `e1371d7`.
- Suite: **113/113** via `npm test`. Do NOT use `node --test tests/` (bare directory form) — broken on Node v24; single-file `node --test tests/<file>.js` works.
- Both hooks are registered in `.claude/settings.json` and live in this repo's own Claude Code sessions (dogfooding: the `[EGHS] Working agreement` system reminder each turn is P2 working).

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

## Carried Items for P3 (from final P2 review, adjudicated)

1. **Extract shared `readStdin`** — currently duplicated byte-for-byte in `hooks/stop.js` and `hooks/user-prompt-submit.js` (plan-mandated deferral until a third consumer exists = P3). Fix the `EAGAIN → continue` busy-loop during extraction; update all three call sites together.
2. **Schema MISMATCH handling** — `readSchemaVersion` returns `ok` for any well-formed version; no hook compares against `HOOK_SCHEMA_VERSION`. Bundle the PRD §R6 migrate-guidance rows with whichever phase lands `eghs-migrate`.
3. **Zero-commit git repo edge (P1/Stop)** — fresh repo with no commits → `git diff HEAD` fails → confusing `INFRA_NOT_READY`. Known limitation, fix opportunistically.
4. Minor: one test for `CLAUDE_PROJECT_DIR` unset → cwd fallback; tests leave `mkdtemp` dirs (OS-reaped, matches suite convention).

## P3 Pointers

- Spec: PRD §R2 (Read state recording, lines 88-173), §R2.5 (state dir layout — `reads/`, `failed/`, `pre/` subdirs deferred from P1), §R4 (Edit state update). P3 is "gate off, state 기록만" — no denies yet.
- P3 needs: `fs-info.json` case-sensitivity probe in `eghs-init` (PRD R2 lines 110-115), canonical path (realpath + optional lowercase), SHA-256 of raw disk bytes, `PostToolUse` matchers for Read and Write/Edit.
- Exit criteria: "state 생성/갱신 정상" — an `eghs-inspect` dump CLI is named as the P3 verification tool (PRD §6 line 761).
- Reuse: `atomic-write`, `exclusive-link`, `state-dir`, `schema`, `kill-switch`, `ci` libs as-is; extend `P1_SUBDIRS` (rename or add a P3 list).

## Verification Quick Reference

```bash
npm test                                   # full suite, expect 113 passing
printf '{"session_id":"11111111-1111-4111-8111-111111111111"}' \
  | node hooks/stop.js; echo " exit=$?"    # Stop smoke (this repo: exit 0, EMPTY stdout when clean)
printf '{}' | node hooks/user-prompt-submit.js; echo " exit=$?"  # UPS smoke: principles JSON + exit 0
```

Kill switch for local debugging: `touch .claude/eghs-off` (remove after) or `EGHS_DISABLED=1`.
