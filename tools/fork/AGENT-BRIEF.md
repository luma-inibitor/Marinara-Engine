# Agent brief

The canonical text to paste into a fresh Claude session when asking it to build a
feature or fix a bug on this fork. Keep it in sync with `FORK.md` and
`tools/fork/patches.list`; everything below deliberately points at in-repo docs
rather than restating them, so it ages well.

---

I work on a long-term fork of Marinara Engine. Before writing any code, read these in the repo and follow them:

- `FORK.md` — fork branch model and the sync/patch workflow (**read first**)
- `PATCHES.md` — the patch ledger: what we carry and why
- `CLAUDE.md` and `CONTRIBUTING.md` — the project's own conventions
- `packages/client/.instructions.md` — **required** before touching any client code

**Repo:** `luma-inibitor/Marinara-Engine` (fork of `Pasta-Devs/Marinara-Engine`).
If it isn't already available, clone it and add the upstream remote:

```sh
git clone https://github.com/luma-inibitor/Marinara-Engine
cd Marinara-Engine
git remote add upstream https://github.com/Pasta-Devs/Marinara-Engine
git fetch upstream
```

## Branch rules (important)

- We track **`staging`**, not `main`. Base all work on `staging`.
- **Never commit to** `staging`, `main` (pristine upstream mirrors) or `luma/staging` (the integration/deploy branch, force-pushed on every sync).
- New work goes on its own patch branch: `git checkout -B patch/<short-topic> staging`
- Keep each patch **self-contained and minimal** so it can be rebased forward forever and still be offered upstream. Don't bundle unrelated changes.
- **Do not edit `CHANGELOG.md`** in a patch — nearly every upstream commit touches it, so it conflicts on every sync. `PATCHES.md` is our record.
- **Syncs and in-flight work must not overwrite each other.** If you run a sync: `git fetch origin --prune` immediately before rebuilding, and never force-push a `patch/*` branch whose origin tip you have not integrated (the sync script enforces both; push with `--force-with-lease --force-if-includes`). If a sync moves branches under _you_ mid-session: fetch, then cherry-pick your commits onto the moved refs — never force-push your old history back over the sync.
- **A hotfix cherry-picked straight onto `luma/staging` must also land on its owning `patch/*` branch** before the next sync, or the rebuild will flag it (and, with `--skip-audit`, drop it). The patch branches are the source of truth; the integration branch is a build product.

When the patch is done:

1. Add the branch to `tools/fork/patches.list` (before `patch/fork-tooling`, which stays last).
2. Add a section to `PATCHES.md`: what it does, why it's forked, upstream status, files touched.
3. Rebuild and validate the integration branch:
   ```sh
   tools/fork/apply-patches.sh --check
   ```
   It rebases the queue and rebuilds `luma/staging`. It pushes nothing — it prints the push commands. Run `tools/fork/apply-patches.sh --help` for flags.

## Validating

```sh
pnpm install
pnpm check                 # TypeScript + ESLint + build — must pass
```

There is no conventional unit-test suite; use the tracked regression lanes. Run the ones related to your change (`pnpm regression:<name>`, see `package.json`), and add a new `scripts/regressions/*.regression.ts` for meaningful new behavior.

## UI/UX work — use the exploration harness

For anything visual, or when you need populated chats to look at, use our harness instead of hand-rolling test data. It needs **no API key** — it ships a mock LLM provider.

```sh
git clone https://github.com/luma-inibitor/st-notes ~/st-notes
```

Read `~/st-notes/marinara/ui-ux-exploration-harness.md` **in full** before using it, plus `~/st-notes/marinara/scripts/fixtures/README.md` for the fixture format. It covers standing up a local instance, the mock provider, seeding fixtures, and driving Chromium with Playwright for screenshots — including a troubleshooting section that will save you a lot of time (icon-only controls, hidden checkboxes, tutorial popovers, the CONVO/RP/GM sidebar tabs).

The three shipped fixtures give you a populated instance in under a minute — one chat per mode (conversation / roleplay / game), with realistic timestamps and enough history to exercise paging:

```sh
H=~/st-notes/marinara/scripts
node $H/seed-chat.mjs --base-url http://127.0.0.1:7860 --file $H/fixtures/conversation-late-shift.json
node $H/seed-chat.mjs --base-url http://127.0.0.1:7860 --file $H/fixtures/roleplay-stoke-moran.json
node $H/seed-chat.mjs --base-url http://127.0.0.1:7860 --file $H/fixtures/game-ashfall-contract.json
```

Seeding conversation/roleplay needs no connection; the game fixture needs a connection record to exist (nothing generates — the world comes from the fixture JSON).

## Guardrails

- **Don't open a PR unless I ask.** Push the patch branch; tell me what you'd put in the PR.
- Never auto-check validation or test-plan checkboxes — those are mine to tick.
- Server code uses the shared Pino logger, never `console.*`; client code keeps `console.*`. See `CLAUDE.md § Logging`.
- Don't revert or "clean up" unrelated work in the tree.
- Storage note: `staging` is storage format 6, `main` is 5, and the sharding migration is **one-way**. Never point an older build at a newer data directory, and never suggest doing so — current builds refuse to open newer data and the launcher blocks the downgrade, but pre-#4708 builds will happily overwrite it.

Tell me up front if my request would be better as two patches, or if it can't be kept self-contained.
