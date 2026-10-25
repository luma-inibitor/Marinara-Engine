#!/usr/bin/env node
// Push the result of apply-patches to origin and any mirror remotes.
//
//   1. check the rebuild is current: fork-base.json on the integration branch
//      must name the local base branch and every local patch head
//   2. fetch origin and each mirror (remotes listed in `git config fork.mirror`)
//   3. refuse if a mirror holds a branch tip origin does not — work pushed only
//      to the mirror would be overwritten
//   4. push the base mirror, every patch branch and the integration branch to
//      origin, then to each mirror, all with --force-with-lease --force-if-includes
//
// Usage:
//   tools/fork/push-sync.sh [options]           (thin launcher for this file)
//     --dry-run         show what would be pushed, push nothing
//     -h, --help
//
// Environment: FORK_PATCH_LIST, FORK_INTEGRATION override the defaults.
// Set up a mirror once per clone, e.g. for the GitHub fork:
//   git remote add gh https://github.com/luma-inibitor/Marinara-Engine
//   git config --add fork.mirror gh

import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import process from "node:process";

function git(...args) {
  const res = spawnSync("git", args, { encoding: "utf8" });
  if (res.error) return { status: 127, out: "", err: String(res.error.message ?? res.error) };
  return { status: res.status ?? 1, out: (res.stdout ?? "").trimEnd(), err: (res.stderr ?? "").trimEnd() };
}
function gitOut(...args) {
  const res = git(...args);
  if (res.status !== 0) die(`git ${args.join(" ")} failed:\n${res.err || res.out}`);
  return res.out;
}
const rev = (ref) => git("rev-parse", "--verify", "--quiet", ref).out;

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);
const step = (msg) => console.log(`\n${c("1", "==>")} ${msg}`);
const ok = (msg) => console.log(`  ${c("32", "✓")} ${msg}`);
function die(msg) {
  console.error(`\n${c("31", `✗ ${msg}`)}`);
  process.exit(1);
}

const opts = {
  dryRun: false,
  into: process.env.FORK_INTEGRATION || "luma/staging",
  listPath: process.env.FORK_PATCH_LIST || "tools/fork/patches.list",
};
for (const arg of process.argv.slice(2)) {
  if (arg === "--dry-run") opts.dryRun = true;
  else if (arg === "-h" || arg === "--help") {
    const self = readFileSync(new URL(import.meta.url), "utf8");
    for (const line of self.split("\n").slice(1, 21)) console.log(line.replace(/^\/\/ ?/, ""));
    process.exit(0);
  } else die(`Unknown option: ${arg}`);
}

const root = git("rev-parse", "--show-toplevel");
if (root.status !== 0) die("Not a git repository.");
process.chdir(root.out);

// ---------------------------------------------------------------------------
// 1. the rebuild must be current
// ---------------------------------------------------------------------------

step(`Checking ${opts.into} is a current rebuild`);
const stamp = git("show", `${opts.into}:fork-base.json`);
if (stamp.status !== 0) die(`${opts.into} has no fork-base.json. Run apply-patches first.`);
const base = JSON.parse(stamp.out);
if (!existsSync(opts.listPath)) die(`Patch list not found: ${opts.listPath}`);
const patches = readFileSync(opts.listPath, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));

const stale = [];
if (rev(base.baseBranch) !== base.baseCommit) stale.push(`${base.baseBranch} is not the stamped base`);
for (const p of patches) {
  if (rev(p) !== base.patches?.[p]) stale.push(`${p} differs from the head ${opts.into} was built from`);
}
for (const p of Object.keys(base.patches ?? {})) {
  if (!patches.includes(p)) stale.push(`${p} was built in but is no longer in the queue`);
}
if (stale.length) die(`${opts.into} is out of date. Re-run apply-patches, then push:\n  ${stale.join("\n  ")}`);
ok(`${opts.into} built on ${base.baseBranch} ${base.baseCommit.slice(0, 9)} from ${patches.length} patch heads`);

const branches = [base.baseBranch, ...patches, opts.into];

// ---------------------------------------------------------------------------
// 2–3. fetch, then make sure no mirror holds work origin lacks
// ---------------------------------------------------------------------------

const mirrors = git("config", "--get-all", "fork.mirror").out.split("\n").filter(Boolean);
step(`Fetching origin${mirrors.map((m) => ` + ${m}`).join("")}`);
for (const remote of ["origin", ...mirrors]) gitOut("fetch", "--prune", "--quiet", remote);
ok("fetched");

for (const m of mirrors) {
  const ahead = branches.filter((b) => {
    const theirs = rev(`refs/remotes/${m}/${b}`);
    return theirs && theirs !== rev(`refs/remotes/origin/${b}`) && theirs !== rev(b);
  });
  if (ahead.length) {
    die(
      `${m} has branch tips origin does not, and pushing would overwrite them:\n  ${ahead.join("\n  ")}\n` +
        `Inspect:   git log --oneline origin/<branch>...${m}/<branch>\n` +
        "Reconcile them into origin (and the patch branch), re-run apply-patches, then push.",
    );
  }
  ok(`${m} holds nothing origin lacks`);
}

// ---------------------------------------------------------------------------
// 4. push
// ---------------------------------------------------------------------------

for (const remote of ["origin", ...mirrors]) {
  step(`Pushing ${branches.length} branches to ${remote}${opts.dryRun ? " (dry run)" : ""}`);
  const args = ["push", "--force-with-lease", "--force-if-includes", "--porcelain"];
  if (opts.dryRun) args.push("--dry-run");
  const res = git(...args, remote, ...branches.map((b) => `refs/heads/${b}:refs/heads/${b}`));
  for (const line of res.out.split("\n")) if (/^[-+*=! ]\t/.test(line)) console.log(`  ${line.replace(/\t/g, "  ")}`);
  if (res.status !== 0) die(`push to ${remote} failed:\n${res.err}`);
  ok(`${remote} updated`);
}
