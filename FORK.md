# Fork Workflow

This is a long-term fork of [Pasta-Devs/Marinara-Engine](https://github.com/Pasta-Devs/Marinara-Engine), maintained under [luma-inibitor/Marinara-Engine](https://github.com/luma-inibitor/Marinara-Engine). It exists to carry local patches that upstream has declined but that are useful for our own on-device (Android/Termux) use.

For the list of what's actually patched and why, see [`PATCHES.md`](./PATCHES.md). This file is the *how it all works* guide.

## Branch model

| Branch | Role | Rule |
| --- | --- | --- |
| `staging` | Pristine mirror of `upstream/staging` — **the base we track** (beta channel) | **Never commit here.** Only ever reset to upstream. |
| `main` | Pristine mirror of `upstream/main` (stable releases) | **Never commit here.** Kept for reference/rollback. |
| `patch/*` | One branch per logical local change, based on `staging` | Kept clean and self-contained so any patch could still be offered upstream. |
| `luma/staging` | **Integration / deploy branch** — `staging` + every `patch/*` + fork docs | This is what you run on-device. Rebuilt on every sync. |
| `luma/main` | Previous stable-based integration branch | Frozen. Storage-incompatible with `luma/staging` — see the warning below. |

> **⚠️ Storage format is a one-way door.** `main` (2.4.1) uses storage version 2; `staging` (2.4.2) uses version 4 and performs a **one-way** monolith→per-chat-shard migration of `messages`, `message_swipes`, `memory_chunks`, `chat_images`, `agent_runs`, and `agent_memory`. Staging refuses to open newer data; **`main` has no such guard** — it finds no `tables/messages.json`, loads messages as empty, and flushes a v2 manifest over your v4 store. Staging preserves the originals as `.pre-shard` and quarantines the downgrade artifact, so it is recoverable, but **never point a v2 build and a v4 build at the same `DATA_DIR`.** Both deploy channels track staging for exactly this reason. Back up `~/marinara-data` before the first staging boot.

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
- Deploy branches are *consumed, not edited*. Never make local commits on `luma/staging`, `staging`, or `main` on a device — do real work on `patch/*` branches from a dev machine and let it flow through `luma/staging`.
- `.env`, `node_modules/`, `packages/*/dist/`, the pnpm store, and your data directory are all gitignored, so **they survive branch switches**. Switching only swaps source code.

## Syncing with upstream

**Use the script.** It refreshes the mirror, rebases every patch in `tools/fork/patches.list`, and rebuilds the integration branch:

```sh
tools/fork/apply-patches.sh --check
```

It pushes nothing — it prints the exact push commands when the result looks right. On a real conflict it stops with the failing patch and the commands to resolve it; re-run with `--no-fetch` to continue. Conflicts that are only in `CHANGELOG.md` are resolved automatically (keeping upstream's copy), since nearly every upstream commit touches that file.

Useful flags: `--list` (show the queue), `--base <ref>` (default `upstream/staging`), `--into <branch>` (default `luma/staging`), `--no-fetch`.

To enable or disable a patch, edit `tools/fork/patches.list` and re-run. Order matters; `patch/fork-tooling` stays last.

<details>
<summary>The same thing by hand</summary>

```sh
git fetch upstream

# 1. Refresh the pristine mirrors
git checkout -B staging upstream/staging && git push --force-with-lease origin staging
git checkout -B main    upstream/main    && git push --force-with-lease origin main

# 2. Rebase each patch branch onto the new base (resolve conflicts here)
git checkout patch/mari-unsandboxed-shell
git rebase staging
pnpm install && pnpm check          # validate the rebased patch still builds
git push --force-with-lease origin patch/mari-unsandboxed-shell

# 3. Rebuild the integration branch from the refreshed base + patches
git checkout -B luma/staging staging
git cherry-pick <patch commits> && git cherry-pick <fork docs/tooling commits>
#   ...cherry-pick each patch/* branch's commits, then the fork docs/tooling commits...
git push --force-with-lease origin luma/staging
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

The stock `start-termux.sh` auto-updates only `main`/`staging` and lives *inside* the repo (so it changes when you switch branches). The switcher in [`tools/termux/`](./tools/termux/) works around this: it runs two clones (`~/Marinara-fork` on `luma/staging` and `~/Marinara-main` on stock `staging`) that share one data directory (`~/marinara-data`), so you flip between fork and mainline instantly with identical chats, launched from Termux:Widget home-screen icons.

Install on-device:

```sh
git clone --branch luma/staging https://github.com/luma-inibitor/Marinara-Engine "$HOME/Marinara-fork"
bash "$HOME/Marinara-fork/tools/termux/install.sh"
```

See [`tools/termux/README.md`](./tools/termux/README.md) for full details, including how it migrates your existing APK-clone chats into the shared data directory. Key facts it relies on: the file-native store lives at `<DATA_DIR>/storage/tables/*.json` (default `packages/server/data`), and the APK is only a WebView viewer on port 7860 — its "Install / Start" button force-checks-out the stock release tag, so start the server with the switcher instead.
