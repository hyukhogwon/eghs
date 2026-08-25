#!/usr/bin/env bash
# EGHS updater — pull the latest EGHS and push it into an already-installed
# project.
#
#   cd ~/src/eghs
#   ./update.sh ~/code/my-project          update it
#   ./update.sh ~/code/my-project --check  report what would change, write nothing
#
# Use install.sh for a project that does not have EGHS yet. This script does
# the three things install.sh cannot: fetch new upstream code, show the delta
# against what is installed, and tell you when a schema bump means the state
# dir needs `eghs-migrate` before the hooks will work again.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# --- output -----------------------------------------------------------------

if [ -t 1 ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; R=$'\033[0m'
else
  B=''; DIM=''; RED=''; GREEN=''; YELLOW=''; R=''
fi

step() { printf '%s==>%s %s\n' "$B" "$R" "$*"; }
ok()   { printf '    %s✓%s %s\n' "$GREEN" "$R" "$*"; }
note() { printf '    %s%s%s\n' "$DIM" "$*" "$R"; }
warn() { printf '    %s!%s %s\n' "$YELLOW" "$R" "$*"; }
die()  { printf '%serror:%s %s\n' "$RED" "$R" "$*" >&2; exit 1; }

usage() {
  cat <<EOF
${B}EGHS updater${R} — refresh an installed project against this checkout

usage:
  ./update.sh [target-project-dir] [--check] [--no-pull] [--force]

  target-project-dir   project to update (default: current directory)
  --check              report the delta and exit; writes nothing
  --no-pull            skip 'git pull' and update from this checkout as-is
  --force              re-install even when the target is already up to date

Use ${B}install.sh${R} for a project that does not have EGHS yet.
EOF
}

# --- args -------------------------------------------------------------------

TARGET_ARG=''
CHECK_ONLY=0
NO_PULL=0
FORCE=0

for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    --check)   CHECK_ONLY=1 ;;
    --no-pull) NO_PULL=1 ;;
    --force)   FORCE=1 ;;
    -*)        usage >&2; echo >&2; die "unknown option: $arg" ;;
    *)
      [ -z "$TARGET_ARG" ] || die "more than one target given: $TARGET_ARG and $arg"
      TARGET_ARG="$arg"
      ;;
  esac
done

[ -n "$TARGET_ARG" ] || TARGET_ARG="$PWD"
[ -d "$TARGET_ARG" ] || die "target is not a directory: $TARGET_ARG"
TARGET="$(cd "$TARGET_ARG" && pwd -P)"
if [ "$TARGET" = "$SRC" ]; then
  usage >&2
  echo >&2
  die "target is the EGHS repo itself. Pass the project you want to update."
fi

[ -x "$SRC/install.sh" ] || die "$SRC/install.sh not found — run this from a full EGHS checkout"

# --- the target must already have EGHS --------------------------------------

step "Checking the target install"
if [ ! -f "$TARGET/hooks/pre-tool-use.js" ]; then
  die "no EGHS install found in $TARGET (hooks/pre-tool-use.js is missing).
Install it first:
  $SRC/install.sh \"$TARGET\""
fi

# Read the stamp with readFileSync + JSON.parse, not require(): the file has
# no .json extension, so require() cannot infer its type and throws.
stamp_field() {
  STAMP_PATH="$STAMP" FIELD="$1" node -e '
    const fs = require("fs");
    try {
      const v = JSON.parse(fs.readFileSync(process.env.STAMP_PATH, "utf8"))[process.env.FIELD];
      process.stdout.write(v === undefined || v === null ? "unknown" : String(v));
    } catch {
      process.stdout.write("unknown");
    }
  ' 2>/dev/null || echo 'unknown'
}

STAMP="$TARGET/hooks/.eghs-version"
if [ -f "$STAMP" ]; then
  OLD_COMMIT="$(stamp_field commit)"
  OLD_INSTALLED="$(stamp_field installed_at)"
  ok "installed: $(printf '%.12s' "$OLD_COMMIT") ($OLD_INSTALLED)"
else
  # Installed by a pre-stamp version of install.sh, or by hand.
  OLD_COMMIT='unknown'
  OLD_INSTALLED='unknown'
  warn "no hooks/.eghs-version stamp — installed before stamping existed, or by hand"
  note "the delta below cannot be computed; the update itself still works"
fi

# The state dir's schema is what the CURRENTLY INSTALLED hooks bootstrapped;
# a newer schema in this checkout is the case that needs eghs-migrate.
TARGET_SCHEMA='none'
if [ -f "$TARGET/.claude/state/eghs/schema_version" ]; then
  TARGET_SCHEMA="$(tr -d '[:space:]' < "$TARGET/.claude/state/eghs/schema_version")"
fi

# --- pull -------------------------------------------------------------------

if [ "$NO_PULL" -eq 1 ]; then
  step "Skipping git pull (--no-pull)"
elif ! git -C "$SRC" rev-parse --git-dir >/dev/null 2>&1; then
  step "Skipping git pull"
  note "$SRC is not a git checkout (downloaded archive?) — updating from it as-is"
elif [ -n "$(git -C "$SRC" status --porcelain 2>/dev/null)" ]; then
  step "Skipping git pull"
  warn "$SRC has uncommitted changes — not pulling over them"
  note "updating from the working tree as it stands; commit or stash, then re-run to fetch upstream"
elif ! git -C "$SRC" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  # No tracking branch: a local-only branch or a checkout with no remote has
  # nothing to pull. That is a normal state, not a failure — only a pull that
  # was actually possible and then broke deserves an abort.
  step "Skipping git pull"
  note "$(git -C "$SRC" rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'HEAD') has no upstream branch — updating from this checkout as-is"
else
  step "Pulling the latest EGHS into $SRC"
  if ! git -C "$SRC" pull --ff-only 2>&1 | sed 's/^/    /'; then
    die "git pull failed. Resolve it in $SRC, or re-run with --no-pull to update from the checkout as-is."
  fi
  ok "checkout is at $(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || echo '?')"
fi

NEW_COMMIT="$(git -C "$SRC" rev-parse HEAD 2>/dev/null || echo 'unknown')"
NEW_SCHEMA="$(node -e "process.stdout.write(String(require('$SRC/hooks/lib/schema.js').HOOK_SCHEMA_VERSION))")"

# --- delta ------------------------------------------------------------------

step "Comparing"
UP_TO_DATE=0
if [ "$OLD_COMMIT" = 'unknown' ] || [ "$NEW_COMMIT" = 'unknown' ]; then
  note "commit delta unavailable (one side is unstamped or not a git checkout)"
elif [ "$OLD_COMMIT" = "$NEW_COMMIT" ]; then
  UP_TO_DATE=1
  ok "already at $(printf '%.12s' "$NEW_COMMIT") — no new commits"
elif git -C "$SRC" merge-base --is-ancestor "$OLD_COMMIT" "$NEW_COMMIT" 2>/dev/null; then
  COUNT="$(git -C "$SRC" rev-list --count "$OLD_COMMIT..$NEW_COMMIT" 2>/dev/null || echo '?')"
  ok "$COUNT new commit(s):"
  git -C "$SRC" log --oneline --no-decorate "$OLD_COMMIT..$NEW_COMMIT" 2>/dev/null \
    | head -20 | sed 's/^/      /'
  # A bare `A && B && note ...` would make set -e kill the script whenever the
  # condition is false, which is the common case.
  if [ "$COUNT" != '?' ] && [ "$COUNT" -gt 20 ]; then
    note "... and $((COUNT - 20)) more"
  fi
else
  warn "installed commit $(printf '%.12s' "$OLD_COMMIT") is not an ancestor of $(printf '%.12s' "$NEW_COMMIT")"
  note "history was rewritten, or the install came from a different branch — proceeding anyway"
fi

SCHEMA_BUMP=0
if [ "$TARGET_SCHEMA" = 'none' ]; then
  note "target has no state dir yet — it will be bootstrapped"
elif [ "$TARGET_SCHEMA" = "$NEW_SCHEMA" ]; then
  ok "state schema v$TARGET_SCHEMA matches this version"
else
  SCHEMA_BUMP=1
  warn "state schema v$TARGET_SCHEMA, this version wants v$NEW_SCHEMA"
fi

# Migrate refuses to run while any session lease is live, so knowing this
# BEFORE the update is what makes the instruction at the end actionable.
LIVE_SESSIONS=0
SESSIONS_DIR="$TARGET/.claude/state/eghs/sessions"
if [ -d "$SESSIONS_DIR" ]; then
  LIVE_SESSIONS="$(find "$SESSIONS_DIR" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l | tr -d ' ')"
fi
if [ "$LIVE_SESSIONS" -gt 0 ]; then
  warn "$LIVE_SESSIONS session lease(s) present — close Claude Code sessions on this project first"
  note "hook code is swapped underneath a running session, and eghs-migrate refuses while leases exist"
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  echo
  if [ "$UP_TO_DATE" -eq 1 ] && [ "$SCHEMA_BUMP" -eq 0 ]; then
    printf '%sUp to date.%s Nothing to do.\n' "$GREEN$B" "$R"
  else
    printf '%sUpdate available.%s Re-run without --check to apply.\n' "$YELLOW$B" "$R"
  fi
  exit 0
fi

if [ "$UP_TO_DATE" -eq 1 ] && [ "$SCHEMA_BUMP" -eq 0 ] && [ "$FORCE" -eq 0 ]; then
  echo
  printf '%sAlready up to date.%s Use --force to re-install anyway.\n' "$GREEN$B" "$R"
  exit 0
fi

# --- apply ------------------------------------------------------------------

# install.sh is the single implementation of "put EGHS into this directory" —
# it already replaces hook code, reinstalls deps, re-merges settings.json
# idempotently and keeps eghs.config.json. Duplicating that here would mean
# two copies to keep in step.
echo
step "Applying the update"
note "delegating to install.sh (idempotent: config and foreign hooks are preserved)"
echo
"$SRC/install.sh" "$TARGET"

# --- schema follow-up -------------------------------------------------------

echo
if [ "$SCHEMA_BUMP" -eq 1 ]; then
  cat <<EOF
${YELLOW}${B}Action required: state schema migration${R}

The hooks are now v$NEW_SCHEMA but the state dir is still v$TARGET_SCHEMA. Until they
match, every gated Write/Edit denies with ${B}SCHEMA_MISMATCH${R} (read-only fallback).

Close any Claude Code session on this project, then:

    cd "$TARGET"
    node hooks/migrate.js --dry-run   # trace the plan, writes nothing
    node hooks/migrate.js             # sessions GC -> record wipe -> version bump

Migrate requires an idle project: it only runs when no session lease is left.
EOF
else
  printf '%s%sUpdate complete.%s Schema unchanged (v%s) — no migration needed.\n' \
    "$GREEN" "$B" "$R" "$NEW_SCHEMA"
fi
