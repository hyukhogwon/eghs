#!/usr/bin/env bash
# EGHS installer — clone this repo, then run ./install.sh <your-project>
#
#   git clone https://github.com/hyukhogwon/eghs && cd eghs
#   ./install.sh ~/code/my-project
#
# or from inside the project you want to protect:
#
#   cd ~/code/my-project && ~/src/eghs/install.sh
#
# Re-running upgrades an existing install in place: hook code is replaced,
# your eghs.config.json and any non-EGHS hooks in settings.json are kept.
set -euo pipefail

FS_EXT_VERSION='^2.1.1'
PICOMATCH_VERSION='^4.0.4'

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# --- output -----------------------------------------------------------------

if [ -t 1 ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; R=$'\033[0m'
else
  B=''; DIM=''; RED=''; GREEN=''; YELLOW=''; R=''
fi

step()  { printf '%s==>%s %s\n' "$B" "$R" "$*"; }
ok()    { printf '    %s✓%s %s\n' "$GREEN" "$R" "$*"; }
note()  { printf '    %s%s%s\n' "$DIM" "$*" "$R"; }
warn()  { printf '    %s!%s %s\n' "$YELLOW" "$R" "$*"; }
die()   { printf '%serror:%s %s\n' "$RED" "$R" "$*" >&2; exit 1; }

usage() {
  cat <<EOF
${B}EGHS installer${R} — evidence-gated hooks for Claude Code

usage:
  ./install.sh [target-project-dir]

  target-project-dir   where to install (default: current directory)

The gate ships OFF: installing changes no behaviour until you list globs in
<target>/.claude/eghs.config.json under "state_gate_paths".
EOF
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
esac

# --- resolve target ---------------------------------------------------------

TARGET_ARG="${1:-$PWD}"
[ -d "$TARGET_ARG" ] || die "target is not a directory: $TARGET_ARG"
TARGET="$(cd "$TARGET_ARG" && pwd -P)"

if [ "$TARGET" = "$SRC" ]; then
  usage >&2
  echo >&2
  die "target is the EGHS repo itself. Pass the project you want to protect, e.g. ./install.sh ~/code/my-project"
fi

# --- preflight --------------------------------------------------------------

step "Checking prerequisites"
command -v node >/dev/null 2>&1 || die "node not found — EGHS hooks are Node scripts"
command -v npm  >/dev/null 2>&1 || die "npm not found — needed to install fs-ext/picomatch"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "node >= 18 required (found $(node -v))"
ok "node $(node -v), npm $(npm -v)"

[ -d "$SRC/hooks/lib" ] || die "$SRC/hooks/lib not found — run this script from a full EGHS checkout"

if [ -d "$TARGET/.git" ] || git -C "$TARGET" rev-parse --git-dir >/dev/null 2>&1; then
  IS_GIT=1
  ok "target is a git repo: $TARGET"
else
  IS_GIT=0
  warn "target is not a git repo: $TARGET"
  note "Stop-hook verification scoping uses git; EGHS still runs, but treats the whole tree as changed."
fi

# --- hook code --------------------------------------------------------------

step "Installing hook code into $TARGET/hooks"
mkdir -p "$TARGET/hooks"
# Replace code, preserve hooks/node_modules from a previous install.
rm -rf "$TARGET/hooks/lib"
cp -R "$SRC/hooks/lib" "$TARGET/hooks/lib"
cp "$SRC"/hooks/*.js "$TARGET/hooks/"
ok "$(ls "$SRC"/hooks/*.js | wc -l | tr -d ' ') entrypoints + lib/"

# --- dependencies -----------------------------------------------------------

step "Installing dependencies (fs-ext is a native module — this compiles)"
note "into $TARGET/hooks/node_modules, so your project's package.json is untouched"
if ! npm install --silent --prefix "$TARGET/hooks" \
      "fs-ext@$FS_EXT_VERSION" "picomatch@$PICOMATCH_VERSION" >/dev/null 2>&1; then
  die "dependency install failed. fs-ext needs a C++ toolchain (Xcode CLI tools / build-essential + python3). Retry manually:
  npm install --prefix \"$TARGET/hooks\" fs-ext@$FS_EXT_VERSION picomatch@$PICOMATCH_VERSION"
fi
node -e 'require(process.argv[1])' "$TARGET/hooks/node_modules/fs-ext" \
  || die "fs-ext installed but will not load — the native build is broken for $(node -v)"
ok "fs-ext + picomatch resolve"

# --- settings.json ----------------------------------------------------------

step "Registering hooks in $TARGET/.claude/settings.json"
mkdir -p "$TARGET/.claude"
SETTINGS="$TARGET/.claude/settings.json"

if [ -f "$SETTINGS" ]; then
  BACKUP="$SETTINGS.eghs-backup.$(date +%Y%m%d%H%M%S)"
  cp "$SETTINGS" "$BACKUP"
  note "backed up existing settings to $(basename "$BACKUP")"
fi

# Merge, never clobber: drop any previously-registered EGHS entries (so
# re-running is idempotent and upgrades cleanly), keep every other hook, then
# append ours.
SETTINGS="$SETTINGS" node <<'NODE' || die "could not update settings.json — restore from the backup above"
const fs = require('fs');
const file = process.env.SETTINGS;

let settings = {};
if (fs.existsSync(file)) {
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (raw !== '') {
    try {
      settings = JSON.parse(raw);
    } catch (err) {
      console.error(`existing settings.json is not valid JSON: ${err.message}`);
      process.exit(1);
    }
  }
}
if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
  console.error('existing settings.json is not a JSON object');
  process.exit(1);
}

const ENTRYPOINTS = {
  PreToolUse: { file: 'pre-tool-use.js', matcher: 'Read|Write|Edit|MultiEdit' },
  PostToolUse: { file: 'post-tool-use.js', matcher: 'Read|Write|Edit|MultiEdit' },
  Stop: { file: 'stop.js', matcher: null },
  UserPromptSubmit: { file: 'user-prompt-submit.js', matcher: null },
};
const OURS = /hooks[/\\](pre-tool-use|post-tool-use|stop|user-prompt-submit)\.js/;

const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
for (const [event, { file: script, matcher }] of Object.entries(ENTRYPOINTS)) {
  const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
  // Strip our own commands wherever they appear, then drop groups we emptied.
  const kept = groups
    .map((g) => ({
      ...g,
      hooks: (Array.isArray(g.hooks) ? g.hooks : []).filter(
        (h) => !(h && typeof h.command === 'string' && OURS.test(h.command))
      ),
    }))
    .filter((g) => g.hooks.length > 0);

  const entry = { hooks: [{ type: 'command', command: `node "$CLAUDE_PROJECT_DIR/hooks/${script}"` }] };
  if (matcher !== null) entry.matcher = matcher;
  hooks[event] = [...kept, entry];
}
settings.hooks = hooks;

fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
const foreign = Object.values(hooks).flat().reduce(
  (n, g) => n + g.hooks.filter((h) => !OURS.test(h.command || '')).length, 0
);
console.log(`    registered 4 EGHS hooks${foreign > 0 ? `, preserved ${foreign} existing hook(s)` : ''}`);
NODE
ok "settings.json updated"

# --- config -----------------------------------------------------------------

CONFIG="$TARGET/.claude/eghs.config.json"
if [ -f "$CONFIG" ]; then
  step "Keeping your existing .claude/eghs.config.json"
  note "$(node -e 'const c=require(process.argv[1]);const g=c.state_gate_paths||[];console.log(g.length?`gate is ON for: ${g.join(", ")}`:"gate is OFF (state_gate_paths is empty)")' "$CONFIG")"
else
  step "Writing .claude/eghs.config.json"
  cat > "$CONFIG" <<'JSON'
{
  "state_gate_paths": [],
  "verification_commands": {}
}
JSON
  ok "written with the gate OFF (state_gate_paths: [])"
fi

# --- gitignore --------------------------------------------------------------

if [ "$IS_GIT" -eq 1 ]; then
  step "Updating .gitignore"
  GITIGNORE="$TARGET/.gitignore"
  touch "$GITIGNORE"
  ADDED=0
  for pattern in '.claude/state/' '.claude/eghs-off'; do
    if ! grep -qxF "$pattern" "$GITIGNORE"; then
      printf '%s\n' "$pattern" >> "$GITIGNORE"
      ADDED=$((ADDED + 1))
    fi
  done
  if [ "$ADDED" -gt 0 ]; then
    ok "added $ADDED entry/entries (state holds leases, locks and evidence — never commit it)"
  else
    ok "already ignored"
  fi
fi

# --- bootstrap + verify -----------------------------------------------------

# eghs-init deliberately refuses to run when schema_version already exists —
# bootstrap and upgrade are different roles (PRD §R2.5). On a re-install the
# right call is --repair, which is a no-op when everything is already healthy.
if [ -f "$TARGET/.claude/state/eghs/schema_version" ]; then
  step "Checking the existing state directory"
  (cd "$TARGET" && node hooks/init.js --repair) || die "eghs-init --repair failed"
else
  step "Bootstrapping state directory"
  (cd "$TARGET" && node hooks/init.js) || die "eghs-init failed"
fi

step "Verifying the install end to end"
SMOKE_SID='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
SMOKE_DIR="$TARGET/.claude/state/eghs/.install-smoke"
mkdir -p "$SMOKE_DIR"
SMOKE_FILE="$SMOKE_DIR/probe.txt"
echo 'probe' > "$SMOKE_FILE"

smoke_gate() {
  printf '{"session_id":"%s","tool_name":"Edit","tool_input":{"file_path":"%s"},"tool_use_id":"install-smoke"}' \
    "$SMOKE_SID" "$SMOKE_FILE" \
    | (cd "$TARGET" && node hooks/pre-tool-use.js --dry-run 2>/dev/null)
}

DECISION="$(smoke_gate | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).decision' 2>/dev/null || echo 'ERROR')"
rm -rf "$SMOKE_DIR"
[ "$DECISION" = 'ERROR' ] && die "the hooks are installed but do not run — check the errors above"
ok "hooks execute and return decisions (dry-run said: $DECISION)"

(cd "$TARGET" && node hooks/inspect.js >/dev/null) || die "eghs-inspect failed — state dir is not readable"
ok "state directory is healthy"

# --- done -------------------------------------------------------------------

cat <<EOF

${GREEN}${B}EGHS installed${R} in $TARGET

${B}The gate is OFF.${R} Nothing is blocked yet — hooks only record evidence.
Turn it on by listing globs in ${B}.claude/eghs.config.json${R}:

    { "state_gate_paths": ["src/**/*.ts"] }

Then editing a matched file without reading it first in the same session is
denied. Globs are bash-glob (picomatch), repo-root-relative — nested matches
need a leading ${B}**/${R}.

Useful commands (run inside $TARGET):

    node hooks/inspect.js       dump state / preview a decision
    node hooks/metrics.js       success metrics from the hook logs
    node hooks/init.js --repair self-heal a damaged state dir

Kill switch: ${B}touch .claude/eghs-off${R} or ${B}EGHS_DISABLED=1${R}.
Re-run this installer any time to upgrade the hook code in place.
EOF
