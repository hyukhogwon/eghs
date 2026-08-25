'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const INSTALL = path.join(REPO, 'install.sh');

// The installer compiles fs-ext, so each run costs seconds. Install ONCE into
// a shared target and let the read-only assertions share it; only the tests
// that need a different starting state pay for their own run.
let shared = null;

function mkProject({ git = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-install-')));
  if (git) execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

function install(target, args = []) {
  return spawnSync('bash', [INSTALL, ...(target === null ? [] : [target]), ...args], {
    encoding: 'utf8',
    cwd: target === null ? REPO : os.tmpdir(),
  });
}

function sharedInstall() {
  if (shared === null) {
    const dir = mkProject();
    const r = install(dir);
    assert.equal(r.status, 0, `install failed: ${r.stdout}\n${r.stderr}`);
    shared = { dir, result: r };
  }
  return shared;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function hookCommands(settings) {
  return Object.entries(settings.hooks).flatMap(([event, groups]) =>
    groups.flatMap((g) => g.hooks.map((h) => `${event} ${g.matcher || '(all)'} ${h.command}`))
  );
}

test('a fresh install exits 0 and reports success', () => {
  const { result } = sharedInstall();
  assert.equal(result.status, 0);
  assert.match(result.stdout, /EGHS installed/);
});

test('hook entrypoints and lib are copied, with deps self-contained under hooks/', () => {
  const { dir } = sharedInstall();
  for (const f of ['pre-tool-use.js', 'post-tool-use.js', 'stop.js', 'user-prompt-submit.js', 'init.js']) {
    assert.ok(fs.existsSync(path.join(dir, 'hooks', f)), `missing hooks/${f}`);
  }
  assert.ok(fs.existsSync(path.join(dir, 'hooks', 'lib', 'gate.js')));
  assert.ok(fs.existsSync(path.join(dir, 'hooks', 'node_modules', 'fs-ext')));
  assert.ok(fs.existsSync(path.join(dir, 'hooks', 'node_modules', 'picomatch')));
  // The point of --prefix hooks/: the project's own root stays untouched.
  assert.equal(fs.existsSync(path.join(dir, 'package.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'node_modules')), false);
});

test('all four hooks are registered with the documented matchers', () => {
  const { dir } = sharedInstall();
  const commands = hookCommands(readJson(path.join(dir, '.claude', 'settings.json')));
  assert.deepEqual(commands.sort(), [
    'PostToolUse Read|Write|Edit|MultiEdit node "$CLAUDE_PROJECT_DIR/hooks/post-tool-use.js"',
    'PreToolUse Read|Write|Edit|MultiEdit node "$CLAUDE_PROJECT_DIR/hooks/pre-tool-use.js"',
    'Stop (all) node "$CLAUDE_PROJECT_DIR/hooks/stop.js"',
    'UserPromptSubmit (all) node "$CLAUDE_PROJECT_DIR/hooks/user-prompt-submit.js"',
  ]);
});

test('the gate ships OFF — installing changes no behaviour until globs are set', () => {
  const { dir, result } = sharedInstall();
  assert.deepEqual(readJson(path.join(dir, '.claude', 'eghs.config.json')).state_gate_paths, []);
  assert.match(result.stdout, /gate is OFF/);
});

test('state and the kill switch are gitignored', () => {
  const { dir } = sharedInstall();
  const lines = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').split('\n');
  assert.ok(lines.includes('.claude/state/'));
  assert.ok(lines.includes('.claude/eghs-off'));
});

test('the state dir is bootstrapped and healthy', () => {
  const { dir } = sharedInstall();
  assert.equal(
    fs.readFileSync(path.join(dir, '.claude', 'state', 'eghs', 'schema_version'), 'utf8').trim(),
    '1'
  );
  const r = spawnSync('node', ['hooks/inspect.js'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('the installer leaves no smoke-test residue behind', () => {
  const { dir } = sharedInstall();
  assert.equal(fs.existsSync(path.join(dir, '.claude', 'state', 'eghs', '.install-smoke')), false);
});

test('the installed gate actually denies an unread edit once turned on', () => {
  const { dir } = sharedInstall();
  fs.writeFileSync(
    path.join(dir, '.claude', 'eghs.config.json'),
    JSON.stringify({ state_gate_paths: ['**/*.ts'] })
  );
  const file = path.join(dir, 'app.ts');
  fs.writeFileSync(file, 'export const a = 1;\n');
  try {
    const r = spawnSync('node', ['hooks/pre-tool-use.js'], {
      cwd: dir,
      encoding: 'utf8',
      input: JSON.stringify({
        session_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        tool_name: 'Edit',
        tool_input: { file_path: file },
        tool_use_id: 'install-test',
      }),
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /UNREAD_OR_STALE/);
  } finally {
    // Restore the shared fixture for any test that runs after this one.
    fs.writeFileSync(
      path.join(dir, '.claude', 'eghs.config.json'),
      JSON.stringify({ state_gate_paths: [], verification_commands: {} }, null, 2)
    );
    fs.rmSync(file, { force: true });
  }
});

// ---- merge safety: the installer edits a file the user may already own ----

test('re-running is idempotent — no duplicate hook registrations', () => {
  const dir = mkProject();
  assert.equal(install(dir).status, 0);
  const first = hookCommands(readJson(path.join(dir, '.claude', 'settings.json')));
  assert.equal(install(dir).status, 0);
  const second = hookCommands(readJson(path.join(dir, '.claude', 'settings.json')));
  assert.deepEqual(second, first);
  assert.equal(second.length, 4);
});

test('existing non-EGHS hooks and unrelated settings keys survive', () => {
  const dir = mkProject();
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.claude', 'settings.json'),
    JSON.stringify({
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'echo my-stop' }] }],
      },
    })
  );
  assert.equal(install(dir).status, 0);

  const settings = readJson(path.join(dir, '.claude', 'settings.json'));
  assert.deepEqual(settings.permissions, { allow: ['Bash(ls:*)'] });
  const commands = hookCommands(settings);
  assert.ok(commands.includes('PreToolUse Bash echo mine'));
  assert.ok(commands.includes('Stop (all) echo my-stop'));
  assert.equal(commands.filter((c) => c.includes('pre-tool-use.js')).length, 1);
  assert.equal(commands.filter((c) => c.includes('stop.js')).length, 1);
});

test('an existing eghs.config.json is never overwritten', () => {
  const dir = mkProject();
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  const config = { state_gate_paths: ['src/**/*.ts'], stale_after_seconds: 60 };
  fs.writeFileSync(path.join(dir, '.claude', 'eghs.config.json'), JSON.stringify(config));
  assert.equal(install(dir).status, 0);
  assert.deepEqual(readJson(path.join(dir, '.claude', 'eghs.config.json')), config);
});

test('settings.json is backed up before being rewritten', () => {
  const dir = mkProject();
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ permissions: {} }));
  assert.equal(install(dir).status, 0);
  const backups = fs.readdirSync(path.join(dir, '.claude')).filter((n) => n.includes('eghs-backup'));
  assert.equal(backups.length, 1);
});

test('a corrupt settings.json aborts the install instead of destroying it', () => {
  const dir = mkProject();
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  const corrupt = '{ not json';
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), corrupt);
  const r = install(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not valid JSON/);
  assert.equal(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'), corrupt);
});

// ---- argument handling ----

test('refuses to install into the EGHS checkout itself', () => {
  const r = spawnSync('bash', [INSTALL, REPO], { encoding: 'utf8', cwd: os.tmpdir() });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /EGHS repo itself/);
});

test('a nonexistent target is rejected', () => {
  const r = spawnSync('bash', [INSTALL, path.join(os.tmpdir(), 'eghs-does-not-exist-xyz')], {
    encoding: 'utf8',
    cwd: os.tmpdir(),
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not a directory/);
});

test('--help exits 0 without touching anything', () => {
  const r = spawnSync('bash', [INSTALL, '--help'], { encoding: 'utf8', cwd: os.tmpdir() });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage:/);
});

test('a non-git target still installs, with a warning', () => {
  const dir = mkProject({ git: false });
  const r = install(dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /not a git repo/);
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'state', 'eghs', 'schema_version')));
  assert.equal(fs.existsSync(path.join(dir, '.gitignore')), false);
});
