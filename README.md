# EGHS

Evidence-Gated Hook System for Claude Code. See `PRD.md` for the full spec.

Currently implemented: **P1 — Stop hook** (typecheck/lint/test verification gate)
and **P2 — UserPromptSubmit** (fail-soft prompt-discipline injection).

## Setup

```bash
npm install
node hooks/init.js
```

Configure verification commands in `.claude/eghs.config.json`:

```json
{
  "verification_commands": { "typecheck": "pnpm typecheck", "lint": "pnpm lint" }
}
```

The Stop hook is registered in `.claude/settings.json`. Make sure `.claude/state/` is
gitignored (state includes session leases, locks, and verification logs, not source).

## Kill switch

- `.claude/eghs-off` (create an empty file), or
- `EGHS_DISABLED=1`

## Tests

```bash
npm test
```
