#!/usr/bin/env bash
# Thin launcher kept so documented invocations and muscle memory still work.
# The sync logic lives in apply-patches.mjs (plain Node, no dependencies) —
# see that file for the guards it adds over the old bash implementation.
# The repo already requires Node >= 24, so `node` is always present here.
command -v node >/dev/null 2>&1 || { echo "node is required (the repo needs Node >= 24)." >&2; exit 1; }
exec node "$(cd "$(dirname "$0")" && pwd)/apply-patches.mjs" "$@"
