# Codex CLI Hooks Research (for the deferred EGHS Codex port)

> Status: research only — user decision 2026-07-02: build the Codex port LAST, after all
> Claude Code phases (P3/P4) are complete. This file preserves the findings so the port's
> brainstorming can start from evidence, not re-research.
>
> Sources: (1) official docs/source audit pinned to tag `rust-v0.128.0` of github.com/openai/codex
> (docs at https://developers.openai.com/codex/hooks describe a NEWER version — always
> re-check the installed version when the port starts); (2) local empirical probe of the
> installed codex-cli 0.128.0 binary (strings + embedded JSON Schemas + live scratch-CODEX_HOME
> runs against a mock Responses API — marked "live-verified" below).

## Headline

Codex CLI has an intentionally **Claude Code-compatible hooks subsystem** (`codex_hooks`
feature: stable, default-on since 0.124/0.128). Source comment: "Enable Claude-style
lifecycle hooks loaded from hooks.json files." Same `hooks.json` schema, same
PascalCase event keys, same exit-code contract. An EGHS port is mostly registration +
payload-field deltas, not a rewrite.

## Events (0.128.0 — closed enum of 6)

`PreToolUse`, `PermissionRequest`, `PostToolUse`, `SessionStart`, `UserPromptSubmit`, `Stop`.
No SessionEnd / Notification / PreCompact / SubagentStop at 0.128.0 (current ~0.14x docs list 10
events incl. SubagentStart/SubagentStop/PreCompact/PostCompact — version-gate any use).
Unknown event keys in hooks.json are silently ignored (live-verified) — forward-compatible.
`codex review` sessions disable hooks entirely (0.121+).

## stdin payload

Common fields: `session_id`, `transcript_path` (rollout .jsonl; nullable), `cwd`,
`hook_event_name`, `model`, `permission_mode` (`default|acceptEdits|plan|dontAsk|bypassPermissions`
— Claude Code's names). `turn_id` on every event except SessionStart.

| Event | Extra fields |
|---|---|
| SessionStart | `source`: `startup\|resume\|clear` |
| UserPromptSubmit | `prompt` |
| PreToolUse | `tool_name`, `tool_use_id`, `tool_input` |
| PostToolUse | + `tool_response` |
| PermissionRequest | `tool_name`, `tool_input` (no tool_use_id) |
| Stop | `stop_hook_active`, `last_assistant_message` |

Compatibility gold: internal `exec_command` surfaces as **`tool_name:"Bash"` with
`tool_input:{"command":...}`** — Claude Code's exact shape (live-verified). Matchers accept
`Write`/`Edit` as aliases for apply_patch (source: hook_names.rs, "compatibility with hook
configurations that describe edits using Claude Code-style names").

## Output contract / exit codes

- Exit 0: stdout parsed as JSON if present. Common fields `continue`, `stopReason`,
  `suppressOutput`, `systemMessage`, `hookSpecificOutput`.
- **Exit 2 + non-empty stderr = block** (live-verified on UserPromptSubmit; Stop: stderr becomes
  the continuation prompt). Exit 2 with EMPTY stderr = hook failure, not a block. Other
  non-zero: logged, non-blocking. → identical to Claude Code, and identical to the Stop-hook
  contract EGHS adopted in commit 3f7b661.
- Stop: `{"decision":"block","reason":...}` resumes the turn; second Stop then fires with
  `stop_hook_active:true` (live-verified). Reason REQUIRED with block.
- UserPromptSubmit: `decision:"block"+reason`, `additionalContext`, or plain-text stdout as
  context. SessionStart: `additionalContext` (this machine's ~/.codex/hooks.json proves it works).
- PreToolUse (0.128.0): deny-only — `permissionDecision:"deny"` or `decision:"block"` honored
  (live-verified: tool never ran); `allow`/`ask`/`updatedInput`/`additionalContext` are explicit
  "unsupported" errors at 0.128.0 (newer versions add updatedInput/allow — version-gate).
- Malformed hook stdout JSON → hook counted failed, execution continues (fail-open;
  live-observed). EGHS's fail-closed Stop gate must therefore rely on exit 2, never on JSON.

## Discovery & config

- User layer: `$CODEX_HOME/hooks.json` (default `~/.codex/hooks.json`; CODEX_HOME override
  live-verified). Inline `config.toml [hooks]` also documented.
- Project layer: `<repo>/.codex/hooks.json` — live-verified, **only when the workspace is
  trusted** (`[projects."<path>"] trust_level = "trusted"`); untrusted → silently skipped.
- Layers merge ADDITIVELY (higher precedence does not replace lower — all matching hooks run).
- Handler: `{"type":"command","command":"...","timeout":<sec>}`; default timeout 600s;
  `type:"prompt"|"agent"` and `async:true` parse but are skipped ("not supported yet").
- Matchers: PreToolUse/PermissionRequest/PostToolUse (tool-name regex; live-verified) and
  SessionStart (source). UserPromptSubmit/Stop ignore matchers.
- Command runs via `$SHELL -lc` (POSIX), cwd = session cwd.

## Port-relevant deltas vs Claude Code (the actual work list)

1. **No `CLAUDE_PROJECT_DIR` / `CODEX_PROJECT_DIR`** for plain hooks (confirmed absent from
   binary). Registration must use a stable path or resolve repo root from stdin `cwd` / git —
   EGHS hooks already resolve repo root via git (stop.js) and cwd-fallback (UPS), so mainly a
   hooks.json-authoring concern.
2. **No `CLAUDE_CODE_PID`** — stop.js already falls back to `process.ppid`.
3. Stop stdin has no Claude-style extras EGHS needs beyond `session_id` + `stop_hook_active` —
   both present. UPS prompt field is `prompt` (Claude Code sends the prompt too; EGHS UPS
   ignores input anyway).
4. Registration artifact: ship a `.codex/hooks.json` in the repo (works only for trusted
   workspaces) — document the trust requirement.
5. `codex exec` fires hooks (live-verified: SessionStart/UPS/PreToolUse/PostToolUse/Stop).
6. Version gates: event list and PreToolUse capabilities differ between 0.128.0 and current
   docs. Re-run `codex --version` + re-check https://developers.openai.com/codex/hooks and
   https://developers.openai.com/codex/changelog when the port starts.

## Open questions (carry into port brainstorming)

- Exact TOML `[hooks]` representation (couldn't activate via user config.toml or `-c` in probes).
- PermissionRequest semantics only from strings (never live-fired; needs interactive flow).
- Default-timeout value not extracted from binary (docs say 600s; per-hook `timeout` field exists).
- Full tool_name mapping table beyond exec_command→Bash (do read/patch tools surface as
  `Read`/`Edit`? matters for P3-equivalent PostToolUse state recording on Codex).
- Untrusted-project hook handling under `codex exec` (skip vs prompt) unconfirmed at 0.128.0.
