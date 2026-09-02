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

### `patch/fork-upstream-diagnostics`

- **What:** Teaches the build to resolve its _fork base_ — the newest upstream commit the running checkout contains — and reports it wherever version details already appear. `/api/health` gains a `fork` object (`repo`, `branch`, `baseRef`, `baseCommit`, `baseVersion`, `commitsAhead`); the copied support diagnostics gain `Fork` / `Upstream version` / `Upstream build` / `Upstream commit` lines under the existing `Commit` line; the Updates card gains matching `Fork:` and `Upstream base:` rows. The base is found by taking the merge base of `HEAD` against `upstream/staging`, `upstream/main`, `origin/staging`, `origin/main` and keeping whichever leaves the fewest local commits, so a stock `main` checkout is not mistaken for a fork of `staging`. An optional root `fork-base.json` overrides that search (see below). Resolution order is the build-time snapshot in `build-meta.json`, then `MARINARA_FORK_INFO`, then the live checkout, so container and packaged installs keep reporting it without a `.git` directory.
- **Why forked:** A support ticket filed from this fork was indistinguishable from one filed against stock upstream — the version, build, and commit all described our build, with nothing naming the upstream release it was built from. Whoever reads the ticket needs both.
- **Upstream status:** Not submitted. Written to be upstream-offerable — it is generic fork-detection with no reference to this fork, and everything it adds is omitted entirely when the checkout carries no local commits, so stock output is byte-for-byte unchanged. Worth offering if upstream wants it.
- **Pairs with:** `patch/fork-tooling`, which writes the `fork-base.json` stamp onto the integration branch. The two are independent — the patch falls back to the merge-base search when the stamp is absent, and the stamp is inert without the patch.
- **Touches:** `packages/server/src/config/build-info.ts`, `packages/server/scripts/write-build-meta.mjs`, `packages/server/src/app.ts`, `packages/client/src/lib/support-diagnostics.ts`, `packages/client/src/components/panels/SettingsPanel.tsx`, `packages/client/src/localization/locales/en.json`, `scripts/regressions/open-issues.regression.ts`.

### `patch/fork-tooling`

- **What:** The fork's own files — `FORK.md`, `PATCHES.md`, `tools/fork/` (the patch-queue rebuild script — `apply-patches.mjs`, plain Node with no dependencies, launched by the `apply-patches.sh` shim), and `tools/termux/` (the on-device switcher, installer, and dev runner). Applied last so it never fights a code patch. The rebuild script fetches both remotes and refuses to build from stale or diverged local patch branches, audits the old integration branch for commits the rebuild would drop, and stamps the base it built on — plus the patch heads it built from — into a root `fork-base.json` commit on the integration branch, which `patch/fork-upstream-diagnostics` reads.
- **Why forked:** Fork infrastructure; never intended for upstream.
- **Upstream status:** N/A — fork-only.
- **Touches:** `FORK.md`, `PATCHES.md`, `tools/`, and `fork-base.json` (written onto the integration branch, never onto a patch branch).

### `patch/capability-relink-node-modules`

- **What:** Makes `CapabilityModuleRuntime.ensureModuleResolution()` remove a stale `capability-packages/node_modules` symlink before recreating it. Its `existsSync(link)` guard follows symlinks, so a _dangling_ link reads as absent, then `symlink()` throws `EEXIST` and host dependency resolution stays broken — packages whose server entrypoint imports a host dep (`pino`, `zod`) fail to activate and roll back on every restart, producing an endless "update agents" loop.
- **Why forked:** Surfaced by our two-clone setup: `capability-packages/` lives under the shared `DATA_DIR`, and migrating the data + renaming the old clone left the link pointing at a path that no longer exists. This is a genuine upstream bug (any moved/removed checkout triggers it), so it is a candidate to submit upstream.
- **Upstream status:** Not yet submitted (candidate). Still unfixed on staging as of 2.4.2, and it rebases cleanly.
- **Touches:** `packages/server/src/services/capability-packages/capability-module-runtime.service.ts`.
- **Operational note:** Existing installs with an already-dangling link self-heal on the next boot once this patch is deployed. To fix immediately without redeploying, delete the link and relaunch: `rm -f "$DATA_DIR/capability-packages/node_modules"`.

### `patch/ambient-sky`

- **What:** Rebuilds the roleplay weather overlay's visuals (`WeatherEffects` canvas) while keeping its contract — a transparent, alpha-capped layer above the user's chat background — and its free-text parsing pipeline intact. Adds a keyframed sky wash interpolated across the hour, a seeded star field with twinklers/meteors/galactic band, per-weather-family moods (three-layer parallax cloud deck, translucent veil, fog banks, shared wind field, `bodyDim` so storms dim the moon instead of deleting it), aurora curtain rendering, and "luminous" celestial bodies: an opaque sun disc with elevation-driven reddening and horizon-only refraction flattening, and a moon with a true lunar phase (elliptical terminator, earthshine, maria) derived from the tracker's free-text `date` via `deriveMoonPhase()`. All glow is alpha-composited (never additive) so the layer survives light chat backgrounds. Lightning keeps its epilepsy-safe alpha ceiling, decay, and cadence but strikes from a sky point with a brief bolt. Both render paths (OffscreenCanvas worker and main-thread fallback) share the new `AmbientScene`; DPR/pixel caps, pause states, `weatherEffects` toggle, and reduced-motion behavior are unchanged.
- **Why forked:** Visual immersion pass for our own roleplay use, developed against the Sky Bench / Sun & Moon Studies artifacts. Written to be upstream-offerable: self-contained in the weather layer, no new dependencies, parse tables untouched.
- **Upstream status:** Not yet submitted (candidate). If offered, the open decisions are documented in the handoff spec (moon-phase source, `sunsetGlow` field retirement — the field is still computed but no longer drawn).
- **Validation:** `pnpm check`, `node ./scripts/run-regressions.mjs --filter scripts/regressions/ambient-sky.regression.ts` (new auto-discovered lane: moods, scene activation, sky palette bounds, moon-phase parsing, wind bounds), plus UI-harness screenshots of the seeded roleplay fixture across night/dusk/noon/storm/snow/fog on both the worker and forced-fallback paths. The crossfade fix was verified end-to-end with the World State agent + mock provider: a MutationObserver confirmed the old build remounted the canvas twice per tracker update (the flash) and the fixed build keeps one canvas alive with zero removals.
- **Third commit:** adds user tuning knobs (Settings → Appearance → Atmosphere → Effect tuning): sky intensity, wind, cloud density, god rays, rain amount/speed, snow amount/gravity/flutter/size. Multipliers around the stock look, persisted in the UI store, applied live to both render paths without a remount; alpha caps still bound the washes.
- **Second commit:** fixes the world-tracker flash (config changes now stream to the living canvas as messages and crossfade over ~2.5 s instead of remounting through a fresh worker handshake; particles turn over gradually) and ports the Halcyon v2 visuals: `mood.murk` overcast diffusion of the bodies, moonlight/day-lift grades, deeper night palette, cloud rim lighting, low-res additive god rays, and depth-layered snow with gust turbulence.
- **Touches:** `packages/client/src/lib/weather-renderer.ts`, `packages/client/src/components/chat/WeatherEffects.tsx`, `packages/client/src/components/chat/ChatRoleplaySurface.tsx`, `packages/client/src/workers/weather-effects.worker.ts`, `scripts/regressions/ambient-sky.regression.ts` (auto-discovered by `scripts/run-regressions.mjs`; no `package.json` change).

### `patch/weather-resize-repaint`

- **What:** Keeps the roleplay weather layer painted when its canvas is resized while ambient rendering is suspended. `ChatRoleplaySurface` pauses the layer whenever the mobile composer takes focus; the app's viewport meta uses `interactive-widget=resizes-content`, so on Android the software keyboard then shrinks the layout viewport and the parent `ResizeObserver` fires. Assigning `canvas.width`/`canvas.height` clears the canvas, and neither render path repainted it: the worker's resize handler already tried to (its comment says why) but routed through `drawFrame()`, which early-returns while `hidden`; the main-thread fallback never repainted on resize at all, relying on the next rAF tick, and the rAF loop is stopped while paused. Either way the weather vanished for as long as the keyboard was up. `drawFrame()` now takes `{ advanceSimulation, whileSuspended }` and the resize repaint passes both, so it redraws statically without restarting the frame timer; the fallback's draw code is extracted into `renderFrame(frameScale)` and called with `0` from `resize()`. Drawing logic itself is unchanged.
- **Why forked:** Reported from our own Android use — the weather disappeared whenever the keyboard opened. Nothing fork-specific: the defect is in stock `staging` and reproduces identically on the pre-`patch/ambient-sky` code.
- **Upstream status:** Not yet submitted (candidate). Written to be upstream-offerable: minimal, self-contained in the weather layer, no new dependencies, no behavior change while unpaused. Worth offering.
- **Ordering — must stay after `patch/ambient-sky`:** both rewrite `WeatherEffects.tsx` and `weather-effects.worker.ts`, and `patch/ambient-sky` restructures the same fallback render region into `AmbientScene`. Applied last, a hunk that fails to carry forward is a loud cherry-pick conflict; applied first, `patch/ambient-sky`'s rewrite could silently take its own side of the conflict and quietly reintroduce the bug. `patch/ambient-sky` does **not** fix this itself — it kept both the `hidden` guard in `drawFrame()` and the `drawFrame(now, false)` resize repaint verbatim.
- **Rebase note:** the regression's last assertion greps `WeatherEffects.tsx` for a repaint call inside `const resize = () => { … }`. That is a source-text check standing in for a fallback path that is awkward to drive headlessly, so it is coupled to the surrounding structure — when this patch rebases onto `patch/ambient-sky`, re-point it at whatever that rewrite calls to repaint rather than deleting it. The worker half of the lane drives the real worker and is structure-agnostic.
- **Validation:** `pnpm check`, and `node ./scripts/run-regressions.mjs --filter scripts/regressions/weather-effects-suspended-repaint.regression.ts` (new auto-discovered lane; no `package.json` change). The lane was negative-tested by reverting only the two source files and confirming it fails on the unfixed code. Also reproduced in Chromium against the real esbuild-bundled worker with a real `OffscreenCanvas`: after suspend + resize the pre-fix canvas is empty and the fixed one still shows the frozen scene at the new size. **Not yet verified on a physical Android device** — the keyboard's viewport resize was emulated, not driven by a real soft keyboard.
- **Touches:** `packages/client/src/workers/weather-effects.worker.ts`, `packages/client/src/components/chat/WeatherEffects.tsx`, `scripts/regressions/weather-effects-suspended-repaint.regression.ts`.

### `patch/impersonate-copy-button`

- **What:** Adds a copy button to both impersonation blocks of the stored-guidance modal (`GenerationReplayDetailsModal`), which reached it with one only on the guided block. `TextBlock` hardcoded the guided label, tooltip, and toasts into its button; it now takes a `CopyAction` — clipboard payload plus its own strings — and all three blocks supply one. Guided keeps copying `/guided <direction>` unchanged; the impersonation guidance copies `/impersonate <direction>`, which replays the same generation the way `applyGenerationReplayToRegenerateInput` already reconstructs it; the impersonation prompt template copies verbatim, because it is a stored setting rather than a command (`/impersonate_prompt` writes a different field, chat metadata's `impersonatePrompt`). Seven English catalog keys are added; no other locale is touched, and the checker requires no coverage from them.
- **Why forked:** Noticed in our own roleplay use — the guided prompt could be lifted out of the modal and the impersonation prompt could only be read. Nothing here is fork-specific.
- **Upstream status:** Not yet submitted (candidate). Written to be upstream-offerable: it is a self-contained UI fix in one component plus its catalog keys, with no fork references and no change to stored data or the generation path.
- **Validation:** `pnpm check`, and `node ./scripts/run-regressions.mjs --filter scripts/regressions/generation-replay-copy.regression.ts` (new auto-discovered lane; no `package.json` change). Verified in the UI harness against the seeded roleplay fixture with the mock provider: `/impersonate` and `/guided` each generated, and the modal's buttons were clicked and the clipboard read back — `/impersonate <direction>`, the template verbatim, and `/guided <direction>` unchanged. The lane was negative-tested by removing the `copy` prop and confirming it fails.
- **Touches:** `packages/client/src/components/chat/GenerationReplayDetailsModal.tsx`, `packages/client/src/localization/locales/en.json`, `scripts/regressions/generation-replay-copy.regression.ts`.

## Retired patches

### `patch/back-dismiss-overlays` — retired on the 2.4.4 sync

Upstream adopted this patch verbatim. `24c94af15 feat(client): dismiss the topmost overlay on hardware/gesture back` is our own commit, and all six files it added are now on `staging` byte-for-byte identical to ours apart from the follow-up below. The branch rebased to empty on this sync, so it was retired rather than carried.

Upstream then fixed a real race in it (`27d175cdb fix: address issue sweep review findings`): `armSentinel()` now also bails while `pendingSelfPops > 0`, and the self-pop branch of `handlePopState()` re-arms once the last pending pop lands and layers remain. A cleanup `history.back()` cannot be cancelled once requested, so our version could push a sentinel that the in-flight back immediately ate, leaving the stack unarmed while an overlay was still open. Their `back-navigation.regression.ts` gained 12 lines covering it.

Both known gaps recorded here while the patch was carried are still open upstream, and are still candidate follow-up patches:

- `ChatSettingsDrawer`'s and `GameSurface`'s floating panels hold open state in component-local `useState`, so they are not layers — back still exits the app when only one of those is open.
- `Modal.tsx`'s Escape handler is a bare `document` keydown listener with no stack guard, so one Escape closes two stacked modals. The `use-back-dismiss` registry is the right place to fix it.

The branch is deleted locally and on the remote; the work lives on in upstream's history.

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
