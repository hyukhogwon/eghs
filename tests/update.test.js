'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const UPDATE = path.join(REPO, 'update.sh');

// Each scenario needs its own EGHS checkout (update.sh moves its HEAD), and
// installing compiles fs-ext. Build the pair once and clone the *installed*
// project per test by copying it — far cheaper than re-running install.sh.
let base = null;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commitAll(dir, message) {
  git(['add', '-A'], dir);
  git(['-c', 'user.email=t@t', '-c', 'user.name=eghs-test', 'commit', '-qm', message], dir);
  return git(['rev-parse', 'HEAD'], dir);
}

// A committed EGHS checkout + a project with that exact version installed.
function buildBase() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-update-base-')));
  const src = path.join(root, 'eghs');
  fs.cpSync(REPO, src, {
    recursive: true,
    filter: (p) => !/(node_modules|\.claude[/\\]state|\.git[/\\])/.test(p),
  });
  fs.rmSync(path.join(src, '.git'), { recursive: true, force: true });
  git(['init', '-q'], src);
  const commit = commitAll(src, 'base');

  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  git(['init', '-q'], project);
  const r = spawnSync('bash', [path.join(src, 'install.sh'), project], { encoding: 'utf8' });
  assert.equal(r.status, 0, `install failed: ${r.stdout}\n${r.stderr}`);
  return { root, src, project, commit };
}

// Independent copy of {eghs checkout, installed project} for one scenario.
function scenario() {
  if (base === null) base = buildBase();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-update-')));
  const src = path.join(dir, 'eghs');
  const project = path.join(dir, 'project');
  fs.cpSync(base.src, src, { recursive: true });
  fs.cpSync(base.project, project, { recursive: true });
  return { src, project, commit: base.commit };
}

function update(src, project, args = []) {
  return spawnSync('bash', [path.join(src, 'update.sh'), project, ...args], {
    encoding: 'utf8',
    cwd: os.tmpdir(),
  });
}

function stamp(project) {
  return JSON.parse(fs.readFileSync(path.join(project, 'hooks', '.eghs-version'), 'utf8'));
}

// Move the checkout forward: an ordinary change, optionally a schema bump.
function addUpstreamCommit(src, { schemaVersion = null, message = 'feat: upstream change' } = {}) {
  fs.appendFileSync(path.join(src, 'hooks', 'lib', 'gate.js'), '\n// upstream marker\n');
  if (schemaVersion !== null) {
    const p = path.join(src, 'hooks', 'lib', 'schema.js');
    fs.writeFileSync(
      p,
      fs.readFileSync(p, 'utf8').replace(/const HOOK_SCHEMA_VERSION = \d+;/, `const HOOK_SCHEMA_VERSION = ${schemaVersion};`)
    );
  }
  return commitAll(src, message);
}

// ---- the version stamp install.sh writes -----------------------------------

test('install.sh stamps the commit and schema version it installed', () => {
  const { project, commit } = scenario();
  const s = stamp(project);
  assert.equal(s.commit, commit);
  // Regression: `node -p` colourises numbers when FORCE_COLOR is set, which
  // used to stamp schema_version as null.
  assert.equal(s.schema_version, 1);
  assert.match(s.installed_at, /^\d{4}-\d{2}-\d{2}T/);
});

// ---- --check reports without writing ---------------------------------------

test('--check on an up-to-date project reports it and changes nothing', () => {
  const { src, project } = scenario();
  const before = fs.readFileSync(path.join(project, 'hooks', 'lib', 'gate.js'), 'utf8');
  const r = update(src, project, ['--check']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Up to date/);
  assert.equal(fs.readFileSync(path.join(project, 'hooks', 'lib', 'gate.js'), 'utf8'), before);
});

test('--check lists the new commits without applying them', () => {
  const { src, project } = scenario();
  addUpstreamCommit(src, { message: 'feat: a brand new thing' });
  const r = update(src, project, ['--check']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /1 new commit/);
  assert.match(r.stdout, /a brand new thing/);
  assert.match(r.stdout, /Update available/);
  assert.doesNotMatch(
    fs.readFileSync(path.join(project, 'hooks', 'lib', 'gate.js'), 'utf8'),
    /upstream marker/
  );
});

// ---- applying ---------------------------------------------------------------

test('an update copies the new hook code and re-stamps the version', () => {
  const { src, project } = scenario();
  const newCommit = addUpstreamCommit(src);
  const r = update(src, project);
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(project, 'hooks', 'lib', 'gate.js'), 'utf8'), /upstream marker/);
  assert.equal(stamp(project).commit, newCommit);
});

test('an up-to-date project is left alone unless --force', () => {
  const { src, project } = scenario();
  const plain = update(src, project);
  assert.equal(plain.status, 0);
  assert.match(plain.stdout, /Already up to date/);
  assert.doesNotMatch(plain.stdout, /Applying the update/);

  const forced = update(src, project, ['--force']);
  assert.equal(forced.status, 0);
  assert.match(forced.stdout, /Applying the update/);
});

test('user config and foreign hooks survive an update', () => {
  const { src, project } = scenario();
  const config = { state_gate_paths: ['src/**/*.ts'], stale_after_seconds: 60 };
  fs.writeFileSync(path.join(project, '.claude', 'eghs.config.json'), JSON.stringify(config));
  const settingsPath = path.join(project, '.claude', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  settings.hooks.PreToolUse.unshift({ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  addUpstreamCommit(src);
  assert.equal(update(src, project).status, 0);

  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(project, '.claude', 'eghs.config.json'), 'utf8')), config);
  const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const commands = after.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(commands.includes('echo mine'));
  assert.equal(commands.filter((c) => c.includes('pre-tool-use.js')).length, 1);
});

// ---- schema bumps ----------------------------------------------------------

test('a schema bump is detected and the migrate instruction is printed', () => {
  const { src, project } = scenario();
  addUpstreamCommit(src, { schemaVersion: 2, message: 'feat!: bump schema' });

  const check = update(src, project, ['--check']);
  assert.match(check.stdout, /state schema v1, this version wants v2/);

  const applied = update(src, project);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /Action required: state schema migration/);
  assert.match(applied.stdout, /migrate\.js/);
});

// The instruction above is only worth printing if it is true: the hooks really
// must deny until migrate runs, and migrate really must fix it.
test('after a schema bump the gate denies SCHEMA_MISMATCH until migrate runs', () => {
  const { src, project } = scenario();
  addUpstreamCommit(src, { schemaVersion: 2, message: 'feat!: bump schema' });
  assert.equal(update(src, project).status, 0);

  fs.writeFileSync(
    path.join(project, '.claude', 'eghs.config.json'),
    JSON.stringify({ state_gate_paths: ['**/*.ts'] })
  );
  const file = path.join(project, 'app.ts');
  fs.writeFileSync(file, 'export const a = 1;\n');
  const hookInput = (sid) =>
    JSON.stringify({ session_id: sid, tool_name: 'Edit', tool_input: { file_path: file }, tool_use_id: 'u' });

  const denied = spawnSync('node', ['hooks/pre-tool-use.js'], {
    cwd: project,
    encoding: 'utf8',
    input: hookInput('dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
  });
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /SCHEMA_MISMATCH/);

  // That hook run left a lease, and migrate refuses while one exists — which
  // is exactly the "close your sessions first" caveat update.sh prints.
  const busy = spawnSync('node', ['hooks/migrate.js'], { cwd: project, encoding: 'utf8' });
  assert.match(busy.stdout + busy.stderr, /active session state remains/);
  spawnSync('node', ['hooks/migrate.js', '--clear-sid', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', '--force'], {
    cwd: project,
    encoding: 'utf8',
  });

  const migrated = spawnSync('node', ['hooks/migrate.js'], { cwd: project, encoding: 'utf8' });
  assert.equal(migrated.status, 0, migrated.stderr);
  assert.equal(
    fs.readFileSync(path.join(project, '.claude', 'state', 'eghs', 'schema_version'), 'utf8').trim(),
    '2'
  );

  const after = spawnSync('node', ['hooks/pre-tool-use.js'], {
    cwd: project,
    encoding: 'utf8',
    input: hookInput('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
  });
  assert.equal(after.status, 2);
  assert.doesNotMatch(after.stderr, /SCHEMA_MISMATCH/);
  assert.match(after.stderr, /UNREAD_OR_STALE/); // back to ordinary gating
});

test('no schema bump says so explicitly', () => {
  const { src, project } = scenario();
  addUpstreamCommit(src);
  const r = update(src, project);
  assert.match(r.stdout, /Schema unchanged/);
  assert.doesNotMatch(r.stdout, /Action required/);
});

// ---- guard rails -----------------------------------------------------------

test('updating a project without EGHS points at install.sh instead', () => {
  const { src } = scenario();
  const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eghs-update-bare-')));
  execFileSync('git', ['init', '-q'], { cwd: bare, stdio: 'ignore' });
  const r = update(src, bare);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no EGHS install found/);
  assert.match(r.stderr, /install\.sh/);
});

test('refuses to target the EGHS checkout itself', () => {
  const { src } = scenario();
  const r = spawnSync('bash', [path.join(src, 'update.sh'), src], { encoding: 'utf8', cwd: os.tmpdir() });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /EGHS repo itself/);
});

test('an unknown option is rejected rather than treated as a path', () => {
  const { src, project } = scenario();
  const r = update(src, project, ['--wat']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown option: --wat/);
});

test('--help exits 0 and touches nothing', () => {
  const r = spawnSync('bash', [UPDATE, '--help'], { encoding: 'utf8', cwd: os.tmpdir() });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage:/);
});

test('a dirty EGHS checkout is not pulled over', () => {
  const { src, project } = scenario();
  addUpstreamCommit(src);
  fs.appendFileSync(path.join(src, 'README.md'), '\nlocal edit\n');
  const r = update(src, project, ['--check']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /uncommitted changes/);
  assert.match(fs.readFileSync(path.join(src, 'README.md'), 'utf8'), /local edit/);
});

test('--no-pull updates straight from the checkout', () => {
  const { src, project } = scenario();
  addUpstreamCommit(src);
  const r = update(src, project, ['--no-pull']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Skipping git pull \(--no-pull\)/);
  assert.match(fs.readFileSync(path.join(project, 'hooks', 'lib', 'gate.js'), 'utf8'), /upstream marker/);
});

test('a missing stamp warns but still updates (installed before stamping existed)', () => {
  const { src, project } = scenario();
  fs.rmSync(path.join(project, 'hooks', '.eghs-version'));
  addUpstreamCommit(src);
  const r = update(src, project);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no hooks\/\.eghs-version stamp/);
  assert.match(fs.readFileSync(path.join(project, 'hooks', 'lib', 'gate.js'), 'utf8'), /upstream marker/);
});
