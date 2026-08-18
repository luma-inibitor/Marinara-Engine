import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_VERSION } from "@marinara-engine/shared";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SERVER_ROOT = resolve(__dirname, "../..");
const MONOREPO_ROOT = resolve(SERVER_ROOT, "../..");
const BUILD_META_PATH = resolve(__dirname, "build-meta.json");
const COMMIT_LENGTH = 12;
const GIT_TIMEOUT_MS = 5_000;
// Ordered by preference; the candidate whose merge base leaves the fewest local
// commits wins, so a stock checkout of `main` is not mistaken for a fork of
// `staging` (and vice versa).
const FORK_BASE_REF_CANDIDATES = ["upstream/staging", "upstream/main", "origin/staging", "origin/main"];
// Optional stamp a fork's release tooling can commit to pin the exact base it
// built on. Preferred over the merge-base search, whose answer is only as fresh
// as the checkout's remote-tracking refs.
const FORK_BASE_STAMP_PATH = resolve(MONOREPO_ROOT, "fork-base.json");

/**
 * Where this checkout sits relative to the upstream branch it was forked from.
 * `null` for a stock checkout — a build with no local commits on top of an
 * upstream ref reports nothing extra.
 */
export type ForkInfo = {
  /** Repository slug of the `origin` remote, e.g. `luma-inibitor/Marinara-Engine`. */
  repo: string | null;
  /** Checked-out branch, or `null` when detached. */
  branch: string | null;
  /** Ref the base commit was resolved against, e.g. `origin/staging`. */
  baseRef: string;
  /** Short SHA of the newest upstream commit this build contains. */
  baseCommit: string;
  /** `package.json` version at `baseCommit`. */
  baseVersion: string | null;
  /** Local commits carried on top of `baseCommit`. */
  commitsAhead: number;
};

type BuildMeta = {
  commit?: string | null;
  branch?: string | null;
  fork?: ForkInfo | null;
};

let cachedCommit: string | null | undefined;
let cachedBranch: string | null | undefined;
let cachedFork: ForkInfo | null | undefined;
let cachedBuildMeta: BuildMeta | null | undefined;

function normalizeCommit(value: string | undefined | null) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, COMMIT_LENGTH);
}

function isNullableString(value: unknown) {
  return value === undefined || value === null || typeof value === "string";
}

function parseJson(value: string | null | undefined): unknown {
  if (value == null) return null;

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function parseForkInfo(value: unknown): ForkInfo | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.baseRef !== "string" || !candidate.baseRef.trim()) return null;
  if (typeof candidate.baseCommit !== "string" || !candidate.baseCommit.trim()) return null;
  if (typeof candidate.commitsAhead !== "number" || !Number.isInteger(candidate.commitsAhead)) return null;
  if (!isNullableString(candidate.repo) || !isNullableString(candidate.branch)) return null;
  if (!isNullableString(candidate.baseVersion)) return null;

  return {
    repo: (candidate.repo as string | null | undefined) ?? null,
    branch: (candidate.branch as string | null | undefined) ?? null,
    baseRef: candidate.baseRef,
    baseCommit: candidate.baseCommit,
    baseVersion: (candidate.baseVersion as string | null | undefined) ?? null,
    commitsAhead: candidate.commitsAhead,
  };
}

function isBuildMeta(value: unknown): value is BuildMeta {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as { commit?: unknown; branch?: unknown; fork?: unknown };
  return (
    isNullableString(candidate.commit) &&
    isNullableString(candidate.branch) &&
    (candidate.fork === undefined || candidate.fork === null || parseForkInfo(candidate.fork) !== null)
  );
}

export function parseBuildMeta(value: string | null | undefined): BuildMeta | null {
  if (value == null) return null;

  try {
    const parsed: unknown = JSON.parse(value);
    return isBuildMeta(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readBuildMeta() {
  if (cachedBuildMeta !== undefined) return cachedBuildMeta;
  if (!existsSync(BUILD_META_PATH)) {
    cachedBuildMeta = null;
    return cachedBuildMeta;
  }

  try {
    cachedBuildMeta = parseBuildMeta(readFileSync(BUILD_META_PATH, "utf8"));
  } catch {
    cachedBuildMeta = null;
  }
  return cachedBuildMeta;
}

function readBuiltCommit() {
  return normalizeCommit(readBuildMeta()?.commit);
}

export function getBuildCommit() {
  if (cachedCommit !== undefined) return cachedCommit;

  const builtCommit = readBuiltCommit();
  if (builtCommit) {
    cachedCommit = builtCommit;
    return cachedCommit;
  }

  const envCommit = normalizeCommit(process.env.MARINARA_GIT_COMMIT ?? process.env.GITHUB_SHA);
  if (envCommit) {
    cachedCommit = envCommit;
    return cachedCommit;
  }

  if (!existsSync(resolve(MONOREPO_ROOT, ".git"))) {
    cachedCommit = null;
    return cachedCommit;
  }

  try {
    const commit = execFileSync("git", ["rev-parse", `--short=${COMMIT_LENGTH}`, "HEAD"], {
      cwd: MONOREPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    cachedCommit = commit || null;
  } catch {
    cachedCommit = null;
  }

  return cachedCommit;
}

function normalizeBranch(value: string | undefined | null) {
  const trimmed = value?.trim().replace(/^refs\/heads\//u, "");
  return trimmed || null;
}

export function resolveBuildBranch(
  envBranch: string | null | undefined,
  builtBranch: string | null | undefined,
  gitBranch: string | null | undefined,
) {
  return normalizeBranch(envBranch) ?? normalizeBranch(builtBranch) ?? normalizeBranch(gitBranch);
}

export function getBuildBranch() {
  if (cachedBranch !== undefined) return cachedBranch;

  const configuredBranch = resolveBuildBranch(
    process.env.MARINARA_GIT_BRANCH ?? process.env.GITHUB_REF_NAME,
    readBuildMeta()?.branch,
    undefined,
  );
  if (configuredBranch) {
    cachedBranch = configuredBranch;
    return cachedBranch;
  }

  if (!existsSync(resolve(MONOREPO_ROOT, ".git"))) {
    cachedBranch = null;
    return cachedBranch;
  }

  try {
    cachedBranch = resolveBuildBranch(
      undefined,
      undefined,
      execFileSync("git", ["branch", "--show-current"], {
        cwd: MONOREPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    cachedBranch = null;
  }

  return cachedBranch;
}

export function getBuildLabel() {
  const commit = getBuildCommit();
  return commit ? `${APP_VERSION}+${commit}` : APP_VERSION;
}

function git(...args: string[]) {
  try {
    const stdout = execFileSync("git", args, {
      cwd: MONOREPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_TIMEOUT_MS,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** For git commands that answer through their exit status rather than stdout. */
function gitOk(...args: string[]) {
  try {
    execFileSync("git", args, {
      cwd: MONOREPO_ROOT,
      stdio: "ignore",
      timeout: GIT_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

export function resolveRepoSlug(remoteUrl: string | null | undefined) {
  const trimmed = remoteUrl?.trim();
  if (!trimmed) return null;
  const match = /(?:[/:])([^/:]+)\/([^/]+?)(?:\.git)?\/?$/u.exec(trimmed);
  return match ? `${match[1]}/${match[2]}` : null;
}

function readBaseVersion(baseCommit: string) {
  const manifest = git("show", `${baseCommit}:package.json`);
  if (!manifest) return null;

  try {
    const parsed: unknown = JSON.parse(manifest);
    if (parsed === null || typeof parsed !== "object") return null;
    const version = (parsed as { version?: unknown }).version;
    return typeof version === "string" && version.trim() ? version.trim() : null;
  } catch {
    return null;
  }
}

/**
 * The base pinned by `fork-base.json`, if the file names a commit this checkout
 * actually contains. Everything else about the fork is still derived from git,
 * so a stale or hand-edited stamp cannot invent a base that is not an ancestor.
 */
export function parseForkBaseStamp(value: unknown): { baseRef: string; baseCommit: string } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const baseRef = typeof candidate.baseRef === "string" ? candidate.baseRef.trim() : "";
  const baseCommit = typeof candidate.baseCommit === "string" ? candidate.baseCommit.trim() : "";
  if (!baseRef || !/^[0-9a-f]{7,40}$/iu.test(baseCommit)) return null;
  return { baseRef, baseCommit };
}

function readForkBaseStamp() {
  if (!existsSync(FORK_BASE_STAMP_PATH)) return null;

  let stamp: { baseRef: string; baseCommit: string } | null;
  try {
    stamp = parseForkBaseStamp(parseJson(readFileSync(FORK_BASE_STAMP_PATH, "utf8")));
  } catch {
    return null;
  }
  if (!stamp) return null;

  const baseCommit = git("rev-parse", "--verify", "--quiet", `${stamp.baseCommit}^{commit}`);
  if (!baseCommit) return null;
  // An ancestor check is what makes the stamp safe to trust: a base the running
  // commit does not descend from is a leftover from another branch.
  if (!gitOk("merge-base", "--is-ancestor", baseCommit, "HEAD")) return null;
  return { baseRef: stamp.baseRef, baseCommit };
}

function resolveStampedBase() {
  const stamped = readForkBaseStamp();
  if (!stamped) return null;

  const commitsAhead = Number.parseInt(git("rev-list", "--count", `${stamped.baseCommit}..HEAD`) ?? "", 10);
  if (!Number.isInteger(commitsAhead) || commitsAhead === 0) return null;
  return { ...stamped, commitsAhead };
}

function searchMergeBase() {
  let best: { baseRef: string; baseCommit: string; commitsAhead: number } | null = null;
  for (const baseRef of FORK_BASE_REF_CANDIDATES) {
    if (!git("rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`)) continue;

    const baseCommit = git("merge-base", "HEAD", baseRef);
    if (!baseCommit) continue;

    const commitsAhead = Number.parseInt(git("rev-list", "--count", `${baseCommit}..HEAD`) ?? "", 10);
    if (!Number.isInteger(commitsAhead)) continue;
    // A stock checkout sitting exactly on an upstream ref is not a fork; stop
    // as soon as one candidate proves that, so no further probing is needed.
    if (commitsAhead === 0) return null;
    if (!best || commitsAhead < best.commitsAhead) {
      best = { baseRef, baseCommit, commitsAhead };
    }
  }
  return best;
}

function probeForkInfo(): ForkInfo | null {
  if (!existsSync(resolve(MONOREPO_ROOT, ".git"))) return null;
  if (!git("rev-parse", "HEAD")) return null;

  const best = resolveStampedBase() ?? searchMergeBase();
  if (!best) return null;

  return {
    repo: resolveRepoSlug(git("remote", "get-url", "origin")),
    branch: normalizeBranch(git("branch", "--show-current")),
    baseRef: best.baseRef,
    baseCommit: normalizeCommit(best.baseCommit) ?? best.baseCommit,
    baseVersion: readBaseVersion(best.baseCommit),
    commitsAhead: best.commitsAhead,
  };
}

/**
 * Fork provenance for this build, or `null` when the checkout carries no local
 * commits on top of an upstream ref. Resolved from the build-time metadata
 * first (so container and CI builds keep reporting it without a `.git`
 * directory), then `MARINARA_FORK_INFO`, then the live checkout.
 */
export function getForkInfo(): ForkInfo | null {
  if (cachedFork !== undefined) return cachedFork;

  // A built artifact records `fork` either way, so `null` there means "built
  // from a stock checkout" and must not trigger a runtime probe.
  const buildMeta = readBuildMeta();
  if (buildMeta && buildMeta.fork !== undefined) {
    cachedFork = parseForkInfo(buildMeta.fork);
    return cachedFork;
  }

  const envFork = parseForkInfo(parseJson(process.env.MARINARA_FORK_INFO));
  if (envFork) {
    cachedFork = envFork;
    return cachedFork;
  }

  cachedFork = probeForkInfo();
  return cachedFork;
}
