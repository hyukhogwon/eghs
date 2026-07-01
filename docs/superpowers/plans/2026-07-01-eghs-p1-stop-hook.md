# EGHS P1 — Stop Hook (typecheck/lint verification) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the EGHS `Stop` hook so that a Claude Code session cannot end with failing typecheck/lint (or configured verification commands) — matching PRD.md Rollout Plan Phase P1 ("Stop hook, typecheck/lint only", exit criteria "Stop block 후 self-correct 가능").

**Architecture:** Single Node.js CLI script (`hooks/stop.js`) invoked by Claude Code's `Stop` hook via stdin JSON / stdout JSON + exit code. It walks a subset of PRD §R6 precedence (schema check, kill switch, migrate-lock stub, session lease + baseline, recursion lock) then runs configured verification commands per PRD §R5 and reports block/allow. State is persisted under `.claude/state/eghs/` using the atomic-write and exclusive-link primitives defined in PRD §R2.5. A companion `hooks/init.js` (`eghs-init`) bootstraps the state directory.

**Tech Stack:** Node.js (CommonJS, no build step — hooks must start fast), `picomatch` for gitignore-style glob matching, Node built-in `node:test` + `node:assert` for tests, `git` CLI via `child_process.execFileSync`.

## Global Constraints

* Language: plain Node.js CommonJS (`require`/`module.exports`), no TypeScript build step for hook scripts (fast cold start).
* `schema_version` file format: strict regex `^[1-9][0-9]*\n$`, max 32 bytes (PRD §R2.5).
* Atomic JSON/text state write = destination-local `tmp/<basename>.<pid>.<seq>` + `fsync(fd)` + `rename(2)` to final path + `fsync(dirfd)` of the parent dir. `seq` is a per-process monotonic counter (PRD §R2.5).
* Exclusive create (locks, baseline anchor) = write to `tmp/`, `fsync`, then `link(2)` to the final path (EEXIST = already held), then unlink the tmp source (PRD §R2.5 / §R6 6.3a).
* `sid` must match `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` (PRD §R2.5 "sid 형식 규약"). Hook input without a valid `session_id` is the `NO_SESSION` signal.
* Kill switch: `.claude/eghs-off` (regular file, or symlink resolving to a regular file) OR `EGHS_DISABLED=1` env ⇒ exit 0 immediately, no state writes, stderr line `[eghs] kill-switch active: <reason>` (PRD §R6).
* CI passthrough (`CI=true/1`, `GITHUB_ACTIONS=true`, `GITLAB_CI=true`, `BUILDKITE=true`) does **not** apply to `Stop` (PRD §R6 — G3 must hold in CI too).
* Recursion guard: `STOP_HOOK_ACTIVE=1` env **or** hook input `stop_hook_active: true` ⇒ exit 0 immediately (PRD §R5 "Recursion 방지"; the input field is Claude Code's native equivalent, included for real-world compatibility).
* Exit code enum: `0` = allow/skip/kill-switch, `2` = block, anything else = hook crash (PRD §8 MVP item 7).
* stdout carries **only** the decision JSON `{ "decision": "allow"|"block", "deny_code": "...|null", "reason": "...|null", "extra": {...} }`; all debug/error text goes to stderr (PRD §R1 stdout/stderr separation applied uniformly).
* Config defaults (PRD §R5): `verification_timeout_seconds=45`, `verification_parallel=true`, `verification_cwd=<repo_root>`, `verification_shell=["/bin/sh","-c"]`, `matcher_engine="picomatch"`, `diff_base="session_baseline"`.
* Lock/lease defaults (PRD §R2.5): stop-lock recovery `grace_ms=5000`; `recovery_grace_ms=60000`; `session_stale_seconds=86400`; `verify_logs_stale_seconds=604800` (7 days).
* **P1 scope cut (explicit, YAGNI):** no `Read`/`Edit` gate (R2/R3/R4), no `fs-info.json` case-sensitivity probe, no `eghs-migrate` CLI. `migrate.lock` is only ever *checked* (stat), never written, in P1 — so its stale-recovery grace logic is out of scope; presence alone ⇒ `INFRA_NOT_READY` block. State subdirs created by `eghs-init` are limited to what `Stop` touches: `tmp/`, `locks/`, `locks/tmp/`, `sessions/`, `sessions/tmp/`, `baselines/`, `baselines/tmp/`, `verify-logs/`, `debug/`. `reads/`, `failed/`, `pre/` are deferred to the P3 plan.
* Per PRD §R6 precedence #7, `Stop` treats `MISMATCH` and `FS_INFO_MISSING` identically to the healthy case (proceeds to verification) — only `NOT_INITIALIZED`/`INVALID` block. Since P1 never writes `fs-info.json`, disk state always classifies as `FS_INFO_MISSING`; this is intentional and harmless for `Stop`.

---

## File Structure

```
hooks/
  lib/
    state-dir.js      # dir-name constants + ensureDir helpers
    atomic-write.js    # atomicWriteFile()
    exclusive-link.js   # exclusiveLinkCreate()
    schema.js            # readSchemaVersion() (precedence #1), HOOK_SCHEMA_VERSION
    kill-switch.js         # checkKillSwitch()
    config.js               # loadConfig()
    git.js                    # getRepoRoot(), getHeadCommit(), getChangedFiles()
    lock.js                    # acquireStopLock() / releaseStopLock()
    session.js                  # ensureSessionLease(), gcSessions()
    baseline.js                  # ensureBaseline()
    verify.js                     # runVerification()
    debug-log.js                   # appendDebugLog()
  init.js                            # eghs-init CLI entrypoint
  stop.js                              # Stop hook entrypoint
tests/
  atomic-write.test.js
  exclusive-link.test.js
  schema.test.js
  kill-switch.test.js
  config.test.js
  git.test.js
  lock.test.js
  session.test.js
  baseline.test.js
  verify.test.js
  init.test.js
  stop.test.js          # end-to-end
```

Review batching (per user request — review by feature unit, senior + Codex review each, fix all Critical/Major before moving on):

* **Unit 1 — Foundation:** Tasks 1-5 (`state-dir`, `atomic-write`, `exclusive-link`, `schema`, `kill-switch`, `config`, `git`, `eghs-init`).
* **Unit 2 — Concurrency & Lease:** Tasks 6-8 (`lock`, `session`, `baseline`).
* **Unit 3 — Verification & Entrypoint:** Tasks 9-11 (`verify`, `debug-log`, `stop.js` + end-to-end tests).

---

## Task 1: State dir constants + atomic write primitive

**Files:**
- Create: `hooks/lib/state-dir.js`
- Create: `hooks/lib/atomic-write.js`
- Test: `tests/atomic-write.test.js`

**Interfaces:**
- Produces: `STATE_DIRNAME = '.claude/state/eghs'`, `resolveStateDir(repoRoot: string): string`, `P1_SUBDIRS: string[]` (relative dir names `eghs-init` must create), `atomicWriteFile(destPath: string, contents: string|Buffer): void`.

- [ ] **Step 1: Write `hooks/lib/state-dir.js`**

```js
'use strict';
const path = require('path');

const STATE_DIRNAME = path.join('.claude', 'state', 'eghs');

function resolveStateDir(repoRoot) {
  return path.join(repoRoot, STATE_DIRNAME);
}

// Subdirs Stop hook needs in P1. reads/, failed/, pre/ are P3 scope.
const P1_SUBDIRS = [
  'tmp',
  'locks', path.join('locks', 'tmp'),
  'sessions', path.join('sessions', 'tmp'),
  'baselines', path.join('baselines', 'tmp'),
  'verify-logs',
  'debug',
];

module.exports = { STATE_DIRNAME, resolveStateDir, P1_SUBDIRS };
```

- [ ] **Step 2: Write the failing test for atomic write**

```js
// tests/atomic-write.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { atomicWriteFile } = require('../hooks/lib/atomic-write');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-atomic-'));
}

test('atomicWriteFile creates the destination file with exact contents', () => {
  const dir = mkTmpDir();
  const dest = path.join(dir, 'sub', 'schema_version');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  atomicWriteFile(dest, '1\n');
  assert.equal(fs.readFileSync(dest, 'utf8'), '1\n');
});

test('atomicWriteFile leaves no leftover tmp files after success', () => {
  const dir = mkTmpDir();
  const dest = path.join(dir, 'schema_version');
  atomicWriteFile(dest, '1\n');
  const tmpDir = path.join(dir, 'tmp');
  assert.ok(!fs.existsSync(tmpDir) || fs.readdirSync(tmpDir).length === 0);
});

test('atomicWriteFile overwrites an existing file atomically', () => {
  const dir = mkTmpDir();
  const dest = path.join(dir, 'schema_version');
  atomicWriteFile(dest, '1\n');
  atomicWriteFile(dest, '2\n');
  assert.equal(fs.readFileSync(dest, 'utf8'), '2\n');
});

test('atomicWriteFile uses a fresh tmp filename per call (monotonic seq)', () => {
  const dir = mkTmpDir();
  atomicWriteFile(path.join(dir, 'a.json'), '{}');
  atomicWriteFile(path.join(dir, 'b.json'), '{}');
  // No crash / collision even though both calls happen within the same ms.
  assert.equal(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'), '{}');
  assert.equal(fs.readFileSync(path.join(dir, 'b.json'), 'utf8'), '{}');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/atomic-write.test.js`
Expected: FAIL with `Cannot find module '../hooks/lib/atomic-write'`

- [ ] **Step 4: Write `hooks/lib/atomic-write.js`**

```js
'use strict';
const fs = require('fs');
const path = require('path');

let seqCounter = 0;
function nextSeq() {
  seqCounter += 1;
  return seqCounter;
}

// destination-local temp + fsync(fd) + rename(2) + fsync(dirfd) — PRD §R2.5
function atomicWriteFile(destPath, contents) {
  const destDir = path.dirname(destPath);
  const tmpDir = path.join(destDir, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  const tmpPath = path.join(
    tmpDir,
    `${path.basename(destPath)}.${process.pid}.${nextSeq()}`
  );

  const fd = fs.openSync(tmpPath, 'w', 0o600);
  try {
    fs.writeSync(fd, contents);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  fs.renameSync(tmpPath, destPath);

  const dirFd = fs.openSync(destDir, 'r');
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
}

module.exports = { atomicWriteFile };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/atomic-write.test.js`
Expected: PASS (4/4)

- [ ] **Step 6: Commit**

```bash
git add hooks/lib/state-dir.js hooks/lib/atomic-write.js tests/atomic-write.test.js
git commit -m "feat: add eghs state-dir constants and atomic write primitive"
```

---

## Task 2: Exclusive-create primitive (link(2)-based)

**Files:**
- Create: `hooks/lib/exclusive-link.js`
- Test: `tests/exclusive-link.test.js`

**Interfaces:**
- Consumes: nothing beyond Node `fs`.
- Produces: `exclusiveLinkCreate(destPath: string, contents: string): { ok: true } | { ok: false, code: 'EEXIST' }` — used by Task 6 (lock) and Task 8 (baseline).

- [ ] **Step 1: Write the failing test**

```js
// tests/exclusive-link.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exclusiveLinkCreate } = require('../hooks/lib/exclusive-link');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-link-'));
}

test('exclusiveLinkCreate creates the file when absent', () => {
  const dir = mkTmpDir();
  const dest = path.join(dir, 'lock.json');
  const result = exclusiveLinkCreate(dest, '{"pid":1}');
  assert.deepEqual(result, { ok: true });
  assert.equal(fs.readFileSync(dest, 'utf8'), '{"pid":1}');
});

test('exclusiveLinkCreate returns ok:false EEXIST when already present, without overwriting', () => {
  const dir = mkTmpDir();
  const dest = path.join(dir, 'lock.json');
  exclusiveLinkCreate(dest, '{"pid":1}');
  const second = exclusiveLinkCreate(dest, '{"pid":2}');
  assert.deepEqual(second, { ok: false, code: 'EEXIST' });
  assert.equal(fs.readFileSync(dest, 'utf8'), '{"pid":1}');
});

test('exclusiveLinkCreate leaves no leftover tmp file after success or collision', () => {
  const dir = mkTmpDir();
  const dest = path.join(dir, 'lock.json');
  exclusiveLinkCreate(dest, '{"pid":1}');
  exclusiveLinkCreate(dest, '{"pid":2}');
  const tmpDir = path.join(dir, 'tmp');
  assert.ok(!fs.existsSync(tmpDir) || fs.readdirSync(tmpDir).length === 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/exclusive-link.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `hooks/lib/exclusive-link.js`**

```js
'use strict';
const fs = require('fs');
const path = require('path');

let seqCounter = 0;
function nextSeq() {
  seqCounter += 1;
  return seqCounter;
}

// write tmp + fsync, then link(2) to dest (EEXIST = someone else holds it),
// then unlink the tmp source. Never uses rename() — rename would silently
// overwrite and defeat the exclusivity guarantee. PRD §R2.5 / §R6 6.3a.
function exclusiveLinkCreate(destPath, contents) {
  const destDir = path.dirname(destPath);
  const tmpDir = path.join(destDir, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  const tmpPath = path.join(
    tmpDir,
    `${path.basename(destPath)}.${process.pid}.${nextSeq()}`
  );

  const fd = fs.openSync(tmpPath, 'w', 0o600);
  try {
    fs.writeSync(fd, contents);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  try {
    fs.linkSync(tmpPath, destPath);
  } catch (err) {
    fs.unlinkSync(tmpPath);
    if (err.code === 'EEXIST') {
      return { ok: false, code: 'EEXIST' };
    }
    throw err;
  }

  fs.unlinkSync(tmpPath);
  const dirFd = fs.openSync(destDir, 'r');
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
  return { ok: true };
}

module.exports = { exclusiveLinkCreate };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/exclusive-link.test.js`
Expected: PASS (3/3)

- [ ] **Step 5: Commit**

```bash
git add hooks/lib/exclusive-link.js tests/exclusive-link.test.js
git commit -m "feat: add link(2)-based exclusive-create primitive"
```

---

## Task 3: Schema version reader (precedence #1) + eghs-init CLI

**Files:**
- Create: `hooks/lib/schema.js`
- Create: `hooks/init.js`
- Test: `tests/schema.test.js`
- Test: `tests/init.test.js`

**Interfaces:**
- Produces: `HOOK_SCHEMA_VERSION = 1`, `readSchemaVersion(stateDir: string): { status: 'not_initialized' } | { status: 'invalid' } | { status: 'ok', version: number }`.
- `hooks/init.js` is a standalone CLI (`node hooks/init.js [--repair]`) — Task 11's `stop.js` does not import it directly, but tests invoke it via `execFileSync` to bootstrap fixture repos.

- [ ] **Step 1: Write the failing test for schema.js**

```js
// tests/schema.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readSchemaVersion } = require('../hooks/lib/schema');

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-schema-'));
}

test('readSchemaVersion: not_initialized when state dir is absent', () => {
  const dir = mkTmpDir();
  const result = readSchemaVersion(path.join(dir, 'does-not-exist'));
  assert.deepEqual(result, { status: 'not_initialized' });
});

test('readSchemaVersion: not_initialized when schema_version file is absent', () => {
  const dir = mkTmpDir();
  const result = readSchemaVersion(dir);
  assert.deepEqual(result, { status: 'not_initialized' });
});

test('readSchemaVersion: ok with parsed integer for a valid file', () => {
  const dir = mkTmpDir();
  fs.writeFileSync(path.join(dir, 'schema_version'), '1\n');
  assert.deepEqual(readSchemaVersion(dir), { status: 'ok', version: 1 });
});

test('readSchemaVersion: invalid on leading zero', () => {
  const dir = mkTmpDir();
  fs.writeFileSync(path.join(dir, 'schema_version'), '01\n');
  assert.deepEqual(readSchemaVersion(dir), { status: 'invalid' });
});

test('readSchemaVersion: invalid on missing trailing newline', () => {
  const dir = mkTmpDir();
  fs.writeFileSync(path.join(dir, 'schema_version'), '1');
  assert.deepEqual(readSchemaVersion(dir), { status: 'invalid' });
});

test('readSchemaVersion: invalid when file exceeds 32 bytes', () => {
  const dir = mkTmpDir();
  fs.writeFileSync(path.join(dir, 'schema_version'), '1'.repeat(40) + '\n');
  assert.deepEqual(readSchemaVersion(dir), { status: 'invalid' });
});

test('readSchemaVersion: invalid when path is a directory, not a regular file', () => {
  const dir = mkTmpDir();
  fs.mkdirSync(path.join(dir, 'schema_version'));
  assert.deepEqual(readSchemaVersion(dir), { status: 'invalid' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/schema.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `hooks/lib/schema.js`**

```js
'use strict';
const fs = require('fs');
const path = require('path');

const HOOK_SCHEMA_VERSION = 1;
const SCHEMA_REGEX = /^[1-9][0-9]*\n$/;
const MAX_SCHEMA_BYTES = 32;

function readSchemaVersion(stateDir) {
  const filePath = path.join(stateDir, 'schema_version');
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') return { status: 'not_initialized' };
    throw err;
  }

  if (!stat.isFile()) return { status: 'invalid' };
  if (stat.size > MAX_SCHEMA_BYTES) return { status: 'invalid' };

  const raw = fs.readFileSync(filePath, 'utf8');
  if (!SCHEMA_REGEX.test(raw)) return { status: 'invalid' };

  return { status: 'ok', version: parseInt(raw, 10) };
}

module.exports = { HOOK_SCHEMA_VERSION, readSchemaVersion };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/schema.test.js`
Expected: PASS (7/7)

- [ ] **Step 5: Write the failing test for init.js**

```js
// tests/init.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const INIT_SCRIPT = path.join(__dirname, '..', 'hooks', 'init.js');

function mkTmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-init-'));
  return dir;
}

function run(args, cwd) {
  return execFileSync('node', [INIT_SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

test('eghs-init bootstraps schema_version and all P1 subdirs', () => {
  const repo = mkTmpRepo();
  run([], repo);
  const stateDir = path.join(repo, '.claude', 'state', 'eghs');
  assert.equal(fs.readFileSync(path.join(stateDir, 'schema_version'), 'utf8'), '1\n');
  for (const sub of ['locks', 'sessions', 'baselines', 'verify-logs', 'debug', 'tmp']) {
    assert.ok(fs.statSync(path.join(stateDir, sub)).isDirectory(), sub);
  }
});

test('eghs-init refuses to run twice without --repair', () => {
  const repo = mkTmpRepo();
  run([], repo);
  assert.throws(() => run([], repo));
});

test('eghs-init --repair is idempotent when everything is already healthy', () => {
  const repo = mkTmpRepo();
  run([], repo);
  assert.doesNotThrow(() => run(['--repair'], repo));
});

test('eghs-init --repair recreates a manually deleted subdir', () => {
  const repo = mkTmpRepo();
  run([], repo);
  const locksDir = path.join(repo, '.claude', 'state', 'eghs', 'locks');
  fs.rmSync(locksDir, { recursive: true, force: true });
  run(['--repair'], repo);
  assert.ok(fs.statSync(locksDir).isDirectory());
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `node --test tests/init.test.js`
Expected: FAIL — `hooks/init.js` not found.

- [ ] **Step 7: Write `hooks/init.js`**

```js
#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { resolveStateDir, P1_SUBDIRS } = require('./lib/state-dir');
const { readSchemaVersion, HOOK_SCHEMA_VERSION } = require('./lib/schema');
const { atomicWriteFile } = require('./lib/atomic-write');

function getRepoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return process.cwd();
  }
}

function main(argv) {
  const repair = argv.includes('--repair');
  const repoRoot = getRepoRoot();
  const stateDir = resolveStateDir(repoRoot);

  const before = readSchemaVersion(stateDir);

  if (!repair) {
    if (before.status !== 'not_initialized') {
      process.stderr.write(
        '[eghs-init] schema_version already exists; use eghs-init --repair or eghs-migrate\n'
      );
      process.exit(1);
    }
  } else {
    if (before.status === 'not_initialized') {
      process.stderr.write(
        '[eghs-init] --repair requires an existing schema_version; run eghs-init first\n'
      );
      process.exit(1);
    }
  }

  for (const sub of P1_SUBDIRS) {
    fs.mkdirSync(path.join(stateDir, sub), { recursive: true, mode: 0o700 });
  }

  if (before.status === 'invalid') {
    atomicWriteFile(path.join(stateDir, 'schema_version'), `${HOOK_SCHEMA_VERSION}\n`);
  } else if (before.status === 'not_initialized') {
    atomicWriteFile(path.join(stateDir, 'schema_version'), `${HOOK_SCHEMA_VERSION}\n`);
  }
  // before.status === 'ok' + --repair: subdirs already recreated above, no-op on schema_version.

  process.stdout.write(`[eghs-init] ready at ${stateDir}\n`);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { main };
```

- [ ] **Step 8: Run test to verify it passes**

Run: `node --test tests/init.test.js`
Expected: PASS (4/4)

- [ ] **Step 9: Commit**

```bash
git add hooks/lib/schema.js hooks/init.js tests/schema.test.js tests/init.test.js
git commit -m "feat: add schema_version reader and eghs-init bootstrap CLI"
```

---

## Task 4: Kill switch + config loader

**Files:**
- Create: `hooks/lib/kill-switch.js`
- Create: `hooks/lib/config.js`
- Test: `tests/kill-switch.test.js`
- Test: `tests/config.test.js`

**Interfaces:**
- Produces: `checkKillSwitch({ repoRoot: string, env: NodeJS.ProcessEnv }): { active: boolean, reason: 'file'|'env'|null }`.
- Produces: `DEFAULT_CONFIG` object, `loadConfig(repoRoot: string): object` (deep-merges `.claude/eghs.config.json` onto `DEFAULT_CONFIG`).

- [ ] **Step 1: Write the failing test for kill-switch.js**

```js
// tests/kill-switch.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkKillSwitch } = require('../hooks/lib/kill-switch');

function mkTmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-kill-'));
}

test('inactive when neither file nor env is set', () => {
  const repo = mkTmpRepo();
  assert.deepEqual(checkKillSwitch({ repoRoot: repo, env: {} }), {
    active: false,
    reason: null,
  });
});

test('active via .claude/eghs-off regular file', () => {
  const repo = mkTmpRepo();
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'eghs-off'), '');
  assert.deepEqual(checkKillSwitch({ repoRoot: repo, env: {} }), {
    active: true,
    reason: 'file',
  });
});

test('active via EGHS_DISABLED=1 env', () => {
  const repo = mkTmpRepo();
  assert.deepEqual(
    checkKillSwitch({ repoRoot: repo, env: { EGHS_DISABLED: '1' } }),
    { active: true, reason: 'env' }
  );
});

test('inactive when eghs-off is a directory, not a regular file', () => {
  const repo = mkTmpRepo();
  fs.mkdirSync(path.join(repo, '.claude', 'eghs-off'), { recursive: true });
  assert.deepEqual(checkKillSwitch({ repoRoot: repo, env: {} }), {
    active: false,
    reason: null,
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/kill-switch.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `hooks/lib/kill-switch.js`**

```js
'use strict';
const fs = require('fs');
const path = require('path');

function checkKillSwitch({ repoRoot, env }) {
  if (env.EGHS_DISABLED === '1') {
    return { active: true, reason: 'env' };
  }

  const offPath = path.join(repoRoot, '.claude', 'eghs-off');
  try {
    const stat = fs.statSync(offPath); // follows symlinks
    if (stat.isFile()) {
      return { active: true, reason: 'file' };
    }
  } catch {
    // ENOENT or broken symlink -> not active
  }

  return { active: false, reason: null };
}

module.exports = { checkKillSwitch };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/kill-switch.test.js`
Expected: PASS (4/4)

- [ ] **Step 5: Write the failing test for config.js**

```js
// tests/config.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig, DEFAULT_CONFIG } = require('../hooks/lib/config');

function mkTmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-config-'));
}

test('loadConfig returns defaults when no config file exists', () => {
  const repo = mkTmpRepo();
  assert.deepEqual(loadConfig(repo), DEFAULT_CONFIG);
});

test('loadConfig merges user config onto defaults without dropping untouched keys', () => {
  const repo = mkTmpRepo();
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, '.claude', 'eghs.config.json'),
    JSON.stringify({
      verification_commands: { typecheck: 'tsc --noEmit' },
      verification_timeout_seconds: 20,
    })
  );
  const config = loadConfig(repo);
  assert.equal(config.verification_timeout_seconds, 20);
  assert.equal(config.verification_parallel, true); // untouched default preserved
  assert.deepEqual(config.verification_commands, { typecheck: 'tsc --noEmit' });
});

test('loadConfig throws a descriptive error on invalid JSON', () => {
  const repo = mkTmpRepo();
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.claude', 'eghs.config.json'), '{ not json');
  assert.throws(() => loadConfig(repo), /eghs\.config\.json/);
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `node --test tests/config.test.js`
Expected: FAIL — module not found.

- [ ] **Step 7: Write `hooks/lib/config.js`**

```js
'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = Object.freeze({
  verification_commands: {},
  verification_timeout_seconds: 45,
  verification_parallel: true,
  verification_cwd: null, // null => repo_root at call time
  verification_shell: ['/bin/sh', '-c'],
  verification_env: {},
  skip_if_only_changed: [],
  diff_base: 'session_baseline',
  matcher_engine: 'picomatch',
  debug: true,
});

function loadConfig(repoRoot) {
  const configPath = path.join(repoRoot, '.claude', 'eghs.config.json');
  let userConfig = {};
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf8');
    try {
      userConfig = JSON.parse(raw);
    } catch (err) {
      throw new Error(`[eghs] failed to parse .claude/eghs.config.json: ${err.message}`);
    }
  }
  return { ...DEFAULT_CONFIG, ...userConfig };
}

module.exports = { DEFAULT_CONFIG, loadConfig };
```

- [ ] **Step 8: Run test to verify it passes**

Run: `node --test tests/config.test.js`
Expected: PASS (3/3)

- [ ] **Step 9: Commit**

```bash
git add hooks/lib/kill-switch.js hooks/lib/config.js tests/kill-switch.test.js tests/config.test.js
git commit -m "feat: add kill-switch check and eghs.config.json loader"
```

---

## Task 5: git helpers (repo root, HEAD commit, changed files, skip matcher)

**Files:**
- Create: `hooks/lib/git.js`
- Test: `tests/git.test.js`

**Interfaces:**
- Produces: `getRepoRoot(cwd: string): string|null`, `getHeadCommit(repoRoot: string): string` (`'NO_GIT'` if no git), `getChangedFiles(repoRoot: string, diffBase: string): string[]`, `shouldSkipVerification(changedFiles: string[], skipGlobs: string[]): boolean`.

- [ ] **Step 1: Write the failing test**

```js
// tests/git.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  getRepoRoot,
  getHeadCommit,
  getChangedFiles,
  shouldSkipVerification,
} = require('../hooks/lib/git');

function sh(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: 'ignore' });
}

function mkGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-git-'));
  sh('git', ['init', '-q'], dir);
  sh('git', ['config', 'user.email', 'a@b.c'], dir);
  sh('git', ['config', 'user.name', 'eghs-test'], dir);
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export {};\n');
  sh('git', ['add', 'a.ts'], dir);
  sh('git', ['commit', '-q', '-m', 'init'], dir);
  return dir;
}

test('getRepoRoot resolves the toplevel for a git repo', () => {
  const dir = mkGitRepo();
  assert.equal(fs.realpathSync(getRepoRoot(dir)), fs.realpathSync(dir));
});

test('getRepoRoot returns null outside a git repo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-nogit-'));
  assert.equal(getRepoRoot(dir), null);
});

test('getHeadCommit returns the current HEAD sha', () => {
  const dir = mkGitRepo();
  const sha = getHeadCommit(dir);
  assert.match(sha, /^[0-9a-f]{40}$/);
});

test('getHeadCommit returns NO_GIT outside a git repo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-nogit2-'));
  assert.equal(getHeadCommit(dir), 'NO_GIT');
});

test('getChangedFiles includes modified tracked files and untracked files', () => {
  const dir = mkGitRepo();
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(dir, 'new.ts'), 'export const y = 1;\n');
  const changed = getChangedFiles(dir, 'HEAD').sort();
  assert.deepEqual(changed, ['a.ts', 'new.ts']);
});

test('shouldSkipVerification is true when every changed file matches a skip glob', () => {
  assert.equal(
    shouldSkipVerification(['README.md', 'docs/x.md'], ['**/*.md', 'docs/**']),
    true
  );
});

test('shouldSkipVerification is false when any changed file does not match', () => {
  assert.equal(shouldSkipVerification(['README.md', 'src/a.ts'], ['**/*.md']), false);
});

test('shouldSkipVerification is false when there are no changed files and no globs configured', () => {
  assert.equal(shouldSkipVerification([], []), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/git.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `hooks/lib/git.js`**

```js
'use strict';
const { execFileSync } = require('child_process');
const picomatch = require('picomatch');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function getRepoRoot(cwd) {
  try {
    return git(['rev-parse', '--show-toplevel'], cwd);
  } catch {
    return null;
  }
}

function getHeadCommit(repoRoot) {
  try {
    return git(['rev-parse', 'HEAD'], repoRoot);
  } catch {
    return 'NO_GIT';
  }
}

function getChangedFiles(repoRoot, diffBase) {
  let tracked = [];
  let untracked = [];
  try {
    const out = git(['diff', '--name-only', diffBase, '--', '.'], repoRoot);
    tracked = out ? out.split('\n').filter(Boolean) : [];
  } catch {
    tracked = [];
  }
  try {
    const out = git(['ls-files', '--others', '--exclude-standard'], repoRoot);
    untracked = out ? out.split('\n').filter(Boolean) : [];
  } catch {
    untracked = [];
  }
  return Array.from(new Set([...tracked, ...untracked]));
}

function shouldSkipVerification(changedFiles, skipGlobs) {
  if (changedFiles.length === 0 || skipGlobs.length === 0) return false;
  const isMatch = picomatch(skipGlobs, { dot: true });
  return changedFiles.every((f) => isMatch(f));
}

module.exports = { getRepoRoot, getHeadCommit, getChangedFiles, shouldSkipVerification };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/git.test.js`
Expected: PASS (8/8)

- [ ] **Step 5: Commit**

```bash
git add hooks/lib/git.js tests/git.test.js
git commit -m "feat: add git helpers and skip_if_only_changed matcher"
```

---

**— Unit 1 (Foundation) checkpoint —** After Task 5, run `/code-review` (senior review) and dispatch a Codex review agent against the Unit 1 diff (Tasks 1-5). Fix all Critical/Major findings, re-run `node --test tests/`, before starting Task 6.

---

## Task 6: Stop recursion lock (`locks/stop-<sid>.lock`)

**Files:**
- Create: `hooks/lib/lock.js`
- Test: `tests/lock.test.js`

**Interfaces:**
- Consumes: `exclusiveLinkCreate` (Task 2), `atomicWriteFile` (Task 1).
- Produces: `acquireStopLock(stateDir: string, sid: string, opts: { pid: number, uid: number, timeoutMs: number, nowMs: number, graceMs?: number }): { ok: true, release: () => void } | { ok: false }`.

- [ ] **Step 1: Write the failing test**

```js
// tests/lock.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { acquireStopLock } = require('../hooks/lib/lock');

function mkStateDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-lock-'));
  for (const sub of ['locks', path.join('locks', 'tmp')]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  return dir;
}

test('acquireStopLock succeeds when no lock exists, and release() removes it', () => {
  const stateDir = mkStateDir();
  const result = acquireStopLock(stateDir, 'sid-1', {
    pid: process.pid,
    uid: process.getuid(),
    timeoutMs: 45000,
    nowMs: 1000,
  });
  assert.equal(result.ok, true);
  const lockPath = path.join(stateDir, 'locks', 'stop-sid-1.lock');
  assert.ok(fs.existsSync(lockPath));
  result.release();
  assert.ok(!fs.existsSync(lockPath));
});

test('acquireStopLock fails (fail-closed) when a live same-pid lock already exists', () => {
  const stateDir = mkStateDir();
  const first = acquireStopLock(stateDir, 'sid-2', {
    pid: process.pid,
    uid: process.getuid(),
    timeoutMs: 45000,
    nowMs: 1000,
  });
  assert.equal(first.ok, true);
  const second = acquireStopLock(stateDir, 'sid-2', {
    pid: process.pid,
    uid: process.getuid(),
    timeoutMs: 45000,
    nowMs: 1500,
  });
  assert.equal(second.ok, false);
  first.release();
});

test('acquireStopLock reclaims a lock held by a dead pid past grace, then succeeds', () => {
  const stateDir = mkStateDir();
  const deadPid = 999999; // astronomically unlikely to be alive
  const lockPath = path.join(stateDir, 'locks', 'stop-sid-3.lock');
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: deadPid, uid: process.getuid(), start_ms: 0, timeout_ms: 100 })
  );
  const result = acquireStopLock(stateDir, 'sid-3', {
    pid: process.pid,
    uid: process.getuid(),
    timeoutMs: 45000,
    nowMs: 10_000, // well past start_ms(0) + timeout_ms(100) + graceMs
  });
  assert.equal(result.ok, true);
  result.release();
});

test('acquireStopLock does not reclaim a lock owned by a different uid (fail-closed)', () => {
  const stateDir = mkStateDir();
  const lockPath = path.join(stateDir, 'locks', 'stop-sid-4.lock');
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: 999999, uid: process.getuid() + 1, start_ms: 0, timeout_ms: 100 })
  );
  const result = acquireStopLock(stateDir, 'sid-4', {
    pid: process.pid,
    uid: process.getuid(),
    timeoutMs: 45000,
    nowMs: 999_999,
  });
  assert.equal(result.ok, false);
});

test('release() is a no-op (does not throw) if called twice', () => {
  const stateDir = mkStateDir();
  const result = acquireStopLock(stateDir, 'sid-5', {
    pid: process.pid,
    uid: process.getuid(),
    timeoutMs: 45000,
    nowMs: 1000,
  });
  result.release();
  assert.doesNotThrow(() => result.release());
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lock.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `hooks/lib/lock.js`**

```js
'use strict';
const fs = require('fs');
const path = require('path');
const { exclusiveLinkCreate } = require('./exclusive-link');

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH' ? true : false; // EPERM => treat as alive (fail-closed)
  }
}

function readLockBody(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

// PRD §R2.5 "Exclusive lock 획득 절차" + stale recovery, scoped to what P1's
// single-writer (Stop hook) needs. Recover-lock TOCTOU dance from the full
// spec is collapsed here because only one process type ever contends for
// this lock in P1 (no PreToolUse/PostToolUse hooks exist yet).
function acquireStopLock(stateDir, sid, { pid, uid, timeoutMs, nowMs, graceMs = 5000 }) {
  const lockPath = path.join(stateDir, 'locks', `stop-${sid}.lock`);
  const body = JSON.stringify({ pid, uid, start_ms: nowMs, timeout_ms: timeoutMs });

  let result = exclusiveLinkCreate(lockPath, body);
  if (result.ok) return { ok: true, release: () => releaseOwn(lockPath, pid) };

  // EEXIST: check staleness once, reclaim if safe, retry exactly once.
  const existing = readLockBody(lockPath);
  if (existing && existing.uid === uid) {
    const dead = !isAlive(existing.pid);
    const expired = nowMs > existing.start_ms + existing.timeout_ms + graceMs;
    if (dead && expired) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // ENOENT: someone else already reclaimed it; fall through to retry.
      }
      result = exclusiveLinkCreate(lockPath, body);
      if (result.ok) return { ok: true, release: () => releaseOwn(lockPath, pid) };
    }
  }

  return { ok: false };
}

function releaseOwn(lockPath, pid) {
  const body = readLockBody(lockPath);
  if (!body || body.pid !== pid) return; // not ours (already reclaimed) -> no-op
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // already gone -> no-op
  }
}

module.exports = { acquireStopLock };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lock.test.js`
Expected: PASS (5/5)

- [ ] **Step 5: Commit**

```bash
git add hooks/lib/lock.js tests/lock.test.js
git commit -m "feat: add Stop-hook recursion lock with stale reclaim"
```

---

## Task 7: Session lease (`sessions/<sid>.json`)

**Files:**
- Create: `hooks/lib/session.js`
- Test: `tests/session.test.js`

**Interfaces:**
- Consumes: `atomicWriteFile` (Task 1).
- Produces: `ensureSessionLease(stateDir: string, sid: string, opts: { pid: number, uid: number, nowMs: number }): { pid: number, uid: number, start_ms: number, renewed_ms: number }`, `gcSessions(stateDir: string, opts: { nowMs: number, sessionStaleSeconds?: number }): void`.

- [ ] **Step 1: Write the failing test**

```js
// tests/session.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureSessionLease, gcSessions } = require('../hooks/lib/session');

function mkStateDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-session-'));
  fs.mkdirSync(path.join(dir, 'sessions', 'tmp'), { recursive: true });
  return dir;
}

test('ensureSessionLease creates a new lease when absent', () => {
  const stateDir = mkStateDir();
  const lease = ensureSessionLease(stateDir, 'sid-1', {
    pid: process.pid,
    uid: process.getuid(),
    nowMs: 1000,
  });
  assert.equal(lease.pid, process.pid);
  assert.equal(lease.start_ms, 1000);
  assert.equal(lease.renewed_ms, 1000);
});

test('ensureSessionLease renews (updates renewed_ms, keeps start_ms) for the same pid', () => {
  const stateDir = mkStateDir();
  ensureSessionLease(stateDir, 'sid-2', { pid: process.pid, uid: process.getuid(), nowMs: 1000 });
  const renewed = ensureSessionLease(stateDir, 'sid-2', {
    pid: process.pid,
    uid: process.getuid(),
    nowMs: 5000,
  });
  assert.equal(renewed.start_ms, 1000);
  assert.equal(renewed.renewed_ms, 5000);
});

test('ensureSessionLease throws SidCollisionError when a different, live pid holds the lease', () => {
  const stateDir = mkStateDir();
  fs.writeFileSync(
    path.join(stateDir, 'sessions', 'sid-3.json'),
    JSON.stringify({ pid: process.pid, uid: process.getuid(), start_ms: 1, renewed_ms: 1 })
  );
  assert.throws(
    () =>
      ensureSessionLease(stateDir, 'sid-3', {
        pid: process.pid + 1 === process.pid ? process.pid + 2 : process.pid + 1,
        uid: process.getuid(),
        nowMs: 2000,
      }),
    /SID_COLLISION/
  );
});

test('gcSessions removes leases whose pid is dead and past staleness window', () => {
  const stateDir = mkStateDir();
  fs.writeFileSync(
    path.join(stateDir, 'sessions', 'sid-dead.json'),
    JSON.stringify({ pid: 999999, uid: process.getuid(), start_ms: 0, renewed_ms: 0 })
  );
  gcSessions(stateDir, { nowMs: 999_999_999, sessionStaleSeconds: 86400 });
  assert.ok(!fs.existsSync(path.join(stateDir, 'sessions', 'sid-dead.json')));
});

test('gcSessions keeps leases for live pids even if renewed_ms is old', () => {
  const stateDir = mkStateDir();
  fs.writeFileSync(
    path.join(stateDir, 'sessions', 'sid-live.json'),
    JSON.stringify({ pid: process.pid, uid: process.getuid(), start_ms: 0, renewed_ms: 0 })
  );
  gcSessions(stateDir, { nowMs: 999_999_999, sessionStaleSeconds: 86400 });
  assert.ok(fs.existsSync(path.join(stateDir, 'sessions', 'sid-live.json')));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/session.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `hooks/lib/session.js`**

```js
'use strict';
const fs = require('fs');
const path = require('path');
const { atomicWriteFile } = require('./atomic-write');

class SidCollisionError extends Error {
  constructor(msg) {
    super(`SID_COLLISION: ${msg}`);
    this.name = 'SidCollisionError';
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

function leasePath(stateDir, sid) {
  return path.join(stateDir, 'sessions', `${sid}.json`);
}

// PRD §R6 6.3: create-or-renew. Never overwrites a live foreign-pid lease.
function ensureSessionLease(stateDir, sid, { pid, uid, nowMs }) {
  const filePath = leasePath(stateDir, sid);
  let existing = null;
  try {
    existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  if (!existing) {
    const lease = { pid, uid, start_ms: nowMs, renewed_ms: nowMs };
    atomicWriteFile(filePath, JSON.stringify(lease));
    return lease;
  }

  if (existing.pid === pid) {
    const lease = { ...existing, renewed_ms: nowMs };
    atomicWriteFile(filePath, JSON.stringify(lease));
    return lease;
  }

  if (isAlive(existing.pid)) {
    throw new SidCollisionError(
      `sid ${sid} already leased by live pid ${existing.pid} (current pid ${pid})`
    );
  }

  // existing.pid is dead -> stale-cleanup: recreate the lease for this pid.
  const lease = { pid, uid, start_ms: nowMs, renewed_ms: nowMs };
  atomicWriteFile(filePath, JSON.stringify(lease));
  return lease;
}

function gcSessions(stateDir, { nowMs, sessionStaleSeconds = 86400 }) {
  const sessionsDir = path.join(stateDir, 'sessions');
  let entries = [];
  try {
    entries = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }

  for (const entry of entries) {
    const filePath = path.join(sessionsDir, entry);
    let body;
    try {
      body = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue;
    }
    const staleByTime = nowMs - body.renewed_ms > sessionStaleSeconds * 1000;
    if (staleByTime && !isAlive(body.pid)) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // already gone -> fine
      }
    }
  }
}

module.exports = { ensureSessionLease, gcSessions, SidCollisionError };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/session.test.js`
Expected: PASS (5/5)

- [ ] **Step 5: Commit**

```bash
git add hooks/lib/session.js tests/session.test.js
git commit -m "feat: add session lease create/renew/GC"
```

---

## Task 8: Baseline (`baselines/<sid>.txt`, anchor-bound)

**Files:**
- Create: `hooks/lib/baseline.js`
- Test: `tests/baseline.test.js`

**Interfaces:**
- Consumes: `exclusiveLinkCreate` (Task 2), `getHeadCommit` (Task 5).
- Produces: `ensureBaseline(stateDir: string, sid: string, opts: { lease: { pid: number, start_ms: number }, repoRoot: string }): { commit: string }`.

- [ ] **Step 1: Write the failing test**

```js
// tests/baseline.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureBaseline } = require('../hooks/lib/baseline');
const { SidCollisionError } = require('../hooks/lib/session');

function mkStateDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-baseline-'));
  fs.mkdirSync(path.join(dir, 'baselines', 'tmp'), { recursive: true });
  return dir;
}

test('ensureBaseline creates a new baseline anchored to the current lease', () => {
  const stateDir = mkStateDir();
  const lease = { pid: process.pid, start_ms: 1000 };
  const result = ensureBaseline(stateDir, 'sid-1', { lease, repoRoot: '/tmp/no-git-here' });
  assert.equal(result.commit, 'NO_GIT');
  const body = JSON.parse(
    fs.readFileSync(path.join(stateDir, 'baselines', 'sid-1.txt'), 'utf8')
  );
  assert.equal(body.lease_start_ms, 1000);
  assert.equal(body.lease_pid, process.pid);
});

test('ensureBaseline reuses an existing baseline when the anchor matches the lease', () => {
  const stateDir = mkStateDir();
  const lease = { pid: process.pid, start_ms: 1000 };
  const first = ensureBaseline(stateDir, 'sid-2', { lease, repoRoot: '/tmp/no-git-here' });
  const second = ensureBaseline(stateDir, 'sid-2', { lease, repoRoot: '/tmp/no-git-here' });
  assert.equal(second.commit, first.commit);
});

test('ensureBaseline runs stale-cleanup and rewrites the anchor when the lease pid is dead', () => {
  const stateDir = mkStateDir();
  fs.writeFileSync(
    path.join(stateDir, 'baselines', 'sid-3.txt'),
    JSON.stringify({ commit: 'deadbeef', lease_start_ms: 1, lease_pid: 999999 })
  );
  const lease = { pid: process.pid, start_ms: 2000 };
  const result = ensureBaseline(stateDir, 'sid-3', { lease, repoRoot: '/tmp/no-git-here' });
  const body = JSON.parse(
    fs.readFileSync(path.join(stateDir, 'baselines', 'sid-3.txt'), 'utf8')
  );
  assert.equal(body.lease_start_ms, 2000);
  assert.equal(body.lease_pid, process.pid);
  assert.equal(result.commit, 'NO_GIT');
});

test('ensureBaseline throws SidCollisionError when anchor mismatches a live foreign pid', () => {
  const stateDir = mkStateDir();
  fs.writeFileSync(
    path.join(stateDir, 'baselines', 'sid-4.txt'),
    JSON.stringify({ commit: 'deadbeef', lease_start_ms: 1, lease_pid: process.pid })
  );
  const lease = { pid: process.pid, start_ms: 999 }; // different start_ms => anchor mismatch
  assert.throws(
    () => ensureBaseline(stateDir, 'sid-4', { lease, repoRoot: '/tmp/no-git-here' }),
    SidCollisionError
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/baseline.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `hooks/lib/baseline.js`**

```js
'use strict';
const fs = require('fs');
const path = require('path');
const { exclusiveLinkCreate } = require('./exclusive-link');
const { getHeadCommit } = require('./git');
const { SidCollisionError } = require('./session');

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

function baselinePath(stateDir, sid) {
  return path.join(stateDir, 'baselines', `${sid}.txt`);
}

function readBody(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// PRD §R6 6.3a/b/c, scoped to P1's single-writer (only Stop leases sessions).
function ensureBaseline(stateDir, sid, { lease, repoRoot }) {
  const filePath = baselinePath(stateDir, sid);
  const write = () => {
    const body = {
      commit: getHeadCommit(repoRoot),
      lease_start_ms: lease.start_ms,
      lease_pid: lease.pid,
    };
    const created = exclusiveLinkCreate(filePath, JSON.stringify(body));
    return { body, created };
  };

  const { body: freshBody, created } = write();
  if (created.ok) return { commit: freshBody.commit };

  // Already existed -> inspect anchor.
  const existing = readBody(filePath);
  const anchorMatches =
    existing && existing.lease_start_ms === lease.start_ms && existing.lease_pid === lease.pid;

  if (anchorMatches) {
    return { commit: existing.commit };
  }

  const foreignPid = existing ? existing.lease_pid : null;
  if (existing && foreignPid !== lease.pid && isAlive(foreignPid)) {
    throw new SidCollisionError(
      `baseline for sid ${sid} anchored to live foreign pid ${foreignPid}`
    );
  }

  // Anchor mismatch + dead (or missing/corrupt) foreign lease -> stale-cleanup.
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ENOENT: another process already cleaned it up; fall through to retry.
  }
  const retry = write();
  if (retry.created.ok) return { commit: retry.body.commit };

  const afterRetry = readBody(filePath);
  if (afterRetry && afterRetry.lease_start_ms === lease.start_ms && afterRetry.lease_pid === lease.pid) {
    return { commit: afterRetry.commit };
  }
  throw new Error(`INFRA_NOT_READY: could not establish baseline anchor for sid ${sid}`);
}

module.exports = { ensureBaseline };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/baseline.test.js`
Expected: PASS (4/4)

- [ ] **Step 5: Commit**

```bash
git add hooks/lib/baseline.js tests/baseline.test.js
git commit -m "feat: add anchor-bound session baseline with stale-cleanup"
```

---

**— Unit 2 (Concurrency & Lease) checkpoint —** After Task 8, run `/code-review` (senior review) and dispatch a Codex review agent against the Unit 2 diff (Tasks 6-8). Fix all Critical/Major findings, re-run `node --test tests/`, before starting Task 9.

---

## Task 9: Verification runner + debug log

**Files:**
- Create: `hooks/lib/verify.js`
- Create: `hooks/lib/debug-log.js`
- Test: `tests/verify.test.js`

**Interfaces:**
- Consumes: `getChangedFiles`, `shouldSkipVerification` (Task 5).
- Produces: `runVerification(config: object, opts: { repoRoot: string, sid: string, stateDir: string, diffBase: string, env: object }): Promise<{ skipped: boolean, passed: boolean, failedChecks: string[], results: Array<{ name: string, exitCode: number|null, timedOut: boolean, logPath: string }> }>`.
- Produces: `appendDebugLog(stateDir: string, sid: string, event: object): void`.

- [ ] **Step 1: Write the failing test**

```js
// tests/verify.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { runVerification } = require('../hooks/lib/verify');

function mkGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-verify-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'eghs-test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export {};\n');
  execFileSync('git', ['add', 'a.ts'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  fs.mkdirSync(path.join(dir, '.claude', 'state', 'eghs', 'verify-logs', 'sid-1'), {
    recursive: true,
  });
  return dir;
}

test('runVerification passes when all commands exit 0', async () => {
  const repoRoot = mkGitRepo();
  const stateDir = path.join(repoRoot, '.claude', 'state', 'eghs');
  const result = await runVerification(
    { verification_commands: { typecheck: 'true' }, verification_parallel: true, verification_timeout_seconds: 5, verification_shell: ['/bin/sh', '-c'], verification_env: {}, skip_if_only_changed: [], matcher_engine: 'picomatch' },
    { repoRoot, sid: 'sid-1', stateDir, diffBase: 'HEAD', env: process.env }
  );
  assert.equal(result.skipped, false);
  assert.equal(result.passed, true);
  assert.deepEqual(result.failedChecks, []);
});

test('runVerification fails and reports the failing check name when a command exits non-zero', async () => {
  const repoRoot = mkGitRepo();
  const stateDir = path.join(repoRoot, '.claude', 'state', 'eghs');
  const result = await runVerification(
    { verification_commands: { lint: 'false' }, verification_parallel: true, verification_timeout_seconds: 5, verification_shell: ['/bin/sh', '-c'], verification_env: {}, skip_if_only_changed: [], matcher_engine: 'picomatch' },
    { repoRoot, sid: 'sid-1', stateDir, diffBase: 'HEAD', env: process.env }
  );
  assert.equal(result.passed, false);
  assert.deepEqual(result.failedChecks, ['lint']);
});

test('runVerification writes a log file per command under verify-logs/<sid>/', async () => {
  const repoRoot = mkGitRepo();
  const stateDir = path.join(repoRoot, '.claude', 'state', 'eghs');
  await runVerification(
    { verification_commands: { typecheck: 'echo hello' }, verification_parallel: true, verification_timeout_seconds: 5, verification_shell: ['/bin/sh', '-c'], verification_env: {}, skip_if_only_changed: [], matcher_engine: 'picomatch' },
    { repoRoot, sid: 'sid-1', stateDir, diffBase: 'HEAD', env: process.env }
  );
  const log = fs.readFileSync(
    path.join(stateDir, 'verify-logs', 'sid-1', 'typecheck.log'),
    'utf8'
  );
  assert.match(log, /hello/);
});

test('runVerification skips entirely when all changed files match skip_if_only_changed', async () => {
  const repoRoot = mkGitRepo();
  fs.writeFileSync(path.join(repoRoot, 'README.md'), 'hi\n');
  const stateDir = path.join(repoRoot, '.claude', 'state', 'eghs');
  const result = await runVerification(
    { verification_commands: { typecheck: 'false' }, verification_parallel: true, verification_timeout_seconds: 5, verification_shell: ['/bin/sh', '-c'], verification_env: {}, skip_if_only_changed: ['**/*.md'], matcher_engine: 'picomatch' },
    { repoRoot, sid: 'sid-1', stateDir, diffBase: 'HEAD', env: process.env }
  );
  assert.equal(result.skipped, true);
  assert.equal(result.passed, true);
});

test('runVerification forces STOP_HOOK_ACTIVE=1 for child processes regardless of verification_env', async () => {
  const repoRoot = mkGitRepo();
  const stateDir = path.join(repoRoot, '.claude', 'state', 'eghs');
  await runVerification(
    { verification_commands: { typecheck: 'echo $STOP_HOOK_ACTIVE' }, verification_parallel: true, verification_timeout_seconds: 5, verification_shell: ['/bin/sh', '-c'], verification_env: { STOP_HOOK_ACTIVE: '' }, skip_if_only_changed: [], matcher_engine: 'picomatch' },
    { repoRoot, sid: 'sid-1', stateDir, diffBase: 'HEAD', env: process.env }
  );
  const log = fs.readFileSync(
    path.join(stateDir, 'verify-logs', 'sid-1', 'typecheck.log'),
    'utf8'
  );
  assert.match(log, /^1/m);
});

test('runVerification marks a timed-out command as failed', async () => {
  const repoRoot = mkGitRepo();
  const stateDir = path.join(repoRoot, '.claude', 'state', 'eghs');
  const result = await runVerification(
    { verification_commands: { test: 'sleep 5' }, verification_parallel: true, verification_timeout_seconds: 1, verification_shell: ['/bin/sh', '-c'], verification_env: {}, skip_if_only_changed: [], matcher_engine: 'picomatch' },
    { repoRoot, sid: 'sid-1', stateDir, diffBase: 'HEAD', env: process.env }
  );
  assert.equal(result.passed, false);
  assert.equal(result.results[0].timedOut, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/verify.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `hooks/lib/verify.js`**

```js
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getChangedFiles, shouldSkipVerification } = require('./git');

function buildEnv(parentEnv, overlay) {
  const merged = { ...parentEnv };
  for (const [key, value] of Object.entries(overlay || {})) {
    if (value === '') delete merged[key];
    else merged[key] = value;
  }
  merged.STOP_HOOK_ACTIVE = '1'; // forced regardless of overlay — PRD §R5
  return merged;
}

function runOne(name, command, config, { cwd, env, logPath }) {
  return new Promise((resolve) => {
    const [shellCmd, ...shellArgs] = config.verification_shell;
    const child = spawn(shellCmd, [...shellArgs, command], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));

    let timedOut = false;
    const timeoutMs = config.verification_timeout_seconds * 1000;
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutMs);
    killTimer.unref?.();

    child.on('close', (exitCode) => {
      clearTimeout(killTimer);
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, output);
      resolve({ name, exitCode: timedOut ? null : exitCode, timedOut, logPath });
    });
  });
}

async function runVerification(config, { repoRoot, sid, stateDir, diffBase, env }) {
  const changedFiles = getChangedFiles(repoRoot, diffBase);
  if (shouldSkipVerification(changedFiles, config.skip_if_only_changed)) {
    return { skipped: true, passed: true, failedChecks: [], results: [] };
  }

  const commands = Object.entries(config.verification_commands).filter(([, cmd]) => cmd);
  const cwd = config.verification_cwd || repoRoot;
  const childEnv = buildEnv(env, config.verification_env);
  const logDir = path.join(stateDir, 'verify-logs', sid);

  const runOneCommand = ([name, command]) =>
    runOne(name, command, config, { cwd, env: childEnv, logPath: path.join(logDir, `${name}.log`) });

  let results;
  if (config.verification_parallel) {
    results = await Promise.all(commands.map(runOneCommand));
  } else {
    results = [];
    for (const entry of commands) {
      results.push(await runOneCommand(entry));
    }
  }

  const failedChecks = results
    .filter((r) => r.timedOut || r.exitCode !== 0)
    .map((r) => r.name);

  return { skipped: false, passed: failedChecks.length === 0, failedChecks, results };
}

module.exports = { runVerification };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/verify.test.js`
Expected: PASS (6/6)

- [ ] **Step 5: Write `hooks/lib/debug-log.js`** (no dedicated unit test — exercised end-to-end in Task 11)

```js
'use strict';
const fs = require('fs');
const path = require('path');

// Best-effort JSONL append — never throws, matches PRD §R5 measurement schema.
function appendDebugLog(stateDir, sid, event) {
  try {
    const dir = path.join(stateDir, 'debug');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const line = JSON.stringify({ schema_version: 1, sid, ...event }) + '\n';
    fs.appendFileSync(path.join(dir, `${sid}.jsonl`), line);
  } catch {
    // best-effort: debug logging must never break the hook decision path.
  }
}

module.exports = { appendDebugLog };
```

- [ ] **Step 6: Commit**

```bash
git add hooks/lib/verify.js hooks/lib/debug-log.js tests/verify.test.js
git commit -m "feat: add verification command runner and debug log writer"
```

---

## Task 10: Stop hook entrypoint (`hooks/stop.js`)

**Files:**
- Create: `hooks/stop.js`
- Test: `tests/stop.test.js` (end-to-end, via `execFileSync`)

**Interfaces:**
- Consumes: every module from Tasks 1-9.
- Produces: a CLI that reads hook-input JSON from stdin, writes `{ decision, deny_code, reason, extra }` JSON to stdout, and exits `0` (allow/skip) or `2` (block).

- [ ] **Step 1: Write the failing end-to-end tests**

```js
// tests/stop.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const STOP_SCRIPT = path.join(__dirname, '..', 'hooks', 'stop.js');
const INIT_SCRIPT = path.join(__dirname, '..', 'hooks', 'init.js');
const SID_1 = '11111111-1111-4111-8111-111111111111';

function sh(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: 'ignore' });
}

function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-stop-'));
  sh('git', ['init', '-q'], dir);
  sh('git', ['config', 'user.email', 'a@b.c'], dir);
  sh('git', ['config', 'user.name', 'eghs-test'], dir);
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export {};\n');
  sh('git', ['add', 'a.ts'], dir);
  sh('git', ['commit', '-q', '-m', 'init'], dir);
  return dir;
}

function writeConfig(repo, config) {
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, '.claude', 'eghs.config.json'),
    JSON.stringify(config)
  );
}

function runStop(repo, input, extraEnv = {}) {
  try {
    const stdout = execFileSync('node', [STOP_SCRIPT], {
      cwd: repo,
      input: JSON.stringify(input),
      encoding: 'utf8',
      env: { ...process.env, ...extraEnv },
    });
    return { exitCode: 0, decision: JSON.parse(stdout) };
  } catch (err) {
    return { exitCode: err.status, decision: JSON.parse(err.stdout) };
  }
}

test('allows (exit 0) when verification commands all pass', () => {
  const repo = mkRepo();
  execFileSync('node', [INIT_SCRIPT], { cwd: repo });
  writeConfig(repo, { verification_commands: { typecheck: 'true' } });
  const { exitCode, decision } = runStop(repo, { session_id: SID_1 });
  assert.equal(exitCode, 0);
  assert.equal(decision.decision, 'allow');
});

test('blocks (exit 2) when a verification command fails, naming the failed check', () => {
  const repo = mkRepo();
  execFileSync('node', [INIT_SCRIPT], { cwd: repo });
  writeConfig(repo, { verification_commands: { lint: 'false' } });
  const { exitCode, decision } = runStop(repo, { session_id: SID_1 });
  assert.equal(exitCode, 2);
  assert.equal(decision.decision, 'block');
  assert.match(decision.reason, /lint/);
});

test('kill switch (.claude/eghs-off) allows immediately without running verification', () => {
  const repo = mkRepo();
  execFileSync('node', [INIT_SCRIPT], { cwd: repo });
  writeConfig(repo, { verification_commands: { lint: 'false' } });
  fs.writeFileSync(path.join(repo, '.claude', 'eghs-off'), '');
  const { exitCode, decision } = runStop(repo, { session_id: SID_1 });
  assert.equal(exitCode, 0);
  assert.equal(decision.decision, 'allow');
});

test('EGHS_DISABLED=1 allows immediately even with a failing command', () => {
  const repo = mkRepo();
  execFileSync('node', [INIT_SCRIPT], { cwd: repo });
  writeConfig(repo, { verification_commands: { lint: 'false' } });
  const { exitCode, decision } = runStop(repo, { session_id: SID_1 }, { EGHS_DISABLED: '1' });
  assert.equal(exitCode, 0);
  assert.equal(decision.decision, 'allow');
});

test('STOP_HOOK_ACTIVE=1 recursion guard allows immediately', () => {
  const repo = mkRepo();
  execFileSync('node', [INIT_SCRIPT], { cwd: repo });
  writeConfig(repo, { verification_commands: { lint: 'false' } });
  const { exitCode, decision } = runStop(
    repo,
    { session_id: SID_1 },
    { STOP_HOOK_ACTIVE: '1' }
  );
  assert.equal(exitCode, 0);
  assert.equal(decision.decision, 'allow');
});

test('stop_hook_active:true in hook input is treated the same as the env recursion guard', () => {
  const repo = mkRepo();
  execFileSync('node', [INIT_SCRIPT], { cwd: repo });
  writeConfig(repo, { verification_commands: { lint: 'false' } });
  const { exitCode, decision } = runStop(repo, { session_id: SID_1, stop_hook_active: true });
  assert.equal(exitCode, 0);
  assert.equal(decision.decision, 'allow');
});

test('blocks with INFRA_NOT_READY when eghs-init was never run', () => {
  const repo = mkRepo();
  writeConfig(repo, { verification_commands: { lint: 'false' } });
  const { exitCode, decision } = runStop(repo, { session_id: SID_1 });
  assert.equal(exitCode, 2);
  assert.equal(decision.deny_code, 'INFRA_NOT_READY');
});

test('a second concurrent Stop invocation for the same sid fails closed (lock contention)', () => {
  const repo = mkRepo();
  execFileSync('node', [INIT_SCRIPT], { cwd: repo });
  writeConfig(repo, { verification_commands: { typecheck: 'sleep 3' } });
  const stateDir = path.join(repo, '.claude', 'state', 'eghs');
  fs.mkdirSync(path.join(stateDir, 'locks', 'tmp'), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'locks', `stop-${SID_1}.lock`),
    JSON.stringify({ pid: process.pid, uid: process.getuid(), start_ms: Date.now(), timeout_ms: 45000 })
  );
  const { exitCode, decision } = runStop(repo, { session_id: SID_1 });
  assert.equal(exitCode, 2);
  assert.equal(decision.deny_code, 'INFRA_NOT_READY');
});

test('malformed stdin JSON is reported as INPUT_PARSE, not a crash', () => {
  const repo = mkRepo();
  execFileSync('node', [INIT_SCRIPT], { cwd: repo });
  let result;
  try {
    execFileSync('node', [STOP_SCRIPT], { cwd: repo, input: '{ not json', encoding: 'utf8' });
    result = { threw: false };
  } catch (err) {
    result = { threw: true, status: err.status, stdout: err.stdout };
  }
  assert.equal(result.threw, true);
  assert.equal(result.status, 2);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.deny_code, 'INPUT_PARSE');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/stop.test.js`
Expected: FAIL — `hooks/stop.js` not found.

- [ ] **Step 3: Write `hooks/stop.js`**

```js
#!/usr/bin/env node
'use strict';
const { execFileSync } = require('child_process');
const { resolveStateDir } = require('./lib/state-dir');
const { readSchemaVersion, HOOK_SCHEMA_VERSION } = require('./lib/schema');
const { checkKillSwitch } = require('./lib/kill-switch');
const { loadConfig } = require('./lib/config');
const { acquireStopLock } = require('./lib/lock');
const { ensureSessionLease, gcSessions, SidCollisionError } = require('./lib/session');
const { ensureBaseline } = require('./lib/baseline');
const { runVerification } = require('./lib/verify');
const { appendDebugLog } = require('./lib/debug-log');

const SID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function readStdin() {
  const chunks = [];
  const fd = 0;
  const buf = Buffer.alloc(65536);
  const fs = require('fs');
  while (true) {
    let bytesRead;
    try {
      bytesRead = fs.readSync(fd, buf, 0, buf.length, null);
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

function emit(exitCode, decision, extra) {
  process.stdout.write(
    JSON.stringify({
      decision: decision.decision,
      deny_code: decision.deny_code || null,
      reason: decision.reason || null,
      extra: extra || {},
    })
  );
  process.exit(exitCode);
}

function getRepoRoot(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
    }).trim();
  } catch {
    return cwd;
  }
}

async function main() {
  // Recursion guard — checked before anything else touches disk (PRD §R5).
  if (process.env.STOP_HOOK_ACTIVE === '1') {
    emit(0, { decision: 'allow', reason: 'recursion guard (env)' });
    return;
  }

  let input;
  try {
    const raw = readStdin();
    input = raw ? JSON.parse(raw) : {};
  } catch {
    emit(2, { decision: 'block', deny_code: 'INPUT_PARSE', reason: 'malformed stdin JSON' });
    return;
  }

  if (input.stop_hook_active === true) {
    emit(0, { decision: 'allow', reason: 'recursion guard (input field)' });
    return;
  }

  const repoRoot = getRepoRoot(process.cwd());
  const stateDir = resolveStateDir(repoRoot);

  // Precedence #2: kill switch (stat/env only, no mutation).
  const killSwitch = checkKillSwitch({ repoRoot, env: process.env });
  if (killSwitch.active) {
    process.stderr.write(`[eghs] kill-switch active: ${killSwitch.reason}\n`);
    emit(0, { decision: 'allow', reason: `kill-switch:${killSwitch.reason}` });
    return;
  }

  // Precedence #1/#7 (P1 scope: no migrate CLI exists, so migrate.lock is
  // never written — only NOT_INITIALIZED/INVALID block Stop; PRD §R6 #7).
  const schema = readSchemaVersion(stateDir);
  if (schema.status === 'not_initialized' || schema.status === 'invalid') {
    emit(2, {
      decision: 'block',
      deny_code: 'INFRA_NOT_READY',
      reason: 'eghs state dir missing or corrupt — run `node hooks/init.js`',
    });
    return;
  }
  // schema.status === 'ok': MISMATCH/FS_INFO_MISSING are treated identically
  // to healthy for Stop (PRD §R6 #7) — version mismatch doesn't block P1.

  const sid = input.session_id;
  if (typeof sid !== 'string' || !SID_REGEX.test(sid)) {
    // NO_SESSION signal (PRD §R2.5): allow, but skip all state work.
    emit(0, { decision: 'allow', reason: 'no valid session_id (NO_SESSION)' });
    return;
  }

  const nowMs = Date.now();
  const pid = Number(process.env.CLAUDE_CODE_PID) || process.ppid;
  const uid = process.getuid();

  gcSessions(stateDir, { nowMs });

  let lease;
  let baseline;
  try {
    lease = ensureSessionLease(stateDir, sid, { pid, uid, nowMs });
    baseline = ensureBaseline(stateDir, sid, { lease, repoRoot });
  } catch (err) {
    if (err instanceof SidCollisionError) {
      appendDebugLog(stateDir, sid, {
        ts_ms: nowMs,
        hook: 'Stop',
        decision: 'block',
        deny_code: 'SID_COLLISION',
      });
      emit(2, { decision: 'block', deny_code: 'SID_COLLISION', reason: err.message });
      return;
    }
    emit(2, { decision: 'block', deny_code: 'INFRA_NOT_READY', reason: err.message });
    return;
  }

  const config = loadConfig(repoRoot);
  const lockResult = acquireStopLock(stateDir, sid, {
    pid,
    uid,
    timeoutMs: config.verification_timeout_seconds * 1000,
    nowMs,
  });
  if (!lockResult.ok) {
    emit(2, {
      decision: 'block',
      deny_code: 'INFRA_NOT_READY',
      reason: 'stop lock held by another active hook invocation (fail-closed)',
    });
    return;
  }

  try {
    const diffBase =
      config.diff_base === 'session_baseline' ? baseline.commit : config.diff_base;
    const result = await runVerification(config, {
      repoRoot,
      sid,
      stateDir,
      diffBase: diffBase === 'NO_GIT' ? 'HEAD' : diffBase,
      env: process.env,
    });

    appendDebugLog(stateDir, sid, {
      ts_ms: nowMs,
      hook: 'Stop',
      decision: result.passed ? 'allow' : 'block',
      deny_code: result.passed ? null : 'VERIFICATION_FAILED',
    });

    if (result.passed) {
      emit(0, { decision: 'allow', reason: result.skipped ? 'skipped (docs-only change)' : null }, {
        failedChecks: [],
      });
    } else {
      emit(
        2,
        {
          decision: 'block',
          deny_code: 'VERIFICATION_FAILED',
          reason: `verification failed: ${result.failedChecks.join(', ')}`,
        },
        { results: result.results.map((r) => ({ name: r.name, exitCode: r.exitCode, timedOut: r.timedOut })) }
      );
    }
  } finally {
    lockResult.release();
  }
}

main().catch((err) => {
  process.stderr.write(`[eghs] stop hook crashed: ${err.stack || err.message}\n`);
  process.exit(1);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/stop.test.js`
Expected: PASS (9/9)

- [ ] **Step 5: Run the full test suite**

Run: `node --test tests/`
Expected: All tests across all files PASS.

- [ ] **Step 6: Commit**

```bash
git add hooks/stop.js tests/stop.test.js
git commit -m "feat: wire up Stop hook entrypoint (P1 complete)"
```

---

## Task 11: Wire `Stop` hook into Claude Code settings + README

**Files:**
- Create: `.claude/settings.json` (merge if it already has content — it currently doesn't for hooks)
- Create: `README.md`

**Interfaces:** none (configuration only).

- [ ] **Step 1: Add the Stop hook registration**

Check `.claude/settings.local.json` first (it currently only has a `permissions` block for `Bash(node *)`). Add a project-level `.claude/settings.json`:

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
    ]
  }
}
```

- [ ] **Step 2: Write a short `README.md`**

```markdown
# EGHS

Evidence-Gated Hook System for Claude Code. See `PRD.md` for the full spec.

Currently implemented: **P1 — Stop hook** (typecheck/lint verification gate).

## Setup

\`\`\`bash
npm install
node hooks/init.js
\`\`\`

Configure verification commands in `.claude/eghs.config.json`:

\`\`\`json
{
  "verification_commands": { "typecheck": "pnpm typecheck", "lint": "pnpm lint" }
}
\`\`\`

## Kill switch

- `.claude/eghs-off` (create an empty file), or
- `EGHS_DISABLED=1`

## Tests

\`\`\`bash
npm test
\`\`\`
```

- [ ] **Step 3: Verify the hook fires in a real Claude Code session**

Run: `echo '{"session_id":"11111111-1111-4111-8111-111111111111"}' | node hooks/stop.js; echo "exit=$?"`
Expected: JSON decision line printed, `exit=2` if `INFRA_NOT_READY` (before `eghs-init`) or `exit=0`/`exit=2` depending on configured commands after `node hooks/init.js`.

- [ ] **Step 4: Commit**

```bash
git add .claude/settings.json README.md
git commit -m "chore: register Stop hook in Claude Code settings, add README"
```

---

**— Unit 3 (Verification & Entrypoint) checkpoint —** After Task 11, run `/code-review` (senior review) and dispatch a Codex review agent against the Unit 3 diff (Tasks 9-11). Fix all Critical/Major findings, re-run `node --test tests/` and the manual smoke test in Task 11 Step 3, then P1 is done.

---

## Self-Review Notes

* **Spec coverage:** R5 (verification exec, timeout/parallel, skip_if_only_changed, verify-logs, recursion guard) ✅ Task 9/10. R6 precedence subset relevant to Stop (schema stat-only #1, kill switch #2, CI-passthrough-excludes-Stop — enforced by simply never checking CI env in `stop.js`, sessions GC + lease #5/#6, baseline anchor #6.3, schema branch #7) ✅ Tasks 3,4,7,8,10. R2.5 atomic write / exclusive-link / dir layout (P1 subset) ✅ Tasks 1,2,3. MVP item 7 (dry-run-style stdin/stdout JSON interface, exit code enum) ✅ Task 10 — implemented as the *only* interface (no separate "real" protocol), which is simpler and still satisfies the literal requirement. MVP item 15 (parallel default true, 45s timeout) ✅ Task 4 defaults. MVP item 16 (kill switch precedence over schema mismatch) ✅ Task 10 (`killSwitch` check runs before `readSchemaVersion`... actually verify ordering below).
* **Ordering check:** PRD §R6 says precedence #1 (schema stat) happens *before* #2 (kill switch) — reading is stat-only so order doesn't affect any mutation, but MVP item 16 explicitly says "Kill switch는 SCHEMA_MISMATCH보다 우선 평가". `hooks/stop.js` currently checks kill switch *before* schema — that matches MVP item 16's intent (kill switch wins) even though it differs from the raw #1-before-#2 listing order (§R6's #1 is non-mutating and only used to compute `disk_schema`, which isn't needed until #7; checking kill switch first is both correct per MVP item 16 and strictly fewer syscalls on the common allow path). No fix needed — documented here so reviewers don't flag it as a spec deviation.
* **Placeholder scan:** no TBD/TODO markers; every step has complete code.
* **Type consistency:** `ensureSessionLease` return shape `{pid,uid,start_ms,renewed_ms}` matches what `ensureBaseline`'s `lease` param reads (`lease.pid`, `lease.start_ms`). `runVerification` return shape (`skipped,passed,failedChecks,results`) matches what `stop.js` destructures. `SidCollisionError` exported from `session.js` and imported by both `baseline.js` and `stop.js`.
