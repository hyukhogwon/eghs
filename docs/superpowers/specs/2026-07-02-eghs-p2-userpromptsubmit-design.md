# EGHS P2 — UserPromptSubmit Prompt-Discipline Injection (Design)

> Status: **draft — awaiting user review**. Feeds `writing-plans` next.
> Rollout: PRD.md §6 Phase **P2** ("+ UserPromptSubmit / prompt discipline"), exit
> criteria "모델이 Read/verify 흐름을 따르는지 정성 확인". Depends on P1 (Stop hook) — complete.

## 1. Goal

Inject the EGHS prompt-discipline principles (PRD §R1) into the model's context at the
start of every user turn, so the model *voluntarily* follows the Read-before-Edit /
re-Read-after-out-of-band-change / verify-before-Stop flow that P3/P4 will later enforce
with hard gates. The hook is **fail-soft**: it must never block, reject, or delay a user
prompt, and never crashes the turn (exit code is always non-blocking).

Success is qualitative (PRD exit criteria): in a real session, the model demonstrably
reads files before editing and runs verification before ending. There is no automated
pass/fail gate in P2 — the injected context is a *nudge*, not an enforcer.

## 2. Hook I/O contract (Claude Code `UserPromptSubmit`, verified 2026-07-02)

**Stdin JSON** (all fields always present): `session_id`, `prompt_id`, `transcript_path`,
`cwd`, `permission_mode`, `hook_event_name` (`"UserPromptSubmit"`), `user_input`.

**Context injection** — canonical structured form:

```json
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"...text..."}}
```

Emitted on **stdout** with **exit 0**. Claude Code injects `additionalContext` as a
**system reminder** (not a visible chat message) — ideal for a working-agreement nudge that
should not clutter the conversation. Plain-stdout injection is the simpler alternative but
appears as conversation text; we use the JSON form for cleanliness and to keep our
"stdout carries only the structured payload" discipline consistent with `stop.js`.

**Exit codes for this event:**
- `0` — prompt proceeds; stdout parsed for the JSON above. **All EGHS branches use this.**
- `2` — blocks *and erases* the user's prompt. **EGHS never emits this** (violates fail-soft).
- other — non-blocking; first stderr line shown in transcript. Used only as the crash backstop.

PRD §R1 output rule: `additionalContext` is the **only** thing on stdout; all debug/error
text goes to stderr. stdout pollution corrupts model input, so the separation is strict.

## 3. Approaches considered

- **A. Minimal stateless injector (CHOSEN).** Static principles via the JSON form above;
  a short fail-soft precedence walk (kill switch → CI → schema stat); **no** state writes,
  **no** git, **no** lease/lock/baseline/debug-log. Mirrors PRD §R1 + §R6 fail-soft rows
  exactly. Tiny surface, fast cold start, trivially testable.
- **B. Stateful injector.** Additionally write a `debug/` entry per prompt and run
  `gcSessions` for observability. Rejected: PRD (§R2.5 line 284) says UserPromptSubmit
  **writes no state**; adds latency and moving parts for telemetry we can get from the
  transcript.
- **C. Config-driven injector.** A `.claude/eghs.config.json` block to customize/toggle the
  principle text. Rejected (YAGNI): the kill switch already disables EGHS wholesale, and the
  principles are fixed by §R1. Can be added later if a real need appears.

## 4. Architecture (Approach A)

`hooks/user-prompt-submit.js` is a standalone Node CLI (CommonJS, no build step) registered
under the `UserPromptSubmit` event. It reads stdin, walks a short **fail-soft** precedence
chain, and writes at most one JSON line to stdout. It touches disk only via **stat/read**
(kill-switch file, `schema_version`) — it writes nothing.

### 4.1 Precedence walk (all branches exit 0)

1. **Parse stdin (best-effort).** On malformed JSON, treat input as `{}` and continue — the
   injected principles are input-independent, so a bad payload never blocks the turn.
   (No recursion guard: user prompts are not recursive, unlike Stop.)
2. **Kill switch** (`checkKillSwitch`, reused from P1). Active ⇒ stderr
   `[eghs] kill-switch active: <reason>`, **empty stdout**, exit 0 (EGHS fully off ⇒ inject
   nothing).
3. **CI passthrough** (`isCI`, new). PRD §6 line 688: `UserPromptSubmit` gets a graceful pass
   in CI (`CI=true|1`, `GITHUB_ACTIONS=true`, `GITLAB_CI=true`, `BUILDKITE=true`). In CI there
   is no interactive model to nudge ⇒ **empty stdout**, exit 0. (Note: unlike Stop, which
   *excludes* CI passthrough, UserPromptSubmit honors it — matching the PRD.)
4. **Schema stat** (`readSchemaVersion`, reused). `not_initialized` or `invalid` ⇒ **fail-soft
   guidance** (PRD §R6 line 665): inject a one-line `additionalContext` nudge
   ("run `node hooks/init.js`") instead of the full principles, exit 0. `ok` ⇒ next step.
5. **Healthy path.** Inject the §R1 principles as `additionalContext`, exit 0.

A top-level `try/catch` wraps `main`: any unexpected throw ⇒ stderr diagnostic, **exit 0**
(fail-soft backstop — never blocks the prompt; note this differs from `stop.js`, which exits 1
on crash because Stop is fail-closed).

**No session_id validation.** P2 needs no `sid` (writes no per-session state), so `NO_SESSION`
is not a special case — principles inject regardless of `session_id` presence/validity.

### 4.2 Injected text (English — model-facing instruction, per repo convention)

Healthy `additionalContext` (exact wording finalized in the plan; intent fixed here):

```
[EGHS] Working agreement for this session:
- Before modifying an existing file, Read it first.
- If a file changed out-of-band (e.g. via Bash), Read it again before editing.
- Before ending your turn, ensure the configured verification (typecheck/lint/tests) passes.
```

Fail-soft (schema unhealthy) `additionalContext`:

```
[EGHS] state not initialized — run `node hooks/init.js` to enable verification gating.
```

### 4.3 Files

| File | Purpose |
|------|---------|
| `hooks/lib/ci.js` | `isCI(env): boolean` — the 4 CI env vars. New, reusable by P3/P4 hooks. |
| `hooks/lib/prompt-discipline.js` | Text constants (`DISCIPLINE_PRINCIPLES`, `INIT_GUIDANCE`) + `buildAdditionalContext(text): string` returning the `hookSpecificOutput` JSON envelope. Keeps all model-facing text in one isolated, unit-testable module. |
| `hooks/user-prompt-submit.js` | Entrypoint: stdin read, precedence walk, stdout emit. |
| `.claude/settings.json` | Register the `UserPromptSubmit` hook. |
| `README.md` | Note P2 is implemented. |

Reused from P1 unchanged: `lib/state-dir` (`resolveStateDir`), `lib/schema`
(`readSchemaVersion`), `lib/kill-switch` (`checkKillSwitch`). **Not** used: `config`, `git`,
`lock`, `session`, `baseline`, `verify`, `atomic-write`, `exclusive-link`, `debug-log`.

## 5. Testing

- `tests/ci.test.js` — `isCI` true for each of the 4 vars, false otherwise.
- `tests/prompt-discipline.test.js` — envelope shape (`hookSpecificOutput.hookEventName ===
  "UserPromptSubmit"`, `additionalContext` carries the text); principles contain the 3 §R1 rules.
- `tests/user-prompt-submit.test.js` (end-to-end via `execFileSync` + stdin):
  - healthy schema ⇒ stdout JSON `additionalContext` contains all 3 principles, exit 0.
  - kill switch (file) ⇒ empty stdout, exit 0, stderr has kill-switch line.
  - kill switch (`EGHS_DISABLED=1`) ⇒ empty stdout, exit 0.
  - CI (`CI=1`) ⇒ empty stdout, exit 0.
  - schema `not_initialized` ⇒ `additionalContext` = init guidance one-liner, exit 0.
  - schema `invalid` ⇒ init guidance one-liner, exit 0.
  - malformed stdin + healthy schema ⇒ principles injected, exit 0 (best-effort parse).
  - missing/invalid `session_id` + healthy schema ⇒ principles injected, exit 0.

## 6. Review / delivery

P2 is one small unit. Implement, then run one review checkpoint (`/code-review` senior +
Codex agent on the P2 diff), fix all Critical/Major, re-run `node --test tests/`, and do a
manual smoke (`echo '{...}' | node hooks/user-prompt-submit.js`) — matching P1's per-unit
review discipline.

## 7. Out of scope (explicit)

- **`migrate.lock` handling.** Nothing writes `migrate.lock` in P1/P2 (no `eghs-migrate` CLI
  exists), so — matching `stop.js`'s P1 scope-cut — P2 does not stat it. When migration lands
  in a later phase, that phase adds `migrate.lock` handling (the PRD §R6 "migrate in progress"
  one-liner for UserPromptSubmit) to all hooks together.
- **Zero-commit git repo edge case** (found in P1 smoke testing): a freshly `git init`'d repo
  with no commits makes the *Stop* hook's `git diff HEAD` fail and block with a confusing
  `INFRA_NOT_READY`. This is a **P1/Stop concern, orthogonal to P2** (UserPromptSubmit touches
  no git). Tracked as a known P1 limitation to fix separately; not addressed here.
- No config surface (Approach C), no state writes / debug log (Approach B), no per-session
  lease/lock, no `PostToolUse`/`Read`/`Edit` gates (those are P3/P4).
