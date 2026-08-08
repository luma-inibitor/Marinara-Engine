# Fork Workflow

This is a long-term fork of [Pasta-Devs/Marinara-Engine](https://github.com/Pasta-Devs/Marinara-Engine), maintained under [luma-inibitor/Marinara-Engine](https://github.com/luma-inibitor/Marinara-Engine). It exists to carry local patches that upstream has declined but that are useful for our own on-device (Android/Termux) use.

For the list of what's actually patched and why, see [`PATCHES.md`](./PATCHES.md). This file is the *how it all works* guide.

## Branch model

| Branch | Role | Rule |
| --- | --- | --- |
| `main` | Pristine mirror of `upstream/main` (stable releases) | **Never commit here.** Only ever reset to upstream. |
| `staging` | Pristine mirror of `upstream/staging` (bleeding edge) | **Never commit here.** Only ever reset to upstream. |
| `patch/*` | One branch per logical local change, based on `main` | Kept clean and self-contained so any patch could still be offered upstream. |
| `luma/main` | **Integration / deploy branch** — `main` + every `patch/*` + fork docs | This is what you run on-device. Rebuilt on every sync. |

`upstream` is a git remote pointing at `Pasta-Devs/Marinara-Engine`; `origin` is our fork.

**See exactly what this fork changes vs. stock:** `git diff main...luma/main`

## One-time setup (per machine / clone)

```sh
git remote add upstream https://github.com/Pasta-Devs/Marinara-Engine
git fetch upstream
```

## Everyday use

- **Deploy / run the fork:** check out `luma/main`.
- **Run stock upstream instead:** check out `main` (stable) or `staging` (bleeding edge).
- Deploy branches are *consumed, not edited*. Never make local commits on `luma/main`, `main`, or `staging` on a device — do real work on `patch/*` branches from a dev machine and let it flow through `luma/main`.
- `.env`, `node_modules/`, `packages/*/dist/`, the pnpm store, and your data directory are all gitignored, so **they survive branch switches**. Switching only swaps source code.

## Syncing with upstream

Run this whenever you want to pull upstream forward. Conflicts, if any, are resolved **once**, inside the patch branch.

```sh
git fetch upstream

# 1. Refresh the pristine mirrors
git checkout -B main    upstream/main    && git push --force-with-lease origin main
git checkout -B staging upstream/staging && git push --force-with-lease origin staging

# 2. Rebase each patch branch onto the new base (resolve conflicts here)
git checkout patch/mari-unsandboxed-shell
git rebase main
pnpm install && pnpm check          # validate the rebased patch still builds
git push --force-with-lease origin patch/mari-unsandboxed-shell

# 3. Rebuild the integration branch from the refreshed base + patches
git checkout -B luma/main main
git merge --ff-only patch/mari-unsandboxed-shell
#   ...repeat --ff-only merge for each additional patch/* branch...
#   then re-apply the fork docs commit (FORK.md / PATCHES.md) if it isn't carried
git push --force-with-lease origin luma/main
```

> Because deploy branches are force-pushed on every sync, never do local work on them — a force-push will overwrite it.

## Adding a new patch

```sh
git checkout -B patch/<short-topic> main     # branch from the pristine mirror
# ...make the change, commit it...
git push -u origin patch/<short-topic>
```

Then fold it into the deploy branch and document it:

```sh
git checkout luma/main
git merge --ff-only patch/<short-topic>   # or rebase/cherry-pick if it needs to sit on other patches
git push --force-with-lease origin luma/main
```

Add a section for it in [`PATCHES.md`](./PATCHES.md): what it does, why it's forked, its upstream status, and the files it touches.

## Retiring a patch (e.g. upstream adopted it)

1. On your next sync, after `git rebase main`, if the patch becomes empty (`git rebase` reports "no changes — did you forget to `git add`?" or the diff is gone), upstream now ships it.
2. Stop merging that `patch/*` branch into `luma/main`, delete the branch (`git branch -D` / `git push origin --delete`), and remove its section from `PATCHES.md`.

## Validating after any sync or new patch

```sh
pnpm install
pnpm check                                    # TypeScript + ESLint + build
pnpm regression:professor-mari-shell-sandbox  # for the shell patch specifically
```

## Running on Android / Termux

The stock `start-termux.sh` auto-updates only `main`/`staging` and lives *inside* the repo (so it changes when you switch branches). To switch cleanly between the fork and mainline on-device, use an **external** switcher script that lives in `$HOME` (outside the repo), checks out the target branch, and then delegates to `./start-termux.sh --skip-update`. See `PATCHES.md` / the switcher script for the current setup.
