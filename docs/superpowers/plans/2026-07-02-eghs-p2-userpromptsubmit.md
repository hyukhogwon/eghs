# EGHS P2 — UserPromptSubmit Prompt-Discipline Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the EGHS `UserPromptSubmit` hook so that, at the start of every user turn, the model receives the PRD §R1 prompt-discipline principles as injected context — a fail-soft *nudge* toward the Read-before-Edit / verify-before-Stop flow that P3/P4 will later enforce (matches PRD §6 Phase P2, exit criteria "모델이 Read/verify 흐름을 따르는지 정성 확인").

**Architecture:** A single synchronous Node.js CLI (`hooks/user-prompt-submit.js`) invoked by Claude Code's `UserPromptSubmit` event via stdin JSON. It walks a short **fail-soft** precedence chain (kill switch → CI passthrough → schema stat) and writes at most one `hookSpecificOutput` JSON line to stdout, always exiting 0. It reads disk only via stat/read (reuses P1's `state-dir`, `schema`, `kill-switch` unchanged) and **writes nothing**. Two new tiny libs — `ci.js` (CI env detection) and `prompt-discipline.js` (the model-facing text + JSON envelope) — isolate the only two pieces of P2-specific logic.

**Tech Stack:** plain Node.js (CommonJS, no build step — fast cold start), Node built-in `node:test` + `node:assert`, `child_process` for end-to-end tests. No new dependencies (P2 does not use `git`, `picomatch`, or any state-write primitive).

## Global Constraints

* Language: plain Node.js CommonJS (`require`/`module.exports`), no TypeScript build step.
* **Fail-soft is absolute:** the `UserPromptSubmit` hook exit code is **always `0`**, on every branch including crashes. Exit `2` erases the user's prompt and MUST never be emitted; any other non-zero would surface a stderr line in the transcript — also avoided. A top-level `try/catch` forces `process.exitCode = 0` on any throw.
* **stdout carries only** the injection payload — either the `hookSpecificOutput` JSON, or nothing. All debug/error text goes to **stderr**. stdout pollution corrupts model input (PRD §R1 output rule).
* Injection envelope (Claude Code `UserPromptSubmit`, verified 2026-07-02): `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"<text>"}}` on stdout + exit 0 ⇒ injected as a system reminder (invisible in chat).
* Repo root resolution: `process.env.CLAUDE_PROJECT_DIR || process.cwd()`. Claude Code always sets `CLAUDE_PROJECT_DIR` to the project root when running hooks; P2 deliberately does **not** shell out to `git` (avoids the P1 zero-commit edge and keeps cold start minimal). A wrong root is harmless — it just yields the fail-soft init-guidance nudge.
* **CI passthrough APPLIES to `UserPromptSubmit`** (PRD §6 line 688) — opposite of Stop. `CI=true` or `CI=1`, or `GITHUB_ACTIONS=true`/`GITLAB_CI=true`/`BUILDKITE=true` ⇒ inject nothing, exit 0.
* Precedence order (all branches exit 0): parse stdin (best-effort, drained then ignored — P2 uses no input field) → kill switch (inject nothing) → CI (inject nothing) → schema stat (`not_initialized`/`invalid` ⇒ init-guidance one-liner) → healthy (inject principles).
* Injected principle text is **English** — the model reads it as instruction (repo convention: agent-facing text is English).
* **P2 scope cut (explicit, YAGNI):** no config surface (kill switch is the only off-switch), no state writes / debug log, no per-session lease/lock/baseline, no `git`, no `migrate.lock` handling (nothing writes it in P1/P2 — matches `stop.js`'s scope cut; deferred to whichever phase lands `eghs-migrate`), no `Read`/`Edit`/`PostToolUse` gates (P3/P4). The P1 zero-commit git-repo edge is a Stop-hook concern, orthogonal to P2, tracked separately.
* `readStdin` is duplicated verbatim from `hooks/stop.js` (a private helper there). Duplication is intentional: extracting a shared lib would require modifying working P1 code, which is out of scope. Defer the extraction until a third consumer (P3) exists and all call sites can be updated together.
* Reused from P1 **unchanged**: `hooks/lib/state-dir.js` (`resolveStateDir`), `hooks/lib/schema.js` (`readSchemaVersion`), `hooks/lib/kill-switch.js` (`checkKillSwitch`). Do not edit these files.

---

## File Structure

```
hooks/
  lib/
    ci.js                  # NEW: isCI(env) — CI passthrough detection
    prompt-discipline.js   # NEW: DISCIPLINE_PRINCIPLES, INIT_GUIDANCE, buildAdditionalContext()
  user-prompt-submit.js    # NEW: UserPromptSubmit hook entrypoint
tests/
  ci.test.js               # NEW
  prompt-discipline.test.js# NEW
  user-prompt-submit.test.js # NEW: end-to-end via child_process
.claude/settings.json      # MODIFY: register the UserPromptSubmit hook
README.md                  # MODIFY: note P2 implemented
```

P2 is a single review unit (Tasks 1–4). After Task 4, run one review checkpoint (`/code-review` senior + a Codex review agent on the P2 diff), fix all Critical/Major, re-run `npm test`, and run the Task 4 smoke test — matching P1's per-unit review discipline.

---

## Task 1: CI passthrough detection (`hooks/lib/ci.js`)

**Files:**
- Create: `hooks/lib/ci.js`
- Test: `tests/ci.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `isCI(env: NodeJS.ProcessEnv): boolean` — used by Task 3.

- [ ] **Step 1: Write the failing test**

```js
// tests/ci.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isCI } = require('../hooks/lib/ci');

test('isCI is false for an empty env', () => {
  assert.equal(isCI({}), false);
});

test('isCI is true for CI=true and CI=1', () => {
  assert.equal(isCI({ CI: 'true' }), true);
  assert.equal(isCI({ CI: '1' }), true);
});

test('isCI is false for CI=false or CI=0 (not a truthy CI marker)', () => {
  assert.equal(isCI({ CI: 'false' }), false);
  assert.equal(isCI({ CI: '0' }), false);
});

test('isCI is true for each vendor flag set to "true"', () => {
  assert.equal(isCI({ GITHUB_ACTIONS: 'true' }), true);
  assert.equal(isCI({ GITLAB_CI: 'true' }), true);
  assert.equal(isCI({ BUILDKITE: 'true' }), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/ci.test.js`
Expected: FAIL — `Cannot find module '../hooks/lib/ci'`.

- [ ] **Step 3: Write `hooks/lib/ci.js`**

```js
'use strict';

// CI passthrough (PRD §6). UserPromptSubmit honors these (unlike the Stop hook,
// which enforces verification even in CI). CI accepts "true" or "1"; the vendor
// flags are only ever the string "true".
function isCI(env) {
  return (
    env.CI === 'true' ||
    env.CI === '1' ||
    env.GITHUB_ACTIONS === 'true' ||
    env.GITLAB_CI === 'true' ||
    env.BUILDKITE === 'true'
  );
}

module.exports = { isCI };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/ci.test.js`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add hooks/lib/ci.js tests/ci.test.js
git commit -m "feat: add CI passthrough detection for UserPromptSubmit"
```

---

## Task 2: Prompt-discipline text + injection envelope (`hooks/lib/prompt-discipline.js`)

**Files:**
- Create: `hooks/lib/prompt-discipline.js`
- Test: `tests/prompt-discipline.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `DISCIPLINE_PRINCIPLES: string` — the §R1 working agreement (multi-line).
  - `INIT_GUIDANCE: string` — the fail-soft one-liner shown when state is not initialized.
  - `buildAdditionalContext(text: string): string` — returns the `hookSpecificOutput` JSON string. Used by Task 3.

- [ ] **Step 1: Write the failing test**

```js
// tests/prompt-discipline.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DISCIPLINE_PRINCIPLES,
  INIT_GUIDANCE,
  buildAdditionalContext,
} = require('../hooks/lib/prompt-discipline');

test('DISCIPLINE_PRINCIPLES states all three R1 rules', () => {
  assert.match(DISCIPLINE_PRINCIPLES, /Read it first/);
  assert.match(DISCIPLINE_PRINCIPLES, /out-of-band/);
  assert.match(DISCIPLINE_PRINCIPLES, /verification/);
});

test('INIT_GUIDANCE points at the init command', () => {
  assert.match(INIT_GUIDANCE, /hooks\/init\.js/);
});

test('buildAdditionalContext wraps text in the UserPromptSubmit envelope', () => {
  const parsed = JSON.parse(buildAdditionalContext('hello'));
  assert.deepEqual(parsed, {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: 'hello',
    },
  });
});

test('buildAdditionalContext round-trips multi-line principle text intact', () => {
  const parsed = JSON.parse(buildAdditionalContext(DISCIPLINE_PRINCIPLES));
  assert.equal(parsed.hookSpecificOutput.additionalContext, DISCIPLINE_PRINCIPLES);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/prompt-discipline.test.js`
Expected: FAIL — `Cannot find module '../hooks/lib/prompt-discipline'`.

- [ ] **Step 3: Write `hooks/lib/prompt-discipline.js`**

```js
'use strict';

// Model-facing working agreement (PRD §R1). English on purpose: the model reads
// this as instruction. Injected via UserPromptSubmit as additionalContext.
const DISCIPLINE_PRINCIPLES = [
  '[EGHS] Working agreement for this session:',
  '- Before modifying an existing file, Read it first.',
  '- If a file changed out-of-band (e.g. via Bash), Read it again before editing.',
  '- Before ending your turn, ensure the configured verification (typecheck/lint/tests) passes.',
].join('\n');

// Fail-soft nudge when EGHS state is not initialized (PRD §R6 UserPromptSubmit row).
const INIT_GUIDANCE =
  '[EGHS] state not initialized — run `node hooks/init.js` to enable verification gating.';

// hookSpecificOutput envelope; Claude Code injects additionalContext as a system
// reminder on exit 0 (verified 2026-07-02).
function buildAdditionalContext(text) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: text,
    },
  });
}

module.exports = { DISCIPLINE_PRINCIPLES, INIT_GUIDANCE, buildAdditionalContext };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/prompt-discipline.test.js`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add hooks/lib/prompt-discipline.js tests/prompt-discipline.test.js
git commit -m "feat: add prompt-discipline text and additionalContext envelope"
```

---

## Task 3: UserPromptSubmit hook entrypoint (`hooks/user-prompt-submit.js`)

**Files:**
- Create: `hooks/user-prompt-submit.js`
- Test: `tests/user-prompt-submit.test.js`

**Interfaces:**
- Consumes: `resolveStateDir` (state-dir), `readSchemaVersion` (schema), `checkKillSwitch` (kill-switch), `isCI` (Task 1), `DISCIPLINE_PRINCIPLES`/`INIT_GUIDANCE`/`buildAdditionalContext` (Task 2).
- Produces: an executable hook. No exported API consumed by later tasks (Task 4 only wires the command string).

- [ ] **Step 1: Write the failing end-to-end test**

```js
// tests/user-prompt-submit.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'hooks', 'user-prompt-submit.js');
const INIT = path.join(__dirname, '..', 'hooks', 'init.js');

function mkRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-ups-'));
}

function initRepo(repo) {
  // init.js falls back to cwd when not a git repo, so cwd must be the repo root.
  execFileSync('node', [INIT], { cwd: repo, encoding: 'utf8' });
}

// Neutralize host CI / kill-switch env so tests are deterministic on developer
// machines AND inside CI. rawInput lets a test send deliberately malformed JSON.
function run(repo, { input = {}, env = {}, rawInput } = {}) {
  const res = spawnSync('node', [HOOK], {
    input: rawInput !== undefined ? rawInput : JSON.stringify(input),
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: repo,
      CI: '',
      GITHUB_ACTIONS: '',
      GITLAB_CI: '',
      BUILDKITE: '',
      EGHS_DISABLED: '',
      ...env,
    },
  });
  return { stdout: res.stdout, stderr: res.stderr, code: res.status };
}

const SID = '11111111-1111-4111-8111-111111111111';

test('healthy state injects all three principles as additionalContext, exit 0', () => {
  const repo = mkRepo();
  initRepo(repo);
  const { stdout, code } = run(repo, { input: { session_id: SID, user_input: 'hi' } });
  assert.equal(code, 0);
  const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /Read it first/);
  assert.match(ctx, /out-of-band/);
  assert.match(ctx, /verification/);
});

test('kill switch file suppresses injection, exit 0', () => {
  const repo = mkRepo();
  initRepo(repo);
  fs.writeFileSync(path.join(repo, '.claude', 'eghs-off'), '');
  const { stdout, stderr, code } = run(repo, { input: { session_id: SID } });
  assert.equal(code, 0);
  assert.equal(stdout, '');
  assert.match(stderr, /kill-switch active/);
});

test('kill switch env (EGHS_DISABLED=1) suppresses injection, exit 0', () => {
  const repo = mkRepo();
  initRepo(repo);
  const { stdout, code } = run(repo, { input: { session_id: SID }, env: { EGHS_DISABLED: '1' } });
  assert.equal(code, 0);
  assert.equal(stdout, '');
});

test('CI passthrough (CI=1) suppresses injection, exit 0', () => {
  const repo = mkRepo();
  initRepo(repo);
  const { stdout, code } = run(repo, { input: { session_id: SID }, env: { CI: '1' } });
  assert.equal(code, 0);
  assert.equal(stdout, '');
});

test('uninitialized state injects the init-guidance one-liner, exit 0', () => {
  const repo = mkRepo(); // no initRepo()
  const { stdout, code } = run(repo, { input: { session_id: SID } });
  assert.equal(code, 0);
  const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /not initialized/);
  assert.match(ctx, /hooks\/init\.js/);
});

test('invalid schema_version injects the init-guidance one-liner, exit 0', () => {
  const repo = mkRepo();
  initRepo(repo);
  fs.writeFileSync(path.join(repo, '.claude', 'state', 'eghs', 'schema_version'), '01\n');
  const { stdout, code } = run(repo, { input: { session_id: SID } });
  assert.equal(code, 0);
  assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /not initialized/);
});

test('malformed stdin still injects principles (best-effort parse), exit 0', () => {
  const repo = mkRepo();
  initRepo(repo);
  const { stdout, code } = run(repo, { rawInput: '{ not json' });
  assert.equal(code, 0);
  assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /Read it first/);
});

test('missing session_id still injects principles (P2 needs no sid), exit 0', () => {
  const repo = mkRepo();
  initRepo(repo);
  const { stdout, code } = run(repo, { input: {} });
  assert.equal(code, 0);
  assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /Read it first/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/user-prompt-submit.test.js`
Expected: FAIL — `Cannot find module` / hook file missing.

- [ ] **Step 3: Write `hooks/user-prompt-submit.js`**

```js
#!/usr/bin/env node
'use strict';
const fs = require('fs');
const { resolveStateDir } = require('./lib/state-dir');
const { readSchemaVersion } = require('./lib/schema');
const { checkKillSwitch } = require('./lib/kill-switch');
const { isCI } = require('./lib/ci');
const {
  DISCIPLINE_PRINCIPLES,
  INIT_GUIDANCE,
  buildAdditionalContext,
} = require('./lib/prompt-discipline');

// Duplicated from hooks/stop.js on purpose — see plan Global Constraints.
function readStdin() {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  while (true) {
    let bytesRead;
    try {
      bytesRead = fs.readSync(0, buf, 0, buf.length, null);
    } catch (err) {
      if (err.code === 'EAGAIN') continue;
      if (err.code === 'EOF') break;
      throw err;
    }
    if (bytesRead === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Emit additionalContext (or nothing) and exit 0. UserPromptSubmit is fail-soft:
// the exit code is ALWAYS 0 — a non-zero (2) exit would erase the user's prompt.
// Use process.exitCode (not process.exit) so the stdout write flushes on a pipe.
function emitContext(text) {
  if (text) process.stdout.write(buildAdditionalContext(text));
  process.exitCode = 0;
}

function main() {
  // Drain stdin so the writer never sees a broken pipe. P2 uses no input field,
  // and the principles are input-independent, so parse failure is irrelevant.
  try {
    readStdin();
  } catch {
    // ignore — fall through to injection
  }

  const repoRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // Kill switch: EGHS fully off -> inject nothing.
  const killSwitch = checkKillSwitch({ repoRoot, env: process.env });
  if (killSwitch.active) {
    process.stderr.write(`[eghs] kill-switch active: ${killSwitch.reason}\n`);
    emitContext(null);
    return;
  }

  // CI: no interactive model to nudge (PRD §6) -> inject nothing.
  if (isCI(process.env)) {
    emitContext(null);
    return;
  }

  // Schema stat (fail-soft): not initialized / corrupt -> one-line init nudge.
  const schema = readSchemaVersion(resolveStateDir(repoRoot));
  if (schema.status !== 'ok') {
    process.stderr.write(`[eghs] state ${schema.status}; injecting init guidance\n`);
    emitContext(INIT_GUIDANCE);
    return;
  }

  emitContext(DISCIPLINE_PRINCIPLES);
}

// Fail-soft backstop: a crash must never block the prompt (exit 0, not 1).
try {
  main();
} catch (err) {
  process.stderr.write(
    `[eghs] user-prompt-submit hook error (fail-soft): ${err.stack || err.message}\n`
  );
  process.exitCode = 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/user-prompt-submit.test.js`
Expected: PASS (8/8).

- [ ] **Step 5: Run the whole suite (no regressions in P1)**

Run: `npm test`
Expected: PASS (P1's 96 tests + P2's 16 = 112).

- [ ] **Step 6: Commit**

```bash
git add hooks/user-prompt-submit.js tests/user-prompt-submit.test.js
git commit -m "feat: add UserPromptSubmit prompt-discipline injection hook"
```

---

## Task 4: Wire the hook into Claude Code settings + README + smoke test

**Files:**
- Modify: `.claude/settings.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: `hooks/user-prompt-submit.js` (Task 3).
- Produces: a registered `UserPromptSubmit` hook.

- [ ] **Step 1: Add the UserPromptSubmit hook to `.claude/settings.json`**

The current file registers only `Stop`. Add a sibling `UserPromptSubmit` key so the object reads:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/hooks/stop.js\""
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/hooks/user-prompt-submit.js\""
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 2: Update `README.md`**

Change the "Currently implemented" line to also list P2:

```markdown
Currently implemented: **P1 — Stop hook** (typecheck/lint/test verification gate)
and **P2 — UserPromptSubmit** (fail-soft prompt-discipline injection).
```

- [ ] **Step 3: Manual smoke test**

Run all of the following from the repo root (`R=$PWD` captures it; `init.js` resolves
its target from `git`-toplevel-or-cwd, **not** `CLAUDE_PROJECT_DIR`, so the scratch dir must
be initialized from *inside* it):

```bash
R=$PWD; D=$(mktemp -d)
# 1) before init -> init-guidance one-liner, exit 0
printf '{"session_id":"11111111-1111-4111-8111-111111111111","user_input":"hi"}' \
  | CLAUDE_PROJECT_DIR="$D" node hooks/user-prompt-submit.js; echo " exit=$?"
# 2) initialize the scratch dir (non-git -> init.js falls back to its own cwd = $D)
( cd "$D" && node "$R/hooks/init.js" ) >/dev/null
# 3) after init -> three principles, exit 0
printf '{"session_id":"11111111-1111-4111-8111-111111111111","user_input":"hi"}' \
  | CLAUDE_PROJECT_DIR="$D" node hooks/user-prompt-submit.js; echo " exit=$?"
rm -rf "$D"
```
Expected: line 1 prints JSON whose `additionalContext` starts `[EGHS] state not initialized`
then ` exit=0`; line 3 prints JSON whose `additionalContext` contains the three principles
then ` exit=0`.

- [ ] **Step 4: Commit**

```bash
git add .claude/settings.json README.md
git commit -m "chore: register UserPromptSubmit hook, note P2 in README"
```

---

**— P2 (UserPromptSubmit) checkpoint —** After Task 4, run `/code-review` (senior review) and dispatch a Codex review agent against the full P2 diff (Tasks 1–4). Fix all Critical/Major findings, re-run `npm test`, and re-run the Task 4 smoke test. Then P2 is done and the rollout can advance to P3.

---

## Self-Review Notes

* **Spec coverage:**
  - §R1 principle injection ✅ Task 2 (`DISCIPLINE_PRINCIPLES` + envelope) + Task 3 (healthy path).
  - §R1 fail-soft "never blocks input" ✅ Global Constraints (always exit 0) + Task 3 backstop `try/catch`.
  - §R1 stdout/stderr separation ✅ Task 3 (`emitContext` → stdout only; all diagnostics → stderr).
  - Output contract (JSON `hookSpecificOutput.additionalContext`, exit 0) ✅ Task 2 `buildAdditionalContext` + Task 3.
  - §R6 kill-switch precedence ✅ Task 3 (checked first, inject nothing).
  - §R6 fail-soft on unhealthy schema → 1-line guidance ✅ Task 3 (`schema.status !== 'ok'` branch) + Task 3 test cases (not_initialized, invalid).
  - §6 CI passthrough for UserPromptSubmit ✅ Task 1 (`isCI`) + Task 3 (CI branch) + test.
  - Design §4.3 file table ✅ Tasks 1–4 (`ci.js`, `prompt-discipline.js`, `user-prompt-submit.js`, settings, README).
  - Design §7 out-of-scope (migrate.lock, zero-commit edge, config, state writes) ✅ honored — none implemented; recorded in Global Constraints.
* **Placeholder scan:** no TBD/TODO; every code step shows complete code; every command shows expected output.
* **Type consistency:** `buildAdditionalContext(text)` (Task 2) is called with `INIT_GUIDANCE`/`DISCIPLINE_PRINCIPLES` and returns a JSON string parsed by tests as `{hookSpecificOutput:{hookEventName, additionalContext}}` — consistent across Tasks 2 and 3. `isCI(env)` (Task 1) is called as `isCI(process.env)` (Task 3). `checkKillSwitch({repoRoot, env})` / `readSchemaVersion(stateDir)` / `resolveStateDir(repoRoot)` match the P1 signatures verified against source (kill-switch returns `{active, reason}`; schema returns `{status, version?}`).
* **Test hygiene note:** the e2e `run()` helper blanks `CI`/`GITHUB_ACTIONS`/`GITLAB_CI`/`BUILDKITE`/`EGHS_DISABLED` so a developer's (or CI's) ambient env cannot flip the CI/kill-switch branches and make tests non-deterministic. This is why the "healthy" tests reliably reach the injection branch even when the suite itself runs under GitHub Actions.
* **Crash-path coverage gap (accepted):** the top-level `try/catch` backstop is not exercised by an automated test — with `readStdin`/`checkKillSwitch`/`readSchemaVersion` all guarded, no reachable input throws. Verified by code review only; a synthetic fault-injection test would add machinery disproportionate to a 3-line backstop. Recorded here so the reviewer does not flag it as missing coverage.
