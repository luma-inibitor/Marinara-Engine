# Fork Patches (Ledger)

The list of local patches this fork carries on top of upstream. For the branch model and the sync/deploy workflow, see [`FORK.md`](./FORK.md).

Quick reference: the live delta vs. stock is `git diff staging...luma/staging`.

**Base:** these patches are rebased onto `staging` (upstream's beta channel), not `main`. See [`FORK.md`](./FORK.md) for why, including the storage-format warning.

## Carried patches

### `patch/mari-unsandboxed-shell`

- **What:** Adds the opt-in env var `MARINARA_MARI_ALLOW_UNSANDBOXED_SHELL` (default `false`) so Professor Mari's `bash` tool can run on platforms with no OS sandbox — notably Android/Termux, which has neither macOS Seatbelt nor Linux bubblewrap, so `bash` otherwise fails closed. The flag only takes effect when no sandbox backend exists (it never downgrades an available Seatbelt/bubblewrap sandbox), and env secrets are still stripped from the child process; only network-deny and workspace-write confinement are dropped. Also makes Mari's sandbox system-prompt line reflect the live status (sandboxed / disabled / unsandboxed).
- **Why forked:** Upstream declined the change as a product decision. Kept locally for single-user, on-device Termux use.
- **Upstream status:** Declined / not merged.
- **Staging rebase note:** the prompt-line commit conflicts with staging's Mari work in `workspace-agent.service.ts` (one bullet). Resolution: keep the `%%MARI_SHELL_SANDBOX_LINE%%` token and mirror staging's current tool list into `mariShellSandboxPromptLine()`. The CHANGELOG hunk was dropped to avoid a conflict on every sync. Since 2.4.3 the shell spawner is the generic `spawnWorkspaceSandboxedProcess({ executable, args })`, so the Termux shell resolution moved up into `spawnWorkspaceSandboxedShell()`; `mari db transform` also consumes the sandbox status, and the patch explicitly excludes the `unsandboxed` backend there so untrusted transform scripts keep requiring a real OS sandbox behind their own `MARI_DB_ALLOW_UNSAFE_TRANSFORMS` gate.
- **Touches:** `packages/server/src/config/runtime-config.ts`, `packages/server/src/services/professor-mari/workspace-shell-sandbox.ts`, `packages/server/src/services/professor-mari/workspace-agent.service.ts`, `packages/shared/src/types/professor-mari-workspace.ts`, `packages/server/src/services/mari-db/mari-transform-sandbox.ts`, `scripts/regressions/professor-mari/shell-sandbox.regression.ts`, `.env.example`, `docs/CONFIGURATION.md`.

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

## Retired patches

### `patch/chat-search` — retired on the 2.4.3 sync

Upstream shipped its own in-chat search (`packages/client/src/components/chat/ChatMessageSearch.tsx`, PR #4962 "simple chat search"): a toolbar-anchored Find panel with normalized literal matching, snippets, hidden-message filtering, and jump-to-message. Our version duplicated it, so the branch was retired rather than carried as a second Find entry point.

The same upstream work also landed an equivalent of the branch's one non-search commit — the `/goto` transcript-window fix. Staging's `ConversationView` and `ChatRoleplaySurface` now move the render window onto a pending jump target themselves, and `ChatArea` resolves the target by message **id** via `messageIdByOrderIndex` and paginates older pages until it is loaded. Carrying ours on top redeclared `gotoRequest` in both surfaces and failed the build, so it was retired too.

Deltas ours had that upstream's does not, kept here as candidate follow-up patches:

- The jump target is centred in the render window (`getTranscriptWindowStartForIndex`) instead of pinned as the first mounted message, so it lands with context above it.
- `ChatArea` retries the post-jump DOM lookup for a bounded number of frames rather than looking once on the next animation frame and clearing the request either way.
- Search results ordered newest-first.
- Search result highlight legible in light mode.
- Search panel dismissed when a mobile shell drawer opens.
- Search entry point in the chat toolbar overflow menu rather than an always-visible toolbar icon.

The old branch is still on the remote as `patch/chat-search` (based on 2.4.2's `staging`) if any of that needs to be recovered.
