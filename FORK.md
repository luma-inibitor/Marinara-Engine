# Fork Workflow

This is a long-term fork of [Pasta-Devs/Marinara-Engine](https://github.com/Pasta-Devs/Marinara-Engine), maintained under [luma-inibitor/Marinara-Engine](https://github.com/luma-inibitor/Marinara-Engine). It exists to carry local patches that upstream has declined but that are useful for our own on-device (Android/Termux) use.

For the list of what's actually patched and why, see [`PATCHES.md`](./PATCHES.md). This file is the _how it all works_ guide.

Starting a coding session with an AI agent? Paste [`tools/fork/AGENT-BRIEF.md`](./tools/fork/AGENT-BRIEF.md) — it briefs the agent on this workflow, the branch rules, and the UI/UX harness.

## Branch model

| Branch         | Role                                                                         | Rule                                                                        |
| -------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `staging`      | Pristine mirror of `upstream/staging` — **the base we track** (beta channel) | **Never commit here.** Only ever reset to upstream.                         |
| `main`         | Pristine mirror of `upstream/main` (stable releases)                         | **Never commit here.** Kept for reference/rollback.                         |
| `patch/*`      | One branch per logical local change, based on `staging`                      | Kept clean and self-contained so any patch could still be offered upstream. |
| `luma/staging` | **Integration / deploy branch** — `staging` + every `patch/*` + fork docs    | This is what you run on-device. Rebuilt on every sync.                      |
| `luma/main`    | Previous stable-based integration branch                                     | Frozen. Storage-incompatible with `luma/staging` — see the warning below.   |

> **⚠️ Storage format is a one-way door.** `main` and `staging` are both 2.4.6, but they are **not** storage-compatible: `main` writes format 6, `staging` format 7. Format 7 adds lorebook-entry provenance fields that format-6 builds cannot preserve, so `main` refuses a staging-written store. The earlier format 5→6 migration is **one-way** — the monolith→per-chat-shard move of `messages`, `message_swipes`, `memory_chunks`, `chat_images`, `agent_runs`, and `agent_memory` is never reversed on a downgrade. Two guards now stand between you and a bad rollback: every build since #4708 reads `manifest.version` and refuses to open data written by a **newer** format (`StorageFormatTooNewError`) instead of silently misreading it, and the launcher/updater compares the on-disk format against the target ref's tracked `storage-format.json` before switching you (`scripts/protect-launcher-data.mjs`; a ref predating that file counts as format 2). Builds older than #4708 have neither guard — they find no `tables/messages.json`, load messages as empty, and flush a stale manifest over your store. Staging preserves the originals as `.pre-shard` and quarantines the downgrade artifact, so even that is recoverable, but **never point builds of different storage formats at the same `DATA_DIR`.** Both deploy channels track staging for exactly this reason. Back up `~/marinara-data` before the first staging boot.

`upstream` is a git remote pointing at `Pasta-Devs/Marinara-Engine`; `origin` is our fork.

**See exactly what this fork changes vs. stock:** `git diff staging...luma/staging`

## One-time setup (per machine / clone)

```sh
git remote add upstream https://github.com/Pasta-Devs/Marinara-Engine
git fetch upstream
```

## Everyday use

- **Deploy / run the fork:** check out `luma/staging`.
- **Run stock upstream instead:** check out `staging`. (Stock `main` is storage-incompatible with your data once staging has migrated it — see the warning above.)
- Deploy branches are _consumed, not edited_. Never make local commits on `luma/staging`, `staging`, or `main` on a device — do real work on `patch/*` branches from a dev machine and let it flow through `luma/staging`.
- `.env`, `node_modules/`, `packages/*/dist/`, the pnpm store, and your data directory are all gitignored, so **they survive branch switches**. Switching only swaps source code.

## Syncing with upstream

**Use the script.** It refreshes the mirror, rebases every patch in `tools/fork/patches.list`, and rebuilds the integration branch:

```sh
tools/fork/apply-patches.sh --check
```

(The `.sh` is a thin launcher; the logic lives in `tools/fork/apply-patches.mjs`, plain Node with no dependencies — the repo already requires Node ≥ 24.)

It pushes nothing. When the result looks right (and is validated), push it with `tools/fork/push-sync.sh`; see [Pushing a sync](#pushing-a-sync). On a real conflict it stops with the failing patch and the commands to resolve it. Re-running with `--no-fetch` picks up a resolved **rebase** (that phase is idempotent), but it does **not** resume a resolved **rebuild**: the rebuild starts with `git checkout -B <integration> <base>`, so it discards what you just resolved and stops at the same conflict again. Finish that phase by cherry-picking the queue's remaining entries by hand — the conflict message lists them. Note also that `tools/fork/` exists only on `patch/fork-tooling`, so it vanishes from the working tree as soon as the script checks out the first patch branch, and stays gone through every rebase stop and the rebuild until `patch/fork-tooling` applies last. Run the script from a copy outside the tree so every relaunch finds it:

```sh
S=$(mktemp -d)
git show patch/fork-tooling:tools/fork/apply-patches.mjs > "$S/apply-patches.mjs"
git show patch/fork-tooling:tools/fork/patches.list      > "$S/patches.list"
FORK_PATCH_LIST="$S/patches.list" node "$S/apply-patches.mjs"             # first run
FORK_PATCH_LIST="$S/patches.list" node "$S/apply-patches.mjs" --no-fetch  # after each resolved conflict
```

Conflicts that are only in `CHANGELOG.md` are resolved automatically (keeping upstream's copy), since nearly every upstream commit touches that file.

Three guards protect against rebuilding from stale state — the failure mode that has twice dropped pushed commits:

- **It fetches `origin` (and each `fork.mirror` remote) as well as `upstream`**, then compares every local patch branch to its `origin/*` counterpart: a branch that is strictly behind is fast-forwarded automatically; a branch that has truly diverged (origin holds commits this clone never integrated, judged by the branch reflog — the same rule as `git push --force-if-includes`) stops the run with reconciliation steps.
- **It audits the old integration branch before overwriting it**: any commit on `origin/luma/staging` since the previous stamp with no equivalent (by patch-id, then by subject) in the patch queue is listed and stops the run — that is a hotfix that landed on the integration branch but never made it back to its patch branch, and rebuilding would silently drop it. Commits whose diff is only `CHANGELOG.md`, and commits upstream has since adopted, are exempt — those disappear legitimately. `--skip-audit` overrides when dropping is intentional.
- **`push-sync.sh` pushes with `--force-with-lease --force-if-includes`**, so even a push issued later from this clone refuses to overwrite work that was fetched but never integrated.

### Pushing a sync

Force-pushing the rebuilt branches is the standard last step of every sync, not a judgment call. Use the script, not hand-typed pushes:

```sh
tools/fork/push-sync.sh --dry-run   # optional: show what would move
tools/fork/push-sync.sh
```

It refuses unless `luma/staging`'s `fork-base.json` names the local `staging` and every local patch head (so it can't push a half-finished or stale rebuild). It then fetches `origin` and each mirror remote, refuses if a mirror holds a branch tip `origin` lacks, and pushes `staging`, every queued patch branch and `luma/staging` to `origin` and then to each mirror, all with `--force-with-lease --force-if-includes`. Mirrors are remotes named in `git config fork.mirror` (none by default; see the Docker host section).

**When the old tip came from another clone.** `--force-if-includes` accepts a force-push only when the remote tip is in the local branch's reflog. A `luma/staging` pushed from another clone, or from another ref such as `HEAD:luma/staging` in a worktree, is in no reflog here, so a plain force-push would be refused. Adding a patch from an interactive clone always causes this for the sync clone (2026-11-12). The audit handles it: when it clears `origin/luma/staging` (every commit carried by the queue, or `--skip-audit` given), `apply-patches` records that tip as `replaces` in `fork-base.json`. If a remote's `luma/staging` is still exactly that commit, `push-sync.sh` pushes `luma/staging` there with `--force-with-lease=luma/staging:<that sha>` and without `--force-if-includes`. Anything pushed after the audit fails that lease, so re-run `apply-patches` (with a fetch) and push again. A stamp from before this change has no `replaces`. In that case, rebuild first.

Useful flags: `--list` (show the queue), `--base <ref>` (default `upstream/staging`), `--into <branch>` (default `luma/staging`), `--no-fetch`, `--skip-audit`.

As its last step the script commits a root `fork-base.json` onto the integration branch recording the base it built on and the exact patch heads it built from:

```json
{
  "baseRef": "upstream/staging",
  "baseCommit": "<full sha>",
  "baseBranch": "staging",
  "patches": { "patch/<topic>": "<full sha>", "…": "…" },
  "replaces": "<origin/luma/staging tip the audit cleared>"
}
```

The `patches` map makes "did a sync drop something?" a one-look question: diff it against `origin/patch/*` instead of doing forensic archaeology on the integration history.

`patch/fork-upstream-diagnostics` reads it so Support Diagnostics can name the exact upstream commit the running build contains. Without it the build falls back to a merge base against whatever remote-tracking refs the device happens to have, which on a clone that has not refetched the mirror answers with a stale commit. It lives only on the integration branch — never commit it to `staging`, `main`, or a `patch/*` branch.

To enable or disable a patch, edit `tools/fork/patches.list` and re-run. Order matters; `patch/fork-tooling` stays last.

<details>
<summary>The same thing by hand</summary>

```sh
git fetch upstream
git fetch origin --prune            # NEVER skip this: syncing from stale refs drops pushed work

# 1. Refresh the pristine mirrors
git checkout -B staging upstream/staging && git push --force-with-lease origin staging
git checkout -B main    upstream/main    && git push --force-with-lease origin main

# 2. Rebase each patch branch onto the new base (resolve conflicts here).
#    Start each rebase from origin's tip, not a possibly-stale local branch.
git checkout -B patch/ambient-sky origin/patch/ambient-sky
git rebase staging
pnpm install && pnpm check          # validate the rebased patch still builds
git push --force-with-lease --force-if-includes origin patch/ambient-sky

# 3. Rebuild the integration branch from the refreshed base + patches
git checkout -B luma/staging staging
git cherry-pick <patch commits> && git cherry-pick <fork docs/tooling commits>
#   ...cherry-pick each patch/* branch's commits, then the fork docs/tooling commits...
#   Before pushing, confirm nothing on origin/luma/staging is being left behind:
git log --oneline luma/staging..origin/luma/staging
git push --force-with-lease --force-if-includes origin luma/staging
```

> Because deploy branches are force-pushed on every sync, never do local work on them — a force-push will overwrite it.

## Adding a new patch

A new patch goes straight into `luma/staging` in one pass, with no review PR and no stop between steps:

1. Branch from the pristine mirror, make the change, validate it, and push it:

   ```sh
   git checkout -B patch/<short-topic> staging
   # ...make the change, commit it...
   pnpm install && pnpm check    # plus any regression lane the change touches
   git push -u origin patch/<short-topic>
   ```

2. On `patch/fork-tooling`, add the branch to `tools/fork/patches.list` (before `patch/fork-tooling`, which stays last) and add its section to [`PATCHES.md`](./PATCHES.md). Commit it.

3. Rebuild `luma/staging` on the current base, validate, then push with `tools/fork/push-sync.sh`:

   ```sh
   tools/fork/apply-patches.sh --base origin/staging --check
   ```

   `--base origin/staging` keeps the base where the last sync left it, so adding a patch does not also pull in new upstream commits. Leave `--base` off to do a full upstream sync at the same time.

4. Report the patch name, what it changes, and that the device picks it up on its next pull and restart.

<details>
<summary>Or fold it in by hand</summary>

```sh
git checkout luma/staging
git cherry-pick patch/<short-topic>   # or rebase/cherry-pick if it needs to sit on other patches
git push --force-with-lease origin luma/staging
```

The `patches.list` and `PATCHES.md` entries are still required, or the next sync drops the patch.

</details>

Each `PATCHES.md` section records what it does, why it's forked, its upstream status, and the files it touches.

## Retiring a patch (e.g. upstream adopted it)

1. On your next sync, after `git rebase staging`, if the patch becomes empty (`git rebase` reports "no changes — did you forget to `git add`?" or the diff is gone), upstream now ships it.
2. Remove it from `tools/fork/patches.list` (the script warns when a patch rebases to empty), delete the branch (`git branch -D` / `git push origin --delete`), and remove its section from `PATCHES.md`.

## Validating after any sync or new patch

```sh
pnpm install
pnpm check                                    # TypeScript + ESLint + build
```

On a host with no native Node ≥ 24 or pnpm (the Docker host below), prefix each command with `tools/fork/in-node.sh`, which runs it in the Dockerfile's own builder image: `tools/fork/in-node.sh pnpm check`. The sync script's `--check` calls a bare `pnpm`, so leave it off there and validate this way after the rebuild.

## Running on Android / Termux

The stock `start-termux.sh` auto-updates only `main`/`staging` and lives _inside_ the repo (so it changes when you switch branches). The switcher in [`tools/termux/`](./tools/termux/) works around this: it runs two clones (`~/Marinara-fork` on `luma/staging` and `~/Marinara-main` on stock `staging`) that share one data directory (`~/marinara-data`), so you flip between fork and mainline instantly with identical chats, launched from Termux:Widget home-screen icons.

Install on-device:

```sh
git clone --branch luma/staging https://github.com/luma-inibitor/Marinara-Engine "$HOME/Marinara-fork"
bash "$HOME/Marinara-fork/tools/termux/install.sh"
```

See [`tools/termux/README.md`](./tools/termux/README.md) for full details, including how it migrates your existing APK-clone chats into the shared data directory. Key facts it relies on: the file-native store lives at `<DATA_DIR>/storage/tables/*.json` (default `packages/server/data`), and the APK is only a WebView viewer on port 7860 — its "Install / Start" button force-checks-out the stock release tag, so start the server with the switcher instead.

## Running on a Docker host (beebox)

The home server runs Marinara from a Docker image instead of a native install. Three things differ from a dev machine or Termux:

**No native toolchain.** The host has an older system Node and no pnpm. The sync script is plain Node with no dependencies and runs fine on the host's Node, but `pnpm` does not exist there. Validate with `tools/fork/in-node.sh pnpm install --frozen-lockfile && tools/fork/in-node.sh pnpm check` (see [Validating](#validating-after-any-sync-or-new-patch)), and drop `--check` from the sync script. The full suite runs the same way (`tools/fork/in-node.sh node ./scripts/run-regressions.mjs`, about 20 minutes). Under full-suite load a few timing-sensitive lanes (the multiplayer and shutdown ones) can fail, so rerun each failure alone with `--filter` before suspecting a patch. Two lanes fail in the container on stock `staging` too, as of 601fc97ff: `dottore-auto-dispatch` and `storage-writer-lock`.

**The host tooling lives outside this repo**, in the host's private repo `~/code/luma/beebox` (until 2026-11-13 it was `tools/beebox/` on this branch; see its history). It holds the scripts `marinara`, `marinara-sync`, `marinara-rebuild` and `marinara-guard`, their systemd user units, the hand-off prompt and the host settings (`beebox.env`; secrets stay in `~/marinara/secrets.env`). That checkout is the live install: `~/.local/bin` symlinks into it and the units are linked with `systemctl --user link`, so a change there is live once merged, and a sync no longer reinstalls anything. Its README covers the sync's flags, log lines and `last.json`.

**A daily sync runs at 03:00 Pacific.** The user timer `marinara-sync.timer` runs `~/.local/bin/marinara-sync` in its own clone, `~/code/luma/Marinara-Engine-sync`. On a clean day it rebases, runs `pnpm install` and `pnpm check` through `in-node.sh`, pushes with `push-sync.sh`, and deploys (`marinara-sync --deploy`), silently. Anything else (a conflict, an empty patch, an audit stop, a failed check, low memory) starts a background Claude session with Remote Control (`claude-job`, named `marinara sync MM-DD`), prompted by the beebox repo's `claude-prompt.md`. That session resolves, validates and pushes, and notifies the owner's phone only if it gets stuck. Until it records `"result":"resolved"` in `~/.local/state/marinara-sync/last.json`, later runs leave the clone alone. Logs are in `~/.local/state/marinara-sync/runs/`. Before heavy work it waits up to 30 minutes for free memory: 5 GiB for the sync and `pnpm check` (`MARINARA_SYNC_MIN_AVAILABLE_GIB`; 6 until 2026-11-13), 5120 MiB for the deploy's image build (`MARINARA_SYNC_DEPLOY_MIN_AVAILABLE_MIB`), which the buildx builder caps at 5 GiB. While it waits it logs the biggest processes and containers every 10 minutes, so a stall names what held the memory. Because the sync rewrites every patch branch overnight, start interactive work with `git fetch origin --prune`.

**Heavy work is capped, and a guard watches memory.** The host has 15 GiB of RAM, 4 CPUs and the live server on it. On 2026-11-01, two agents' image builds, test containers and headless Chromium froze it hard twice, with no OOM kill logged. Three limits now apply to every session:

- `tools/fork/in-node.sh` runs each container with 6 GiB of memory, no swap and CPUs 1-3, labeled `marinara.guard=heavy`. Override with `MARINARA_NODE_MEMORY` and `MARINARA_NODE_CPUS`. It also sets `MARINARA_CHECK_JOBS=1`, so `pnpm check` runs its lanes one at a time: it peaked at 3.1 GiB on 2026-11-08. With every lane at once it outgrew the 6 GiB cap and the memory left beside the live server, and the guard killed it.
- Every `docker build` goes through the buildx builder `capped` (5 GiB, CPUs 1-3), set as the global default. Don't pass `--builder default`.
- `marinara-guard` (in the beebox repo) runs as the user service `marinara-guard`. When available memory or memory pressure crosses its threshold, it kills one heavy job at a time, youngest first: labeled containers, then the builder, then other containers with no restart policy, then Playwright's Chromium. It never kills a container with a restart policy, so the live server and the other services are safe. Its kills are logged in `~/.local/state/marinara-guard/kills.jsonl`.

The guard does not prevent every freeze: a third one came with the guard running and memory looking fine 8 minutes earlier. The cause is not known. The host also runs a hardware watchdog and `below`; after a freeze, `below replay` shows what each container used before it.

A test server you start yourself has no restart policy, so the guard can kill it. Give it `--memory` and `--cpuset-cpus 1-3`, and run one at a time.

**Two remotes to keep in step.** In the beebox checkout (`~/code/luma/Marinara-Engine`), `origin` is a local bare repo (`~/git/luma/Marinara-Engine.git`), not GitHub, but the deploy builds from the GitHub fork. The sync script's freshness guard and dropped-commit audit only look at `origin`, so the GitHub fork is set up as a mirror remote, which `push-sync.sh` checks and pushes to after `origin`:

```sh
git remote add gh https://github.com/luma-inibitor/Marinara-Engine
git config --add fork.mirror gh
```

The sync script fetches every mirror along with `origin`, before it rebases. That keeps `--force-if-includes` working: it counts only local reflog entries newer than the mirror's tracking ref, so a mirror first fetched inside `push-sync.sh` refused its push on 2026-11-09 although it held exactly what `origin` did. Before a sync, check that `git log --oneline origin/luma/staging...gh/luma/staging` is empty; reconcile anything GitHub alone has before rebuilding. `push-sync.sh` refuses to push over such commits either way.

**Deploying is an image build.** `marinara` (in `~/.local/bin`, from the beebox repo) is the host's switcher, the Docker counterpart of `tools/termux/`:

- `marinara fork` updates `~/Marinara-fork` to GitHub's `luma/staging`; `marinara main` updates `~/Marinara-main` to stock `staging`. So **push to GitHub before deploying**, or the build reuses the old code.
- Building and restarting are separate steps. `marinara build [fork|main]` updates the clone and builds the image as `marinara:<channel>-next` (labeled with the commit it was built from) while the old server keeps running; there is no downtime, so build whenever. `marinara up [fork|main]` swaps a built image in. `marinara fork` / `marinara main` do both. `marinara status` also lists any image that is built but not running.
- `up` tags the outgoing image `marinara:<channel>-<old sha>` for rollback, then swaps the new image in with `docker compose -f ~/marinara/compose.yml up -d`. The restart is the only downtime, a few seconds.
- Both channels share `~/marinara-data` (bind-mounted as the container's data directory), so the storage-format warning above applies between channels. The nightly deploy does not hold for a format bump, and takes no backup of its own; Eli keeps daily backups (2026-11-12).
- Roll back with `MARINARA_IMAGE=marinara:fork-<old sha> docker compose -f ~/marinara/compose.yml up -d`. `marinara status` prints the channel and the commit it was built from.
- Container settings (env vars such as `REQUIRE_AUTH_FOR_LOOPBACK_PROXY`) live in `~/marinara/compose.yml`, secrets in `~/marinara/secrets.env`; both survive deploys.
- Since 2026-11-09 the compose file also sets `LOREBOOK_COMPACT_STORED_SCANS=true` (older messages keep lorebook entry ids and scores, not entry text) and `MARINARA_MAX_RESIDENT_CHATS=8` (outside constrained platforms the default keeps every opened chat in memory until restart). Without them, one long roleplay chat grew to 716 MB on disk and the server crashed out of heap whenever it wrote that chat; see `patch/generation-record-pruning` in `PATCHES.md`.
