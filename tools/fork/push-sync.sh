#!/usr/bin/env bash
# Thin launcher, like apply-patches.sh: the logic lives in push-sync.mjs.
command -v node >/dev/null 2>&1 || { echo "node is required." >&2; exit 1; }
exec node "$(cd "$(dirname "$0")" && pwd)/push-sync.mjs" "$@"
