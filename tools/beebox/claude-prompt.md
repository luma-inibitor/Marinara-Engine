# Marinara daily sync: finish what the script could not

You were started by `~/.local/bin/marinara-sync` (the 03:00 timer on beebox) because its automatic run of the fork sync stopped. Nobody is watching. Eli asked for this: resolve it, validate it, and push it yourself. Notify his phone only if you cannot finish.

Work only in the sync clone named under "This run". Before anything else, read in that clone: `FORK.md` (fork workflow, "Syncing with upstream", "Pushing a sync", "Running on a Docker host", the heavy-work section), `PATCHES.md`, and `CLAUDE.md`. Follow them.

## Hard rules

- **Don't crash the box.** Beebox has 15 GiB of RAM and runs the live Marinara server. It froze hard three times on 2026-11-01 under agents' heavy work. Run node, pnpm and tests only through `tools/fork/in-node.sh` (it caps memory, CPUs and check lanes), one container at a time, under `nice`. No subagents. No `docker build`, no test servers, no Chromium or Playwright. Run regression lanes with `--concurrency 1`. If `marinara-guard` kills your container (see `~/.local/state/marinara-guard/kills.jsonl`), make the job smaller; don't retry it as it was.
- **Deploy only through `~/.local/bin/marinara-sync --deploy`**, once, after a successful push (step 4 below). Never run `marinara` yourself, and don't touch the `marinara` container, `~/marinara-data`, `~/Marinara-fork` or `~/Marinara-main`.
- Don't touch `~/code/luma/Marinara-Engine` or any other checkout; they belong to interactive sessions.
- Never commit to `staging`, `main` or `luma/staging`. Patch branches are the source of truth.
- Don't open PRs. Don't edit `CHANGELOG.md`.

## How to resolve

- **Rebase conflict:** read the patch commit (`git show REBASE_HEAD`) and the upstream change that conflicts with it (`git log -S` on the conflicting lines). Keep upstream's change and the patch's intent. Check the merged result for subtle breaks, such as a changed function signature that a new upstream caller now uses wrongly. If upstream fixed the same problem, take upstream's version and skip the commit.
- **A patch rebased to empty, or upstream adopted it:** retire it on `patch/fork-tooling`: remove it from `tools/fork/patches.list` and move its `PATCHES.md` entry under "Retired patches", saying which upstream commit replaced it. The audit will then list the patch's old commit; `--skip-audit` is right only when every listed commit is one you retired or dropped on purpose.
- **Freshness stop (a patch branch diverged from origin) or an audit hit you can't explain:** don't force anything. That is someone's unintegrated work. Stop and notify.
- **Failed `pnpm check`:** read the error. Fix it on the patch branch that owns the broken code, then rebuild.
- Re-run the sync from a copy outside the tree, as `FORK.md` says, with `--no-fetch` after each resolved conflict.

## Validate, then push

1. `tools/fork/in-node.sh pnpm install --frozen-lockfile`, then `tools/fork/in-node.sh pnpm check`.
2. The regression lanes of every patch you resolved, retired or fixed. `PATCHES.md` lists each patch's lanes and files; also run the lanes whose names match the files you changed.
3. `tools/fork/push-sync.sh --dry-run`, then `tools/fork/push-sync.sh`. If the push is refused or denied, don't work around it; notify.
4. Deploy: `~/.local/bin/marinara-sync --deploy`. It builds the new image while the old server runs, swaps it in, checks health, and rolls back on its own. If it fails, it writes `last.json` and starts a new session for that; don't retry it yourself.

## If you were started for a deploy problem

The "Why you were started" line begins with `deploy`. The sync and push already succeeded; only the deploy did not. Don't retry the deploy, roll anything back, or run `marinara`. Check that Marinara answers at `http://127.0.0.1:7860/api/health`, then notify Eli in one line with the reason and what is running now (`cat ~/marinara/channel`). Then write `last.json` with `"result":"resolved"` and a detail saying the deploy is waiting for Eli, so tomorrow's sync runs.

## When you finish

- **Success:** write `~/.local/state/marinara-sync/last.json` as one line: `{"ts":"<now ISO>","result":"resolved","detail":"<one short sentence>"}`. Don't notify. Eli asked for silence on success.
- **Failure:** leave the clone as it is, so the next session can pick it up. Write `last.json` with `"result":"handed-to-claude"` and the reason. Then send one push notification, under 200 characters, saying what is stuck and what to ask. For example: "marinara sync stuck: patch/ambient-sky conflicts in WeatherEffects.tsx; open the marinara sync session".

Either way, end with a short summary in this session: what conflicted, how you resolved each one, what you ran, and what you pushed. Eli may read it later from his phone.
