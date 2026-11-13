#!/usr/bin/env bash
# install.sh: install the beebox host tooling (tools/beebox) to its live paths.
#
#   tools/beebox/install.sh                         from this checkout
#   tools/beebox/install.sh --ref REF [--repo DIR]  from a git ref, e.g. origin/patch/fork-tooling
#   ... --diff                                      show what would change; install nothing
#
# Copies, never symlinks: tools/ exists only on patch/fork-tooling, so it vanishes from a
# clone's working tree whenever another branch is checked out (every sync rebase), while
# marinara-sync keeps running from ~/.local/bin. Each file is written to a temp file next to
# its target and moved over it, so a running script keeps its old copy. Unchanged files are
# left alone. The host config (~/.config/marinara/beebox.env) is created from
# beebox.env.example only when missing, never overwritten. Changed units trigger
# `systemctl --user daemon-reload`; a changed guard restarts marinara-guard. Nothing else is restarted or enabled.
set -euo pipefail

ref="" repo="" diff_only=false
while [ $# -gt 0 ]; do
  case $1 in
    --ref) ref=${2:?--ref needs a git ref}; shift 2 ;;
    --repo) repo=${2:?--repo needs a directory}; shift 2 ;;
    --diff) diff_only=true; shift ;;
    *) echo "usage: install.sh [--ref REF [--repo DIR]] [--diff]" >&2; exit 2 ;;
  esac
done
if [ -n "$ref" ]; then
  repo=${repo:-$(git rev-parse --show-toplevel)}
  read_src() { git -C "$repo" show "$ref:tools/beebox/$1"; }
else
  src=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  read_src() { cat "$src/$1"; }
fi

# source (under tools/beebox) | target | mode
FILES=(
  "bin/marinara|$HOME/.local/bin/marinara|755"
  "bin/marinara-sync|$HOME/.local/bin/marinara-sync|755"
  "bin/marinara-rebuild|$HOME/.local/bin/marinara-rebuild|755"
  "bin/marinara-guard|$HOME/.local/bin/marinara-guard|755"
  "claude-prompt.md|$HOME/.config/marinara-sync/claude-prompt.md|644"
  "systemd/marinara-guard.service|$HOME/.config/systemd/user/marinara-guard.service|644"
  "systemd/marinara-sync.service|$HOME/.config/systemd/user/marinara-sync.service|644"
  "systemd/marinara-sync.timer|$HOME/.config/systemd/user/marinara-sync.timer|644"
)

tmp=$(mktemp -d "${TMPDIR:-/tmp}/beebox-install.XXXX")
trap 'rm -rf "$tmp"' EXIT
changed=()
for entry in "${FILES[@]}"; do
  IFS='|' read -r rel dest mode <<<"$entry"
  staged="$tmp/${rel//\//_}"
  read_src "$rel" >"$staged"
  [ -s "$staged" ] || { echo "install.sh: $rel is empty or missing; nothing installed" >&2; exit 1; }
  if [ "$rel" = bin/marinara-guard ]; then
    python3 -c 'import ast, sys; ast.parse(open(sys.argv[1]).read())' "$staged"
  elif [[ $rel == bin/* ]]; then
    bash -n "$staged"
  fi
  if cmp -s "$staged" "$dest" 2>/dev/null; then continue; fi
  changed+=("$rel|$dest|$mode|$staged")
done

# Host config: written from the example only when missing, never overwritten.
conf="$HOME/.config/marinara/beebox.env"
if [ ! -e "$conf" ]; then
  if $diff_only; then echo "would create $conf from beebox.env.example"
  else
    mkdir -p "$(dirname "$conf")"
    read_src beebox.env.example >"$conf.new.$$" && mv -n "$conf.new.$$" "$conf"
    rm -f "$conf.new.$$"
    echo "created $conf"
  fi
fi

if [ ${#changed[@]} -eq 0 ]; then echo "beebox tooling: up to date"; exit 0; fi
for entry in "${changed[@]}"; do
  IFS='|' read -r rel dest mode staged <<<"$entry"
  if $diff_only; then diff -u "$dest" "$staged" --label "$dest" --label "tools/beebox/$rel" || true; continue; fi
  mkdir -p "$(dirname "$dest")"
  cp "$staged" "$dest.new.$$"
  chmod "$mode" "$dest.new.$$"
  mv -f "$dest.new.$$" "$dest"
  echo "installed $dest"
done
$diff_only && exit 0

joined=" ${changed[*]} "
if [[ $joined == *systemd/* ]]; then systemctl --user daemon-reload; fi
if [[ $joined == *marinara-guard* ]]; then systemctl --user try-restart marinara-guard.service; fi
