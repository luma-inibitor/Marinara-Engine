#!/data/data/com.termux/files/usr/bin/bash
# Marinara Engine — Termux two-clone switcher installer.
#
# Sets up a fork clone + a stock mainline clone that share one data directory,
# installs the `marinara` switcher command, and creates Termux:Widget shortcuts.
# Idempotent: safe to re-run to repair or update the setup.
#
# Bootstrap (run these two lines in Termux):
#   git clone --branch luma/main https://github.com/luma-inibitor/Marinara-Engine "$HOME/Marinara-fork"
#   bash "$HOME/Marinara-fork/tools/termux/install.sh"
set -uo pipefail

FORK_DIR="${MARINARA_FORK_DIR:-$HOME/Marinara-fork}"
MAIN_DIR="${MARINARA_MAIN_DIR:-$HOME/Marinara-main}"
DATA_DIR_SHARED="${MARINARA_DATA_DIR:-$HOME/marinara-data}"
OLD_APK_CLONE="${MARINARA_OLD_CLONE:-$HOME/Marinara-Engine}"
MAIN_REMOTE="${MARINARA_MAIN_REMOTE:-https://github.com/Pasta-Devs/Marinara-Engine}"
MAIN_BRANCH="${MARINARA_MAIN_BRANCH:-main}"
BIN_DIR="$HOME/.local/bin"
SHORTCUTS_DIR="$HOME/.shortcuts"
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"

grn=$'\e[32m'; ylw=$'\e[33m'; red=$'\e[31m'; bold=$'\e[1m'; dim=$'\e[2m'; rst=$'\e[0m'
step(){ printf '\n%s==>%s %s\n' "$bold" "$rst" "$*"; }
ok(){   printf '  %s✓%s %s\n' "$grn" "$rst" "$*"; }
warn(){ printf '  %s!%s %s\n' "$ylw" "$rst" "$*"; }
die(){  printf '%s✗ %s%s\n' "$red" "$*" "$rst" >&2; exit 1; }
ask(){  local p="$1" a; printf '%s [y/N]: ' "$p"; read -r a || a=""; [ "$a" = y ] || [ "$a" = Y ]; }

set_env_var(){ # file key value — idempotent (replace existing line or append)
  local file="$1" key="$2" val="$3"
  touch "$file"
  grep -v -E "^${key}=" "$file" > "$file.tmp" 2>/dev/null || true
  mv "$file.tmp" "$file"
  printf '%s=%s\n' "$key" "$val" >> "$file"
}

[ -d "$FORK_DIR/.git" ]   || die "Expected the fork clone at $FORK_DIR. Clone it first (see the bootstrap lines at the top of this file)."
[ -f "$SELF_DIR/marinara" ] || die "Can't find the switcher next to this installer ($SELF_DIR/marinara)."

printf '%sMarinara two-clone switcher setup%s\n' "$bold" "$rst"
cat <<EOF
This will set up:
  • Fork clone     : $FORK_DIR   (custom, branch luma/main)
  • Mainline clone : $MAIN_DIR   (stock upstream, branch $MAIN_BRANCH)
  • Shared data    : $DATA_DIR_SHARED   (both clones read/write the same chats)
  • Command        : $BIN_DIR/marinara
  • Home shortcuts : "$SHORTCUTS_DIR/Marinara Fork", "$SHORTCUTS_DIR/Marinara Mainline"
EOF
ask "Proceed?" || die "Aborted."

# ── 1. Shared data dir + one-time migration ──
step "Setting up shared data at $DATA_DIR_SHARED"
if [ -d "$DATA_DIR_SHARED" ] && [ -n "$(ls -A "$DATA_DIR_SHARED" 2>/dev/null)" ]; then
  ok "Already exists and is non-empty — leaving it untouched."
elif [ -d "$OLD_APK_CLONE/packages/server/data" ] && [ -n "$(ls -A "$OLD_APK_CLONE/packages/server/data" 2>/dev/null)" ]; then
  warn "Found existing chats at $OLD_APK_CLONE/packages/server/data"
  if ask "Move them to $DATA_DIR_SHARED (recommended — keeps all your chats)?"; then
    mkdir -p "$(dirname "$DATA_DIR_SHARED")"
    mv "$OLD_APK_CLONE/packages/server/data" "$DATA_DIR_SHARED" || die "Move failed."
    ok "Migrated existing data → $DATA_DIR_SHARED"
  else
    mkdir -p "$DATA_DIR_SHARED"; warn "Started an empty shared data dir instead."
  fi
else
  mkdir -p "$DATA_DIR_SHARED"; ok "Created an empty shared data dir."
fi

# ── 2. Mainline clone (reuse the APK's clone if present, to avoid a re-download) ──
step "Setting up the mainline clone at $MAIN_DIR"
if [ -d "$MAIN_DIR/.git" ]; then
  ok "Already present."
elif [ -d "$OLD_APK_CLONE/.git" ] && ask "Reuse existing $OLD_APK_CLONE as the mainline clone (rename to $MAIN_DIR, no re-download)?"; then
  mv "$OLD_APK_CLONE" "$MAIN_DIR" || die "Rename failed."
  git -C "$MAIN_DIR" remote set-url origin "$MAIN_REMOTE" 2>/dev/null || git -C "$MAIN_DIR" remote add origin "$MAIN_REMOTE"
  git -C "$MAIN_DIR" fetch --quiet origin "$MAIN_BRANCH" || warn "Fetch failed (offline?)."
  git -C "$MAIN_DIR" checkout -B "$MAIN_BRANCH" "origin/$MAIN_BRANCH" 2>/dev/null \
    || git -C "$MAIN_DIR" checkout -f -B "$MAIN_BRANCH" "origin/$MAIN_BRANCH" 2>/dev/null \
    || warn "Could not check out $MAIN_BRANCH — do it manually in $MAIN_DIR."
  ok "Reused the existing clone as mainline."
else
  git clone --branch "$MAIN_BRANCH" "$MAIN_REMOTE" "$MAIN_DIR" || die "Clone failed."
  ok "Cloned stock mainline."
fi

# ── 3. .env for both clones ──
step "Writing .env (shared DATA_DIR; unsandboxed shell only on the fork)"
set_env_var "$FORK_DIR/.env" DATA_DIR "$DATA_DIR_SHARED"
set_env_var "$FORK_DIR/.env" MARINARA_MARI_ALLOW_UNSANDBOXED_SHELL true
ok "Fork .env → DATA_DIR + MARINARA_MARI_ALLOW_UNSANDBOXED_SHELL=true"
set_env_var "$MAIN_DIR/.env" DATA_DIR "$DATA_DIR_SHARED"
ok "Mainline .env → DATA_DIR (flag omitted; stock code ignores it anyway)"

# ── 4. Install the switcher command ──
step "Installing the 'marinara' command to $BIN_DIR"
mkdir -p "$BIN_DIR"
install -m 755 "$SELF_DIR/marinara" "$BIN_DIR/marinara" || die "Install failed."
ok "Installed $BIN_DIR/marinara"
case ":$PATH:" in
  *":$BIN_DIR:"*) : ;;
  *)
    if ! grep -qs '\.local/bin' "$HOME/.bashrc" 2>/dev/null; then
      printf '\n# added by marinara installer\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$HOME/.bashrc"
      warn "Added ~/.local/bin to PATH in ~/.bashrc — run 'source ~/.bashrc' or restart Termux to type 'marinara' directly."
    fi
    ;;
esac

# ── 5. Termux:Widget home-screen shortcuts ──
step "Creating home-screen shortcuts in $SHORTCUTS_DIR"
mkdir -p "$SHORTCUTS_DIR"
cat > "$SHORTCUTS_DIR/Marinara Fork" <<SH
#!/data/data/com.termux/files/usr/bin/bash
exec "$BIN_DIR/marinara" fork
SH
cat > "$SHORTCUTS_DIR/Marinara Mainline" <<SH
#!/data/data/com.termux/files/usr/bin/bash
exec "$BIN_DIR/marinara" main
SH
chmod 755 "$SHORTCUTS_DIR/Marinara Fork" "$SHORTCUTS_DIR/Marinara Mainline"
ok "Created 'Marinara Fork' and 'Marinara Mainline' shortcuts"

cat <<EOF

${bold}${grn}Done.${rst}

Next steps:
  • Terminal: type ${bold}marinara${rst} for the menu, or ${bold}marinara fork${rst} / ${bold}marinara main${rst}.
  • Home screen: install ${bold}Termux:Widget${rst} from F-Droid, add its widget to your
    home screen, then tap "Marinara Fork" or "Marinara Mainline".
  • First launch of each channel installs deps + builds (a few minutes on mobile);
    subsequent launches are quick.
  • The APK is just the viewer — start the server here first, then open the APK.
    Do NOT use the APK's "Install / Start" button: it force-checks-out stock into
    $OLD_APK_CLONE and bypasses this setup.

Your chats live in ${bold}$DATA_DIR_SHARED${rst} and are shared by both channels.
EOF
