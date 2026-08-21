#!/usr/bin/env bash
# Fixture tests for tools/fork/apply-patches.mjs. Dev-only; not wired into
# `pnpm check`. Run it after touching the sync script:
#
#   bash tools/fork/apply-patches.test.sh
#
# Builds a miniature upstream + origin + working clone in a temp dir, then exercises:
#   T1  happy path: stale local patch fast-forwarded, rebuild succeeds, stamp written
#   T2  diverged local patch branch -> hard stop
#   T3  hotfix commit only on origin/<integration> -> audit hard stop; --skip-audit proceeds
#   T4  CHANGELOG-only conflict auto-resolved during rebase
set -euo pipefail
SCRIPT="${1:-$(cd "$(dirname "$0")" && pwd)/apply-patches.mjs}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/forksync.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
PASS=0; FAIL=0
report(){ if [ "$1" = 0 ]; then PASS=$((PASS+1)); echo "  PASS: $2"; else FAIL=$((FAIL+1)); echo "  FAIL: $2"; fi }

commit(){ # commit <msg> [file [content]]
  local msg="$1" f="${2:-}" content="${3:-$1}"
  if [ -n "$f" ]; then mkdir -p "$(dirname "$f")"; printf '%s\n' "$content" > "$f"; git add "$f"; fi
  git commit -q --allow-empty -m "$msg"
}

build_fixture(){
  rm -rf "$WORK/up.git" "$WORK/or.git" "$WORK/seed" "$WORK/clone"
  git init -q --bare "$WORK/up.git"; git init -q --bare "$WORK/or.git"
  git init -q -b staging "$WORK/seed"; cd "$WORK/seed"
  commit "upstream: base" app.txt "v1"
  commit "upstream: changelog" CHANGELOG.md "## 1.0"
  git remote add upstream "$WORK/up.git"; git remote add origin "$WORK/or.git"
  git push -q upstream staging
  # patch/one: app feature
  git checkout -q -b patch/one
  commit "one: feature A" feature-a.txt "A1"
  # patch/two: touches CHANGELOG.md too (conflict fodder)
  git checkout -q staging; git checkout -q -b patch/two
  commit "two: feature B" feature-b.txt "B1"
  printf '## 1.0 (fork build)\n' > CHANGELOG.md; git add CHANGELOG.md; git commit -q -m "two: changelog note"
  # patch list on patch/tools (applied last, like patch/fork-tooling)
  git checkout -q staging; git checkout -q -b patch/tools
  mkdir -p tools/fork
  printf 'patch/one\npatch/two\npatch/tools\n' > tools/fork/patches.list
  git add tools/fork/patches.list; git commit -q -m "tools: patch list"
  # integration branch: staging + all patches + stamp
  git checkout -q -b luma/staging staging
  git cherry-pick staging..patch/one staging..patch/two >/dev/null 2>&1 || true
  while [ -e .git/CHERRY_PICK_HEAD ]; do git checkout --ours CHANGELOG.md; git add CHANGELOG.md; GIT_EDITOR=true git cherry-pick --continue; done
  git cherry-pick staging..patch/tools >/dev/null
  printf '{\n  "baseRef": "upstream/staging",\n  "baseCommit": "%s",\n  "baseBranch": "staging"\n}\n' "$(git rev-parse staging)" > fork-base.json
  git add fork-base.json; git commit -q -m "chore(fork): stamp upstream base"
  git push -q origin staging patch/one patch/two patch/tools luma/staging
  # upstream advances: app change + CHANGELOG churn (per-sync conflict fodder)
  git checkout -q staging
  commit "upstream: new work" app.txt "v2"
  printf '## 1.1\n## 1.0\n' > CHANGELOG.md; git add CHANGELOG.md; git commit -q -m "upstream: release notes"
  git push -q upstream staging
  git checkout -q luma/staging
  # working clone (the machine that runs the sync)
  git clone -q "$WORK/or.git" "$WORK/clone" 2>/dev/null
  cd "$WORK/clone"
  git remote add upstream "$WORK/up.git"
  for b in staging patch/one patch/two patch/tools luma/staging; do git branch -q "$b" "origin/$b" 2>/dev/null || true; done
  git checkout -q luma/staging
}

echo "== T1: stale local patch branch is fast-forwarded; rebuild + stamp =="
build_fixture
# someone else pushes a second commit to patch/one; this clone's local branch is stale
cd "$WORK/seed"; git checkout -q patch/one; commit "one: feature A2" feature-a2.txt "A2"; git push -q origin patch/one
cd "$WORK/clone"
if node "$SCRIPT" --base upstream/staging >"$WORK/t1.log" 2>&1; then report 0 "run succeeds"; else report 1 "run succeeds (see $WORK/t1.log)"; sed -n '1,60p' "$WORK/t1.log"; fi
grep -q "fast-forwarded to origin" "$WORK/t1.log" && report 0 "stale patch/one fast-forwarded" || report 1 "stale patch/one fast-forwarded"
[ "$(git log luma/staging --format=%s | grep -c 'feature A2')" = 1 ] && report 0 "A2 present in rebuilt integration" || report 1 "A2 present in rebuilt integration"
node -e 'const s=require("fs").readFileSync("fork-base.json","utf8");const j=JSON.parse(s);process.exit(j.patches&&j.patches["patch/one"]&&j.baseCommit?0:1)' && report 0 "stamp records patch heads" || report 1 "stamp records patch heads"
[ "$(git show luma/staging:app.txt)" = "v2" ] && report 0 "built on new upstream base" || report 1 "built on new upstream base"

echo "== T2: diverged local patch branch stops the run =="
build_fixture
cd "$WORK/seed"; git checkout -q patch/one; commit "one: pushed elsewhere" pushed.txt "x"; git push -q origin patch/one
cd "$WORK/clone"; git checkout -q patch/one; commit "one: local only" local.txt "y"; git checkout -q luma/staging
if node "$SCRIPT" --base upstream/staging >"$WORK/t2.log" 2>&1; then report 1 "diverged branch must stop the run"; else report 0 "diverged branch stops the run"; fi
grep -q "DIVERGED" "$WORK/t2.log" && report 0 "divergence named in the error" || report 1 "divergence named in the error"

echo "== T3: integration-only hotfix trips the audit; --skip-audit overrides =="
build_fixture
cd "$WORK/seed"; git checkout -q luma/staging; commit "hotfix: only on integration" hotfix.txt "h"; git push -q origin luma/staging
cd "$WORK/clone"
if node "$SCRIPT" --base upstream/staging >"$WORK/t3.log" 2>&1; then report 1 "audit must stop the run"; else report 0 "audit stops the run"; fi
grep -q "hotfix: only on integration" "$WORK/t3.log" && report 0 "dropped commit is named" || report 1 "dropped commit is named"
git checkout -q luma/staging 2>/dev/null; git reset -q --hard origin/luma/staging 2>/dev/null || true
if node "$SCRIPT" --base upstream/staging --skip-audit >"$WORK/t3b.log" 2>&1; then report 0 "--skip-audit proceeds"; else report 1 "--skip-audit proceeds"; sed -n '1,40p' "$WORK/t3b.log"; fi

echo "== T4: CHANGELOG-only conflict auto-resolves during rebase =="
build_fixture
cd "$WORK/clone"
if node "$SCRIPT" --base upstream/staging >"$WORK/t4.log" 2>&1; then report 0 "run succeeds despite CHANGELOG conflict"; else report 1 "run succeeds despite CHANGELOG conflict"; sed -n '1,60p' "$WORK/t4.log"; fi
[ "$(git show patch/two:CHANGELOG.md)" = "$(git show staging:CHANGELOG.md)" ] && report 0 "patch/two keeps upstream CHANGELOG" || report 1 "patch/two keeps upstream CHANGELOG"
[ "$(git rev-list --count staging..patch/two)" = 1 ] && report 0 "empty changelog commit dropped from patch/two" || report 1 "empty changelog commit dropped from patch/two"
case "$(git log luma/staging --format=%s)" in *"two: feature B"*) report 0 "feature B survives into integration";; *) report 1 "feature B survives into integration";; esac

echo "== T5: upstream adopts a patch; queue empties it; audit stays quiet =="
build_fixture
cd "$WORK/seed"; git checkout -q staging
git cherry-pick "$(git rev-parse patch/one)" >/dev/null
git push -q upstream staging
cd "$WORK/clone"
if node "$SCRIPT" --base upstream/staging >"$WORK/t5.log" 2>&1; then report 0 "run succeeds"; else report 1 "run succeeds"; sed -n '1,60p' "$WORK/t5.log"; fi
grep -q "EMPTY" "$WORK/t5.log" && report 0 "patch/one reported EMPTY (adopted)" || report 1 "patch/one reported EMPTY (adopted)"
[ "$(git show luma/staging:feature-a.txt)" = "A1" ] && report 0 "feature A present via upstream" || report 1 "feature A present via upstream"

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
