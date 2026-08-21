#!/usr/bin/env bash
# Rebuild the fork's integration branch from upstream + the patch queue.
#
#   1. refresh the pristine mirrors (staging, main) from upstream
#   2. rebase every patch branch in patches.list onto the base
#   3. rebuild the integration branch by cherry-picking each patch in order
#
# Nothing is pushed. Review, validate, then push the branches it names.
#
# Usage:
#   tools/fork/apply-patches.sh [options]
#     --no-fetch        skip the upstream fetch (offline / already fetched)
#     --base <ref>      upstream base to build on   (default: upstream/staging)
#     --into <branch>   integration branch to build (default: luma/staging)
#     --check           run `pnpm check` on the result
#     --list            print the patch queue and exit
#     -h, --help
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "Not a git repository." >&2; exit 1; }
cd "$ROOT" || exit 1
LIST="${FORK_PATCH_LIST:-tools/fork/patches.list}"
BASE_REMOTE_REF="${FORK_BASE:-upstream/staging}"
INTEGRATION="${FORK_INTEGRATION:-luma/staging}"
FETCH=1; RUN_CHECK=0

bold=$'\e[1m'; grn=$'\e[32m'; ylw=$'\e[33m'; red=$'\e[31m'; dim=$'\e[2m'; rst=$'\e[0m'
step(){ printf '\n%s==>%s %s\n' "$bold" "$rst" "$*"; }
ok(){   printf '  %s✓%s %s\n' "$grn" "$rst" "$*"; }
warn(){ printf '  %s!%s %s\n' "$ylw" "$rst" "$*"; }
die(){  printf '\n%s✗ %s%s\n' "$red" "$*" "$rst" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --no-fetch) FETCH=0 ;;
    --check)    RUN_CHECK=1 ;;
    --base)     BASE_REMOTE_REF="${2:?--base needs a ref}"; shift ;;
    --into)     INTEGRATION="${2:?--into needs a branch}"; shift ;;
    --list)     grep -vE '^\s*(#|$)' "$LIST"; exit 0 ;;
    -h|--help)  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)          die "Unknown option: $1" ;;
  esac
  shift
done

[ -f "$LIST" ] || die "Patch list not found: $LIST"
BASE_BRANCH="${BASE_REMOTE_REF##*/}"          # upstream/staging -> staging
# Read the queue with a plain read loop, not `mapfile` -- macOS still ships
# bash 3.2, where that builtin does not exist.
PATCHES=()
while IFS= read -r patch_line; do
  PATCHES+=("$patch_line")
done < <(grep -vE '^\s*(#|$)' "$LIST")
[ "${#PATCHES[@]-0}" -gt 0 ] || die "Patch list is empty: $LIST"

# A dirty tree would be silently stashed away by checkout/rebase. Refuse instead.
[ -z "$(git status --porcelain)" ] || die "Working tree is dirty. Commit or stash first."
for state in rebase-merge rebase-apply CHERRY_PICK_HEAD; do
  [ -e ".git/$state" ] && die "A rebase or cherry-pick is already in progress. Finish or abort it first."
done

# CHANGELOG.md is touched by nearly every upstream commit, so a patch that also
# edits it conflicts on every single sync. The entry is noise for the fork (the
# real record is PATCHES.md), so resolve those by keeping the base's version.
# Any other conflicting path is a real conflict and stops the run.
resolve_changelog_only() {
  local conflicted
  conflicted="$(git diff --name-only --diff-filter=U)"
  [ "$conflicted" = "CHANGELOG.md" ] || return 1
  git checkout --ours CHANGELOG.md >/dev/null 2>&1 || return 1
  git add CHANGELOG.md
  return 0
}

step "Base: $BASE_REMOTE_REF   Integration: $INTEGRATION"
printf '  patches: %s\n' "${PATCHES[*]}"

if [ "$FETCH" = "1" ]; then
  step "Fetching upstream"
  git remote get-url upstream >/dev/null 2>&1 \
    || die "No 'upstream' remote. Add it: git remote add upstream https://github.com/Pasta-Devs/Marinara-Engine"
  git fetch upstream || die "Fetch failed."
  ok "fetched"
else
  warn "Skipping fetch (--no-fetch)"
fi

git rev-parse --verify "$BASE_REMOTE_REF" >/dev/null 2>&1 || die "Unknown base ref: $BASE_REMOTE_REF"

step "Refreshing the pristine mirror '$BASE_BRANCH'"
OLD_BASE="$(git rev-parse --verify --quiet "$BASE_BRANCH" || echo '')"
git checkout -q -B "$BASE_BRANCH" "$BASE_REMOTE_REF" || die "Could not reset $BASE_BRANCH"
NEW_BASE="$(git rev-parse HEAD)"
if [ -n "$OLD_BASE" ] && [ "$OLD_BASE" != "$NEW_BASE" ]; then
  ok "$BASE_BRANCH ${OLD_BASE:0:9} → ${NEW_BASE:0:9} ($(git rev-list --count "$OLD_BASE..$NEW_BASE") new commits)"
else
  ok "$BASE_BRANCH at ${NEW_BASE:0:9} (unchanged)"
fi

step "Rebasing patch branches onto $BASE_BRANCH"
for patch in "${PATCHES[@]}"; do
  git rev-parse --verify "$patch" >/dev/null 2>&1 || die "Patch branch does not exist: $patch"
  before="$(git rev-list --count "$BASE_BRANCH..$patch" 2>/dev/null || echo 0)"
  if git rebase "$BASE_BRANCH" "$patch" >/tmp/fork-rebase.log 2>&1; then
    :
  else
    while [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; do
      if resolve_changelog_only; then
        GIT_EDITOR=true git rebase --continue >/tmp/fork-rebase.log 2>&1 || true
      else
        printf '\n%sConflict in %s while rebasing %s onto %s:%s\n' "$red" "$patch" "$patch" "$BASE_BRANCH" "$rst" >&2
        git diff --name-only --diff-filter=U | sed 's/^/    /' >&2
        cat <<EOF >&2

Resolve it by hand, then re-run this script:
    git status                       # see the conflict
    \$EDITOR <file>                   # fix, keeping the patch's intent
    git add <file> && git rebase --continue
    git push --force-with-lease origin $patch

Or abort:  git rebase --abort
EOF
        exit 1
      fi
    done
  fi
  after="$(git rev-list --count "$BASE_BRANCH..$patch")"
  if [ "$after" = "0" ]; then
    warn "$patch is now EMPTY — upstream may have adopted it. Remove it from $LIST and PATCHES.md."
  elif [ "$after" != "$before" ]; then
    ok "$patch rebased ($before → $after commits)"
  else
    ok "$patch rebased ($after commits)"
  fi
done

step "Rebuilding $INTEGRATION from $BASE_BRANCH"
git checkout -q -B "$INTEGRATION" "$BASE_BRANCH" || die "Could not create $INTEGRATION"
for patch in "${PATCHES[@]}"; do
  count="$(git rev-list --count "$BASE_BRANCH..$patch")"
  [ "$count" = "0" ] && { warn "skipping empty $patch"; continue; }
  if git cherry-pick "$BASE_BRANCH..$patch" >/tmp/fork-pick.log 2>&1; then
    ok "applied $patch ($count)"
  else
    while [ -e .git/CHERRY_PICK_HEAD ] || [ -n "$(git diff --name-only --diff-filter=U)" ]; do
      if resolve_changelog_only; then
        GIT_EDITOR=true git cherry-pick --continue >/tmp/fork-pick.log 2>&1 || true
      else
        printf '\n%sConflict applying %s onto %s:%s\n' "$red" "$patch" "$INTEGRATION" "$rst" >&2
        git diff --name-only --diff-filter=U | sed 's/^/    /' >&2
        cat <<EOF >&2

Two patches disagree. Resolve, then:
    git add <file> && git cherry-pick --continue
    tools/fork/apply-patches.sh --no-fetch     # re-run to finish

Or abort:  git cherry-pick --abort
If they conflict every sync, reorder them in $LIST.
EOF
        exit 1
      fi
    done
    ok "applied $patch ($count, CHANGELOG auto-resolved)"
  fi
done

# The running build resolves its upstream base by merge-base against whatever
# remote-tracking refs the checkout happens to have. A deploy clone that has not
# refetched the mirror since the last rebuild would answer with a stale commit,
# so record the base we actually built on and let the build read that instead.
step "Stamping the upstream base onto $INTEGRATION"
cat > fork-base.json <<EOF
{
  "baseRef": "$BASE_REMOTE_REF",
  "baseCommit": "$NEW_BASE",
  "baseBranch": "$BASE_BRANCH"
}
EOF
git add fork-base.json || die "Could not stage fork-base.json"
git commit -q -m "chore(fork): stamp upstream base ${NEW_BASE:0:12}" || die "Could not commit fork-base.json"
ok "fork-base.json → ${NEW_BASE:0:12} ($BASE_REMOTE_REF)"

if [ "$RUN_CHECK" = "1" ]; then
  step "Validating (pnpm check)"
  pnpm install >/dev/null 2>&1 || warn "pnpm install reported a problem"
  if pnpm check; then ok "pnpm check passed"; else die "pnpm check FAILED — do not push."; fi
fi

step "Done"
printf '  %s is %s commits over %s\n' "$INTEGRATION" "$(git rev-list --count "$BASE_BRANCH..$INTEGRATION")" "$BASE_BRANCH"
printf '  %sReview:%s git log --oneline %s..%s\n' "$dim" "$rst" "$BASE_BRANCH" "$INTEGRATION"
printf '  %sDiff  :%s git diff %s...%s\n' "$dim" "$rst" "$BASE_BRANCH" "$INTEGRATION"
cat <<EOF

Nothing has been pushed. When it looks right:
    git push --force-with-lease origin $BASE_BRANCH
$(for p in "${PATCHES[@]}"; do echo "    git push --force-with-lease origin $p"; done)
    git push --force-with-lease origin $INTEGRATION
EOF
