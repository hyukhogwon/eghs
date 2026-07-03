# EGHS

Evidence-Gated Hook System for Claude Code. See `PRD.md` for the full spec.

Currently implemented: **P1 — Stop hook** (typecheck/lint/test verification gate),
**P2 — UserPromptSubmit** (fail-soft prompt-discipline injection), and
**P3 — Read/Edit state writer** (PreToolUse/PostToolUse record-only hooks: canonical-path
SHA-256 evidence records, TOCTOU/partial-apply detection, failed markers — gate stays off
until P4).

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

All hooks (Stop, UserPromptSubmit, PreToolUse/PostToolUse for Read/Write/Edit/MultiEdit)
are registered in `.claude/settings.json`. Make sure `.claude/state/` is
gitignored (state includes session leases, locks, evidence records, and verification logs, not source).

Inspect the recorded state at any time:

```bash
node hooks/inspect.js               # dump the whole state dir as JSON
echo '{"session_id":"<sid>","tool_name":"Edit","tool_input":{"file_path":"src/a.ts"}}' \
  | node hooks/inspect.js --dry-run # what the hooks would see for one file
```

## Kill switch

- `.claude/eghs-off` (create an empty file), or
- `EGHS_DISABLED=1`

## Tests

```bash
npm test
```
