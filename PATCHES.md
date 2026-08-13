# Fork Patches (Ledger)

The list of local patches this fork carries on top of upstream. For the branch model and the sync/deploy workflow, see [`FORK.md`](./FORK.md).

Quick reference: the live delta vs. stock is `git diff staging...luma/staging`.

**Base:** these patches are rebased onto `staging` (upstream's beta channel), not `main`. See [`FORK.md`](./FORK.md) for why, including the storage-format warning.

## Carried patches

### `patch/mari-unsandboxed-shell`

- **What:** Adds the opt-in env var `MARINARA_MARI_ALLOW_UNSANDBOXED_SHELL` (default `false`) so Professor Mari's `bash` tool can run on platforms with no OS sandbox — notably Android/Termux, which has neither macOS Seatbelt nor Linux bubblewrap, so `bash` otherwise fails closed. The flag only takes effect when no sandbox backend exists (it never downgrades an available Seatbelt/bubblewrap sandbox), and env secrets are still stripped from the child process; only network-deny and workspace-write confinement are dropped. Also makes Mari's sandbox system-prompt line reflect the live status (sandboxed / disabled / unsandboxed).
- **Why forked:** Upstream declined the change as a product decision. Kept locally for single-user, on-device Termux use.
- **Upstream status:** Declined / not merged.
- **Staging rebase note:** the prompt-line commit conflicts with staging's Mari work in `workspace-agent.service.ts` (one bullet). Resolution: keep the `%%MARI_SHELL_SANDBOX_LINE%%` token and mirror staging's current tool list into `mariShellSandboxPromptLine()`. The CHANGELOG hunk was dropped to avoid a conflict on every sync.
- **Touches:** `packages/server/src/config/runtime-config.ts`, `packages/server/src/services/professor-mari/workspace-shell-sandbox.ts`, `packages/server/src/services/professor-mari/workspace-agent.service.ts`, `packages/shared/src/types/professor-mari-workspace.ts`, `scripts/regressions/professor-mari-shell-sandbox.regression.ts`, `.env.example`, `docs/CONFIGURATION.md`, `CHANGELOG.md`.

### `patch/chat-search`

- **What:** In-chat message search ("Find in chat") — a search panel and toolbar/overflow entry point, naive client-side matching over the loaded transcript, jump-by-message-id so results survive duplicate paginated entries, newest-first ordering, light-mode-legible highlighting, and a `/goto` fix so jumps can reach messages outside the mounted render window. Ships its own `chat-search` and `transcript-render-window` regressions and an English localization block.
- **Why forked:** Feature work developed on our fork (branch `claude/chat-search-ui-ux-h6qgyu`), carried until upstream takes it.
- **Upstream status:** Not submitted. Self-contained and client-side, so it should port cleanly.
- **Touches:** `packages/client/src/components/chat/*` (incl. new `ChatSearchPanel.tsx`, `ChatSearchButton.tsx`), `packages/client/src/lib/chat-search.ts`, `packages/client/src/lib/transcript-render-window.ts`, `packages/client/src/hooks/use-chat-search.ts`, `packages/client/src/stores/chat.store.ts`, `packages/client/src/styles/globals.css`, `packages/client/src/localization/locales/en.json`, `scripts/regressions/chat-search.regression.ts`, `scripts/regressions/transcript-render-window.regression.ts`, `package.json` (two regression scripts), `docs/chats/*`.

### `patch/fork-tooling`

- **What:** The fork's own files — `FORK.md`, `PATCHES.md`, `tools/fork/` (the patch-queue rebuild script), and `tools/termux/` (the on-device switcher, installer, and dev runner). Applied last so it never fights a code patch.
- **Why forked:** Fork infrastructure; never intended for upstream.
- **Upstream status:** N/A — fork-only.
- **Touches:** `FORK.md`, `PATCHES.md`, `tools/`.

### `patch/capability-relink-node-modules`

- **What:** Makes `CapabilityModuleRuntime.ensureModuleResolution()` remove a stale `capability-packages/node_modules` symlink before recreating it. Its `existsSync(link)` guard follows symlinks, so a *dangling* link reads as absent, then `symlink()` throws `EEXIST` and host dependency resolution stays broken — packages whose server entrypoint imports a host dep (`pino`, `zod`) fail to activate and roll back on every restart, producing an endless "update agents" loop.
- **Why forked:** Surfaced by our two-clone setup: `capability-packages/` lives under the shared `DATA_DIR`, and migrating the data + renaming the old clone left the link pointing at a path that no longer exists. This is a genuine upstream bug (any moved/removed checkout triggers it), so it is a candidate to submit upstream.
- **Upstream status:** Not yet submitted (candidate). Still unfixed on staging as of 2.4.2, and it rebases cleanly.
- **Touches:** `packages/server/src/services/capability-packages/capability-module-runtime.service.ts`.
- **Operational note:** Existing installs with an already-dangling link self-heal on the next boot once this patch is deployed. To fix immediately without redeploying, delete the link and relaunch: `rm -f "$DATA_DIR/capability-packages/node_modules"`.
