# Termux fork/mainline switcher

Tooling to run this fork *and* stock upstream side-by-side on Android/Termux, switching between them instantly and sharing one set of chats.

## What it sets up

- `~/Marinara-fork` — this fork, branch `luma/main`
- `~/Marinara-main` — stock upstream, branch `main`
- `~/marinara-data` — a shared data directory both clones point at via `DATA_DIR`, so your chats/characters are identical on either channel
- `~/.local/bin/marinara` — the switcher command (lives outside the repos on purpose, so switching never rewrites it)
- `~/.shortcuts/Marinara Fork` and `~/.shortcuts/Marinara Mainline` — [Termux:Widget](https://f-droid.org/packages/com.termux.widget/) home-screen shortcuts

The fork clone's `.env` also gets `MARINARA_MARI_ALLOW_UNSANDBOXED_SHELL=true` so Professor Mari's `bash` tool works on-device (see [`../../PATCHES.md`](../../PATCHES.md)).

## Install

In Termux:

```sh
git clone --branch luma/main https://github.com/luma-inibitor/Marinara-Engine "$HOME/Marinara-fork"
bash "$HOME/Marinara-fork/tools/termux/install.sh"
```

The installer is interactive and idempotent. If you already run Marinara from the APK's `~/Marinara-Engine` clone, it offers to **migrate your existing chats** into `~/marinara-data` and **reuse that clone** as the mainline one (no second big download).

Then install **Termux:Widget** from F-Droid and add its widget to your home screen.

## Use

- **Home screen:** tap **Marinara Fork** or **Marinara Mainline**.
- **Terminal:** `marinara` (menu), or `marinara fork` / `marinara main` / `marinara status`.

Each launch fast-forwards that clone to its remote tip (no-op if already current, so no needless rebuild), then runs the checkout's own `start-termux.sh --skip-update`. The **APK is only the viewer** — start the server with the switcher first, then open the APK. Don't use the APK's "Install / Start" button; it force-checks-out stock into `~/Marinara-Engine` and bypasses this setup.

## How it works (and why it's laid out this way)

- The switcher **owns git updates** and passes `--skip-update` to the launcher, because the stock `start-termux.sh` auto-update only understands `main`/`staging` and would do nothing useful (or warn) on `luma/main`.
- Two clones instead of one branch-switching clone → **instant** switches with no rebuild, at the cost of disk. Data is shared anyway via `DATA_DIR`.
- Sharing one data dir is safe because the fork is `main` + patches (same app/schema version). If you ever intentionally run genuinely different versions on the two channels, give each its own `DATA_DIR` to avoid a newer schema migration locking out the older code.

## Configuration

Override any path/remote via environment variables (defaults shown):

| Variable | Default |
| --- | --- |
| `MARINARA_FORK_DIR` | `~/Marinara-fork` |
| `MARINARA_MAIN_DIR` | `~/Marinara-main` |
| `MARINARA_DATA_DIR` | `~/marinara-data` |
| `MARINARA_FORK_REMOTE` | `https://github.com/luma-inibitor/Marinara-Engine` |
| `MARINARA_FORK_BRANCH` | `luma/main` |
| `MARINARA_MAIN_REMOTE` | `https://github.com/Pasta-Devs/Marinara-Engine` |
| `MARINARA_MAIN_BRANCH` | `main` |

## Update / uninstall

- **Update the switcher itself:** `cd ~/Marinara-fork && git pull && bash tools/termux/install.sh` (re-run is safe).
- **Uninstall:** delete `~/.local/bin/marinara`, the two files in `~/.shortcuts/`, and (if you want) the clones. Your data stays in `~/marinara-data`.
