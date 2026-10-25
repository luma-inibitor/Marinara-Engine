#!/usr/bin/env bash
# Run a command with the repo's Node toolchain inside a container, for hosts
# that run Marinara from a Docker image and have no native Node >= 24 or pnpm.
#
#   tools/fork/in-node.sh pnpm install --frozen-lockfile
#   tools/fork/in-node.sh pnpm check
#
# Uses the Dockerfile's own builder image (plus git and python3), so validation
# runs on the same Node the deploy image builds with. The repo is mounted at its host path and the
# command runs as the calling user, so node_modules and build output stay
# owned by you. Corepack's pnpm and the pnpm store persist in
# ~/.cache/marinara-node-container between runs.
set -euo pipefail
[ $# -gt 0 ] || { echo "usage: $0 <command> [args...]" >&2; exit 2; }
command -v docker >/dev/null 2>&1 || { echo "docker is required." >&2; exit 1; }

repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
base=$(sed -n 's/^FROM \(node:[^ ]*\) AS builder$/\1/p' "$repo/Dockerfile")
[ -n "$base" ] || { echo "no 'FROM node:... AS builder' line in $repo/Dockerfile" >&2; exit 1; }
# Several regression lanes shell out to git or python3, which the slim image
# lacks. Build a derived image once per base image and reuse it.
image="marinara-node-dev:$(printf %s "$base" | sha256sum | cut -c1-12)"
if ! docker image inspect "$image" >/dev/null 2>&1; then
  echo "building $image from $base (one-time)…" >&2
  printf 'FROM %s\nRUN apt-get update && apt-get install -y --no-install-recommends git python3 ca-certificates && rm -rf /var/lib/apt/lists/*\n' "$base" |
    docker build -q -t "$image" - >/dev/null
fi
cache="${MARINARA_NODE_CACHE:-$HOME/.cache/marinara-node-container}"
mkdir -p "$cache/bin"
workdir=$PWD
case "$workdir/" in "$repo"/*) ;; *) workdir=$repo ;; esac
# A linked worktree keeps its git data in the main checkout; mount that too.
mounts=(-v "$repo:$repo")
common=$(cd "$repo" && realpath "$(git rev-parse --git-common-dir)")
case "$common/" in "$repo"/*) ;; *) mounts+=(-v "$common:$common") ;; esac

# label=disable: on SELinux hosts, read the bind mounts without relabeling them
# (:Z would permanently relabel the checkout).
exec docker run --rm -i $([ -t 0 ] && echo -t) \
  --user "$(id -u):$(id -g)" \
  --security-opt label=disable \
  -e HOME=/cache -e CI=true -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -v "$cache:/cache" "${mounts[@]}" -w "$workdir" \
  "$image" \
  bash -c 'corepack enable --install-directory /cache/bin && PATH=/cache/bin:$PATH exec "$@"' in-node "$@"
