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

> **⚠️ Storage format is a one-way door.** `main` and `staging` are both 2.4.4, but they are **not** storage-compatible: `main` writes format 5, `staging` format 6. The migration is **one-way** — the monolith→per-chat-shard move of `messages`, `message_swipes`, `memory_chunks`, `chat_images`, `agent_runs`, and `agent_memory` is never reversed on a downgrade. Two guards now stand between you and a bad rollback: every build since #4708 reads `manifest.version` and refuses to open data written by a **newer** format (`StorageFormatTooNewError`) instead of silently misreading it, and the launcher/updater compares the on-disk format against the target ref's tracked `storage-format.json` before switching you (`scripts/protect-launcher-data.mjs`; a ref predating that file counts as format 2). Builds older than #4708 have neither guard — they find no `tables/messages.json`, load messages as empty, and flush a stale manifest over your store. Staging preserves the originals as `.pre-shard` and quarantines the downgrade artifact, so even that is recoverable, but **never point builds of different storage formats at the same `DATA_DIR`.** Both deploy channels track staging for exactly this reason. Back up `~/marinara-data` before the first staging boot.

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

It pushes nothing — it prints the exact push commands when the result looks right. On a real conflict it stops with the failing patch and the commands to resolve it. Re-running with `--no-fetch` picks up a resolved **rebase** (that phase is idempotent), but it does **not** resume a resolved **rebuild**: the rebuild starts with `git checkout -B <integration> <base>`, so it discards what you just resolved and stops at the same conflict again. Finish that phase by cherry-picking the queue's remaining entries by hand — the conflict message lists them. Note also that `tools/` is not in the working tree mid-rebuild (`patch/fork-tooling` applies last), so relaunch the script by absolute path. Conflicts that are only in `CHANGELOG.md` are resolved automatically (keeping upstream's copy), since nearly every upstream commit touches that file.

Three guards protect against rebuilding from stale state — the failure mode that has twice dropped pushed commits:

- **It fetches `origin` as well as `upstream`**, then compares every local patch branch to its `origin/*` counterpart: a branch that is strictly behind is fast-forwarded automatically; a branch that has truly diverged (origin holds commits this clone never integrated, judged by the branch reflog — the same rule as `git push --force-if-includes`) stops the run with reconciliation steps.
- **It audits the old integration branch before overwriting it**: any commit on `origin/luma/staging` since the previous stamp with no equivalent (by patch-id, then by subject) in the patch queue is listed and stops the run — that is a hotfix that landed on the integration branch but never made it back to its patch branch, and rebuilding would silently drop it. Commits whose diff is only `CHANGELOG.md`, and commits upstream has since adopted, are exempt — those disappear legitimately. `--skip-audit` overrides when dropping is intentional.
- **The push commands it prints use `--force-with-lease --force-if-includes`**, so even a push issued later from this clone refuses to overwrite work that was fetched but never integrated.

Useful flags: `--list` (show the queue), `--base <ref>` (default `upstream/staging`), `--into <branch>` (default `luma/staging`), `--no-fetch`, `--skip-audit`.

As its last step the script commits a root `fork-base.json` onto the integration branch recording the base it built on and the exact patch heads it built from:

```json
{
  "baseRef": "upstream/staging",
  "baseCommit": "<full sha>",
  "baseBranch": "staging",
  "patches": { "patch/<topic>": "<full sha>", "…": "…" }
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
git checkout -B patch/mari-unsandboxed-shell origin/patch/mari-unsandboxed-shell
git rebase staging
pnpm install && pnpm check          # validate the rebased patch still builds
git push --force-with-lease --force-if-includes origin patch/mari-unsandboxed-shell

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

```sh
git checkout -B patch/<short-topic> staging  # branch from the pristine mirror
# ...make the change, commit it...
git push -u origin patch/<short-topic>
```

Then add it to `tools/fork/patches.list` (before `patch/fork-tooling`), document it in [`PATCHES.md`](./PATCHES.md), and rebuild:

```sh
tools/fork/apply-patches.sh --check
```

<details>
<summary>Or fold it in by hand</summary>

```sh
git checkout luma/staging
git cherry-pick patch/<short-topic>   # or rebase/cherry-pick if it needs to sit on other patches
git push --force-with-lease origin luma/staging
```

</details>

Each `PATCHES.md` section records what it does, why it's forked, its upstream status, and the files it touches.

## Retiring a patch (e.g. upstream adopted it)

1. On your next sync, after `git rebase staging`, if the patch becomes empty (`git rebase` reports "no changes — did you forget to `git add`?" or the diff is gone), upstream now ships it.
2. Remove it from `tools/fork/patches.list` (the script warns when a patch rebases to empty), delete the branch (`git branch -D` / `git push origin --delete`), and remove its section from `PATCHES.md`.

## Validating after any sync or new patch

```sh
pnpm install
pnpm check                                    # TypeScript + ESLint + build
pnpm regression:professor-mari-shell-sandbox  # for the shell patch specifically
```

## Running on Android / Termux

The stock `start-termux.sh` auto-updates only `main`/`staging` and lives _inside_ the repo (so it changes when you switch branches). The switcher in [`tools/termux/`](./tools/termux/) works around this: it runs two clones (`~/Marinara-fork` on `luma/staging` and `~/Marinara-main` on stock `staging`) that share one data directory (`~/marinara-data`), so you flip between fork and mainline instantly with identical chats, launched from Termux:Widget home-screen icons.

Install on-device:

```sh
git clone --branch luma/staging https://github.com/luma-inibitor/Marinara-Engine "$HOME/Marinara-fork"
bash "$HOME/Marinara-fork/tools/termux/install.sh"
```

See [`tools/termux/README.md`](./tools/termux/README.md) for full details, including how it migrates your existing APK-clone chats into the shared data directory. Key facts it relies on: the file-native store lives at `<DATA_DIR>/storage/tables/*.json` (default `packages/server/data`), and the APK is only a WebView viewer on port 7860 — its "Install / Start" button force-checks-out the stock release tag, so start the server with the switcher instead.
