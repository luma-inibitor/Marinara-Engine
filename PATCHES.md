# Fork Patches

This is a long-term fork of [Pasta-Devs/Marinara-Engine](https://github.com/Pasta-Devs/Marinara-Engine).

**Branch model**

- `main` / `staging` — pristine mirrors of `upstream/main` and `upstream/staging`. **Never commit here.** They only ever get reset to upstream.
- `patch/*` — one branch per logical local change, based on upstream, kept clean so any patch could still be offered upstream later.
- `luma/main` — the integration/deploy branch you build and run: `upstream/main` + every `patch/*` applied, plus this ledger. This is the branch to check out on-device.

To see exactly what this fork changes vs. stock: `git diff main...luma/main`.

## Carried patches

### `patch/mari-unsandboxed-shell`

- **What:** Adds the opt-in env var `MARINARA_MARI_ALLOW_UNSANDBOXED_SHELL` (default `false`) so Professor Mari's `bash` tool can run on platforms with no OS sandbox — notably Android/Termux, which has neither macOS Seatbelt nor Linux bubblewrap, so `bash` otherwise fails closed. The flag only takes effect when no sandbox backend exists (it never downgrades an available Seatbelt/bubblewrap sandbox), and env secrets are still stripped from the child process; only network-deny and workspace-write confinement are dropped. Also makes Mari's sandbox system-prompt line reflect the live status (sandboxed / disabled / unsandboxed).
- **Why forked:** Upstream declined the change as a product decision. Kept locally for single-user, on-device Termux use.
- **Upstream status:** Declined / not merged.
- **Touches:** `packages/server/src/config/runtime-config.ts`, `packages/server/src/services/professor-mari/workspace-shell-sandbox.ts`, `packages/server/src/services/professor-mari/workspace-agent.service.ts`, `packages/shared/src/types/professor-mari-workspace.ts`, `scripts/regressions/professor-mari-shell-sandbox.regression.ts`, `.env.example`, `docs/CONFIGURATION.md`, `CHANGELOG.md`.

## Syncing with upstream

One-time:

```sh
git remote add upstream https://github.com/Pasta-Devs/Marinara-Engine
```

Each time you want to pull upstream forward:

```sh
git fetch upstream

# Refresh the pristine mirrors
git checkout -B main    upstream/main    && git push --force-with-lease origin main
git checkout -B staging upstream/staging && git push --force-with-lease origin staging

# Rebase each patch branch onto the new base (resolve conflicts here, once)
git checkout patch/mari-unsandboxed-shell
git rebase main
git push --force-with-lease origin patch/mari-unsandboxed-shell

# Rebuild the integration branch
git checkout -B luma/main main
git merge --ff-only patch/mari-unsandboxed-shell   # add more patch branches here as they appear
# (re-apply this PATCHES.md commit if the ff-merge doesn't already carry it)
git push --force-with-lease origin luma/main
```

Validate after every sync: `pnpm install && pnpm check`, plus `pnpm regression:professor-mari-shell-sandbox` for the shell patch specifically.
