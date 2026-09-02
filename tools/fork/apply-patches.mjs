#!/usr/bin/env node
// Rebuild the fork's integration branch from upstream + the patch queue.
//
//   1. refresh refs: fetch upstream AND origin, then refresh the pristine mirror
//   2. freshness guard: fast-forward stale local patch branches to origin,
//      refuse to build from a diverged one
//   3. rebase every patch branch in patches.list onto the base
//   4. audit the old integration branch for commits the rebuild would drop
//   5. rebuild the integration branch by cherry-picking each patch in order
//   6. stamp fork-base.json (upstream base + the patch heads built from)
//
// Nothing is pushed. Review, validate, then push the branches it names.
//
// Usage:
//   tools/fork/apply-patches.sh [options]        (thin launcher for this file)
//     --no-fetch        skip fetching upstream/origin (offline / already fetched)
//     --base <ref>      upstream base to build on   (default: upstream/staging)
//     --into <branch>   integration branch to build (default: luma/staging)
//     --check           run `pnpm check` on the result
//     --skip-audit      proceed even if the audit finds commits that would be dropped
//     --list            print the patch queue and exit
//     -h, --help
//
// Environment: FORK_PATCH_LIST, FORK_BASE, FORK_INTEGRATION override the defaults.
//
// Every git invocation uses argv arrays (no shell), and every destructive step
// is preceded by an explicit guard — this file replaced a bash script whose
// silent failure mode (rebuilding from stale local branches) twice dropped
// pushed commits.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// small runners — no shell anywhere
// ---------------------------------------------------------------------------

/** Run git with argv array; returns { status, out, err } and never throws. */
function git(...args) {
  const res = spawnSync("git", args, { encoding: "utf8" });
  if (res.error) return { status: 127, out: "", err: String(res.error.message ?? res.error) };
  return { status: res.status ?? 1, out: (res.stdout ?? "").trimEnd(), err: (res.stderr ?? "").trimEnd() };
}

/** Run git; die with context on failure; return trimmed stdout. */
function gitOut(...args) {
  const res = git(...args);
  if (res.status !== 0) die(`git ${args.join(" ")} failed:\n${res.err || res.out}`);
  return res.out;
}

/** Run git; true iff exit 0. */
function gitOk(...args) {
  return git(...args).status === 0;
}

/** Run git with stdin piped in; returns trimmed stdout ("" on failure). */
function gitWithInput(input, ...args) {
  const res = spawnSync("git", args, { encoding: "utf8", input });
  if (res.error || (res.status ?? 1) !== 0) return "";
  return (res.stdout ?? "").trim();
}

/** Run an arbitrary command streaming to the terminal; true iff exit 0. */
function runInherit(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: "inherit" });
  return !res.error && res.status === 0;
}

// ---------------------------------------------------------------------------
// output helpers
// ---------------------------------------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const ESC = "\u001b";
const c = (code, s) => (useColor ? `${ESC}[${code}m${s}${ESC}[0m` : s);
const bold = (s) => c("1", s);
const grn = (s) => c("32", s);
const ylw = (s) => c("33", s);
const red = (s) => c("31", s);
const dim = (s) => c("2", s);

function step(msg) {
  console.log(`\n${bold("==>")} ${msg}`);
}
function ok(msg) {
  console.log(`  ${grn("✓")} ${msg}`);
}
function warn(msg) {
  console.log(`  ${ylw("!")} ${msg}`);
}
function die(msg) {
  console.error(`\n${red(`✗ ${msg}`)}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const opts = {
  fetch: true,
  check: false,
  skipAudit: false,
  list: false,
  base: process.env.FORK_BASE || "upstream/staging",
  into: process.env.FORK_INTEGRATION || "luma/staging",
  listPath: process.env.FORK_PATCH_LIST || "tools/fork/patches.list",
};

{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--no-fetch") opts.fetch = false;
    else if (arg === "--check") opts.check = true;
    else if (arg === "--skip-audit") opts.skipAudit = true;
    else if (arg === "--list") opts.list = true;
    else if (arg === "--base") opts.base = argv[++i] ?? die("--base needs a ref");
    else if (arg === "--into") opts.into = argv[++i] ?? die("--into needs a branch");
    else if (arg === "-h" || arg === "--help") {
      const self = readFileSync(new URL(import.meta.url), "utf8");
      for (const line of self.split("\n").slice(1, 26)) console.log(line.replace(/^\/\/ ?/, ""));
      process.exit(0);
    } else die(`Unknown option: ${arg}`);
  }
}

// ---------------------------------------------------------------------------
// preflight
// ---------------------------------------------------------------------------

const rootRes = git("rev-parse", "--show-toplevel");
if (rootRes.status !== 0) die("Not a git repository.");
process.chdir(rootRes.out);

if (!existsSync(opts.listPath)) die(`Patch list not found: ${opts.listPath}`);
const patches = readFileSync(opts.listPath, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));
if (patches.length === 0) die(`Patch list is empty: ${opts.listPath}`);

if (opts.list) {
  for (const p of patches) console.log(p);
  process.exit(0);
}

const baseBranch = opts.base.split("/").pop(); // upstream/staging -> staging

// A dirty tree would be silently stashed away by checkout/rebase. Refuse instead.
if (gitOut("status", "--porcelain") !== "") die("Working tree is dirty. Commit or stash first.");
for (const state of ["rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD"]) {
  if (existsSync(path.join(gitOut("rev-parse", "--git-dir"), state)))
    die("A rebase or cherry-pick is already in progress. Finish or abort it first.");
}

step(`Base: ${opts.base}   Integration: ${opts.into}`);
console.log(`  patches: ${patches.join(" ")}`);

// ---------------------------------------------------------------------------
// fetch — BOTH remotes. Fetching only upstream is how the old script ended up
// rebuilding from stale local patch branches while the lease still passed.
// ---------------------------------------------------------------------------

if (opts.fetch) {
  step("Fetching upstream and origin");
  if (!gitOk("remote", "get-url", "upstream"))
    die("No 'upstream' remote. Add it: git remote add upstream https://github.com/Pasta-Devs/Marinara-Engine");
  if (!gitOk("fetch", "upstream")) die("Fetch from upstream failed.");
  if (!gitOk("remote", "get-url", "origin")) die("No 'origin' remote.");
  if (!gitOk("fetch", "origin", "--prune")) die("Fetch from origin failed.");
  ok("fetched upstream + origin");
} else {
  warn("Skipping fetch (--no-fetch) — the freshness guard is only as good as your last fetch");
}

if (!gitOk("rev-parse", "--verify", `${opts.base}^{commit}`)) die(`Unknown base ref: ${opts.base}`);

// ---------------------------------------------------------------------------
// pristine mirror
// ---------------------------------------------------------------------------

step(`Refreshing the pristine mirror '${baseBranch}'`);
const oldBase = gitOk("rev-parse", "--verify", "--quiet", baseBranch)
  ? gitOut("rev-parse", "--verify", baseBranch)
  : "";
if (!gitOk("checkout", "-q", "-B", baseBranch, opts.base)) die(`Could not reset ${baseBranch}`);
const newBase = gitOut("rev-parse", "HEAD");
if (oldBase && oldBase !== newBase) {
  const count = gitOut("rev-list", "--count", `${oldBase}..${newBase}`);
  ok(`${baseBranch} ${oldBase.slice(0, 9)} → ${newBase.slice(0, 9)} (${count} new commits)`);
} else {
  ok(`${baseBranch} at ${newBase.slice(0, 9)} (unchanged)`);
}

// ---------------------------------------------------------------------------
// freshness guard — never rebuild from a local branch that is behind or has
// diverged from its pushed counterpart. This is the guard whose absence let
// two syncs drop pushed commits.
// ---------------------------------------------------------------------------

/** True when `sha` appears anywhere in the local branch's reflog. */
function reflogContains(branch, sha) {
  const out = git("reflog", "show", "--format=%H", branch).out;
  return out ? out.split("\n").includes(sha) : false;
}

step("Checking patch branches against origin");
for (const patch of patches) {
  const localExists = gitOk("rev-parse", "--verify", "--quiet", `refs/heads/${patch}`);
  const remoteExists = gitOk("rev-parse", "--verify", "--quiet", `refs/remotes/origin/${patch}`);
  if (!localExists && !remoteExists) die(`Patch branch does not exist locally or on origin: ${patch}`);
  if (!remoteExists) {
    warn(`${patch} has no origin counterpart (new patch?) — building from the local branch`);
    continue;
  }
  if (!localExists) {
    gitOut("branch", patch, `origin/${patch}`);
    ok(`${patch} created from origin/${patch}`);
    continue;
  }
  const local = gitOut("rev-parse", patch);
  const remote = gitOut("rev-parse", `origin/${patch}`);
  if (local === remote) {
    ok(`${patch} matches origin`);
  } else if (gitOk("merge-base", "--is-ancestor", patch, `origin/${patch}`)) {
    gitOut("branch", "-f", patch, `origin/${patch}`);
    ok(`${patch} fast-forwarded to origin (${local.slice(0, 9)} → ${remote.slice(0, 9)})`);
  } else if (gitOk("merge-base", "--is-ancestor", `origin/${patch}`, patch)) {
    warn(`${patch} is ahead of origin (unpushed local work) — it will be included`);
  } else if (reflogContains(patch, remote)) {
    // The same rule as `git push --force-if-includes`: a rewrite is safe when
    // the remote tip passed through this branch (e.g. the rebase of a prior,
    // interrupted run of this script). Nothing origin has was left unseen.
    warn(`${patch} was rewritten locally from origin's tip (prior run?) — building from the local branch`);
  } else {
    die(
      `${patch} has DIVERGED from origin/${patch}.\n` +
        `Someone pushed work this clone never integrated — rebuilding now would drop it.\n` +
        `Inspect:   git log --oneline --left-right origin/${patch}...${patch}\n` +
        `Reconcile: rebase or cherry-pick your local commits onto origin/${patch}, then re-run.`,
    );
  }
}

// ---------------------------------------------------------------------------
// conflict auto-resolution, shared by rebase and cherry-pick
//
// CHANGELOG.md is touched by nearly every upstream commit, so a patch that also
// edits it conflicts on every single sync. The entry is noise for the fork (the
// real record is PATCHES.md), so resolve those by keeping the base's version.
// Any other conflicting path is a real conflict and stops the run.
// ---------------------------------------------------------------------------

function conflictedFiles() {
  const out = git("diff", "--name-only", "--diff-filter=U").out;
  return out ? out.split("\n").filter(Boolean) : [];
}

function resolveChangelogOnly() {
  const conflicted = conflictedFiles();
  if (conflicted.length !== 1 || conflicted[0] !== "CHANGELOG.md") return false;
  if (!gitOk("checkout", "--ours", "CHANGELOG.md")) return false;
  return gitOk("add", "CHANGELOG.md");
}

function inProgress(kind) {
  const gitDir = gitOut("rev-parse", "--git-dir");
  if (kind === "rebase")
    return existsSync(path.join(gitDir, "rebase-merge")) || existsSync(path.join(gitDir, "rebase-apply"));
  return existsSync(path.join(gitDir, "CHERRY_PICK_HEAD")) || conflictedFiles().length > 0;
}

/**
 * Drive a rebase/cherry-pick to completion, auto-resolving CHANGELOG-only
 * conflicts. Returns true when done; on a real conflict prints guidance and
 * exits. `continueArgs` is ["rebase","--continue"] or ["cherry-pick","--continue"].
 */
function driveToCompletion(kind, continueArgs, onRealConflict) {
  let guard = 0;
  while (inProgress(kind)) {
    if (guard++ > 500) die(`Auto-resolution loop did not converge during ${kind} — aborting for safety.`);
    if (resolveChangelogOnly()) {
      spawnSync("git", continueArgs, { encoding: "utf8", env: { ...process.env, GIT_EDITOR: "true" } });
    } else if (conflictedFiles().length === 0) {
      // e.g. a commit became empty after auto-resolution — skip it and keep going
      if (!gitOk("-c", "core.editor=true", kind === "rebase" ? "rebase" : "cherry-pick", "--skip")) break;
    } else {
      onRealConflict();
      process.exit(1);
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// rebase the queue
// ---------------------------------------------------------------------------

step(`Rebasing patch branches onto ${baseBranch}`);
for (const patch of patches) {
  const before = git("rev-list", "--count", `${baseBranch}..${patch}`).out || "0";
  const rebaseRes = git("rebase", baseBranch, patch);
  if (rebaseRes.status !== 0) {
    if (!inProgress("rebase")) die(`git rebase ${baseBranch} ${patch} failed:\n${rebaseRes.err || rebaseRes.out}`);
    driveToCompletion("rebase", ["rebase", "--continue"], () => {
      console.error(`\n${red(`Conflict while rebasing ${patch} onto ${baseBranch}:`)}`);
      for (const f of conflictedFiles()) console.error(`    ${f}`);
      console.error(`
Resolve it by hand, then re-run this script:
    git status                       # see the conflict
    $EDITOR <file>                   # fix, keeping the patch's intent
    git add <file> && git rebase --continue
    git push --force-with-lease --force-if-includes origin ${patch}

Or abort:  git rebase --abort`);
    });
  }
  const after = gitOut("rev-list", "--count", `${baseBranch}..${patch}`);
  if (after === "0")
    warn(`${patch} is now EMPTY — upstream may have adopted it. Remove it from ${opts.listPath} and PATCHES.md.`);
  else if (after !== before) ok(`${patch} rebased (${before} → ${after} commits)`);
  else ok(`${patch} rebased (${after} commits)`);
}

// ---------------------------------------------------------------------------
// dropped-commit audit — anything on origin/<integration> that has no
// equivalent in the queue would silently vanish in the rebuild. Typical cause:
// a hotfix cherry-picked straight onto the integration branch that never made
// it back to its patch branch.
// ---------------------------------------------------------------------------

function patchIdOf(sha) {
  const diff = git("diff-tree", "--patch", "--no-commit-id", sha).out;
  if (!diff) return ""; // merge or empty commit — fall back to subject matching
  const line = gitWithInput(diff, "patch-id", "--stable");
  return line ? line.split(" ")[0] : "";
}

function isStampCommit(sha) {
  const files = git("diff-tree", "--no-commit-id", "--name-only", "-r", sha).out;
  return files === "fork-base.json";
}

// A commit whose diff is confined to CHANGELOG.md is noise by fork policy
// (PATCHES.md is the record; the auto-resolver discards these every sync),
// so the audit must not treat its disappearance as data loss.
function touchesOnlyChangelog(sha) {
  const files = git("diff-tree", "--no-commit-id", "--name-only", "-r", sha).out;
  return files === "CHANGELOG.md";
}

// True when an equivalent change (by git-cherry patch equivalence) is already
// contained in `base` — i.e. upstream adopted the commit, so the patch queue
// legitimately no longer carries it.
function adoptedByBase(sha, base) {
  const out = git("cherry", base, sha, `${sha}~1`).out;
  return out.split("\n").some((line) => line.startsWith("- "));
}

step(`Auditing origin/${opts.into} for commits the rebuild would drop`);
{
  const oldIntegration = gitOk("rev-parse", "--verify", "--quiet", `refs/remotes/origin/${opts.into}`)
    ? gitOut("rev-parse", `origin/${opts.into}`)
    : "";
  if (!oldIntegration) {
    warn(`origin/${opts.into} does not exist — nothing to audit (first build?)`);
  } else {
    // Prefer the stamped base of the previous build; fall back to the merge base.
    let prevBase = "";
    const stampRaw = git("show", `${oldIntegration}:fork-base.json`).out;
    if (stampRaw) {
      try {
        const parsed = JSON.parse(stampRaw);
        if (
          typeof parsed?.baseCommit === "string" &&
          gitOk("rev-parse", "--verify", "--quiet", `${parsed.baseCommit}^{commit}`)
        )
          prevBase = parsed.baseCommit;
      } catch {
        /* fall through to merge-base */
      }
    }
    if (!prevBase) prevBase = git("merge-base", oldIntegration, newBase).out;
    if (!prevBase) {
      warn("Could not determine the previous build's base — skipping the audit");
    } else {
      const queueIds = new Set();
      const queueSubjects = new Set();
      for (const patch of patches) {
        const shas = git("rev-list", `${baseBranch}..${patch}`).out;
        for (const sha of shas ? shas.split("\n") : []) {
          const id = patchIdOf(sha);
          if (id) queueIds.add(id);
          queueSubjects.add(gitOut("log", "-1", "--format=%s", sha));
        }
      }
      const dropped = [];
      const integrationShas = git("rev-list", `${prevBase}..${oldIntegration}`).out;
      for (const sha of integrationShas ? integrationShas.split("\n") : []) {
        if (isStampCommit(sha)) continue;
        if (touchesOnlyChangelog(sha)) continue;
        const id = patchIdOf(sha);
        if (id && queueIds.has(id)) continue;
        const subject = gitOut("log", "-1", "--format=%s", sha);
        if (queueSubjects.has(subject)) continue; // conflict-resolved pick: diff moved, intent survives
        if (adoptedByBase(sha, newBase)) continue; // upstream adopted it; the queue rightly dropped it
        dropped.push(`${sha.slice(0, 9)} ${subject}`);
      }
      if (dropped.length === 0) {
        ok(`every commit on origin/${opts.into} is carried by the patch queue`);
      } else if (opts.skipAudit) {
        warn(`--skip-audit: rebuilding anyway; these commits will be DROPPED from ${opts.into}:`);
        for (const line of dropped) console.log(`      ${line}`);
      } else {
        console.error(`\n${red(`These commits exist on origin/${opts.into} but in no patch branch:`)}`);
        for (const line of dropped) console.error(`    ${line}`);
        die(
          `Rebuilding now would drop them.\n` +
            `Cherry-pick each onto the patch branch that owns it, push, and re-run.\n` +
            `If dropping them is intentional, re-run with --skip-audit.`,
        );
      }
    }
  }
}

/**
 * During a rebuild the working tree is the half-built integration branch, and
 * `tools/` only arrives with patch/fork-tooling (applied last), so the relative
 * launcher path usually does not exist yet. Point at this file instead.
 */
function relaunchHint() {
  return `Invoke it by absolute path if you need it again:\n    node ${fileURLToPath(import.meta.url)}`;
}

// ---------------------------------------------------------------------------
// rebuild the integration branch
// ---------------------------------------------------------------------------

step(`Rebuilding ${opts.into} from ${baseBranch}`);
if (!gitOk("checkout", "-q", "-B", opts.into, baseBranch)) die(`Could not create ${opts.into}`);
for (const [patchIndex, patch] of patches.entries()) {
  const count = gitOut("rev-list", "--count", `${baseBranch}..${patch}`);
  if (count === "0") {
    warn(`skipping empty ${patch}`);
    continue;
  }
  const pickRes = git("cherry-pick", `${baseBranch}..${patch}`);
  if (pickRes.status === 0) {
    ok(`applied ${patch} (${count})`);
  } else {
    if (!inProgress("cherry-pick"))
      die(`git cherry-pick ${baseBranch}..${patch} failed:\n${pickRes.err || pickRes.out}`);
    driveToCompletion("cherry-pick", ["cherry-pick", "--continue"], () => {
      console.error(`\n${red(`Conflict applying ${patch} onto ${opts.into}:`)}`);
      for (const f of conflictedFiles()) console.error(`    ${f}`);
      const remaining = patches.slice(patchIndex + 1);
      const finish = remaining.length
        ? remaining.map((p) => `    git cherry-pick ${baseBranch}..${p}`).join("\n")
        : "    (nothing after this one — the queue is done once it lands)";
      console.error(`
Two patches disagree. Resolve, then finish the queue by hand:
    git add <file> && git cherry-pick --continue
${finish}

Re-running this script does NOT resume: it rebuilds ${opts.into} from
${baseBranch} and stops at this same conflict. ${relaunchHint()}

Or abort:  git cherry-pick --abort
If they conflict every sync, reorder them in ${opts.listPath} — or, when the
resolution is expected and stable, record the recipe in PATCHES.md.`);
    });
    ok(`applied ${patch} (${count}, CHANGELOG auto-resolved)`);
  }
}

// ---------------------------------------------------------------------------
// stamp
//
// The running build resolves its upstream base by merge-base against whatever
// remote-tracking refs the checkout happens to have. A deploy clone that has
// not refetched the mirror since the last rebuild would answer with a stale
// commit, so record the base we actually built on and let the build read that
// instead. The patch heads make "did a later sync drop something?" a one-look
// question instead of forensic archaeology.
// ---------------------------------------------------------------------------

step(`Stamping the upstream base onto ${opts.into}`);
{
  const patchHeads = {};
  for (const patch of patches) patchHeads[patch] = gitOut("rev-parse", patch);
  const stamp = { baseRef: opts.base, baseCommit: newBase, baseBranch, patches: patchHeads };
  writeFileSync("fork-base.json", `${JSON.stringify(stamp, null, 2)}\n`);
  if (!gitOk("add", "fork-base.json")) die("Could not stage fork-base.json");
  if (!gitOk("commit", "-q", "-m", `chore(fork): stamp upstream base ${newBase.slice(0, 12)}`))
    die("Could not commit fork-base.json");
  ok(`fork-base.json → ${newBase.slice(0, 12)} (${opts.base}, ${patches.length} patch heads recorded)`);
}

// ---------------------------------------------------------------------------
// optional validation + summary
// ---------------------------------------------------------------------------

if (opts.check) {
  step("Validating (pnpm check)");
  if (!runInherit("pnpm", ["install"])) warn("pnpm install reported a problem");
  if (runInherit("pnpm", ["check"])) ok("pnpm check passed");
  else die("pnpm check FAILED — do not push.");
}

step("Done");
console.log(
  `  ${opts.into} is ${gitOut("rev-list", "--count", `${baseBranch}..${opts.into}`)} commits over ${baseBranch}`,
);
console.log(`  ${dim("Review:")} git log --oneline ${baseBranch}..${opts.into}`);
console.log(`  ${dim("Diff  :")} git diff ${baseBranch}...${opts.into}`);
console.log(`
Nothing has been pushed. When it looks right:
    git push --force-with-lease --force-if-includes origin ${baseBranch}
${patches.map((p) => `    git push --force-with-lease --force-if-includes origin ${p}`).join("\n")}
    git push --force-with-lease --force-if-includes origin ${opts.into}

(--force-if-includes refuses the push if origin gained commits your local
branch never integrated — the second net under the freshness guard.)`);
