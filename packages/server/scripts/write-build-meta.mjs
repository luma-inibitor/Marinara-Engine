import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "..");
const MONOREPO_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const BUILD_META_PATH = resolve(PACKAGE_ROOT, "dist", "config", "build-meta.json");
const COMMIT_LENGTH = 12;
const GIT_TIMEOUT_MS = 5_000;
// Keep in sync with FORK_BASE_REF_CANDIDATES in src/config/build-info.ts.
const FORK_BASE_REF_CANDIDATES = ["upstream/staging", "upstream/main", "origin/staging", "origin/main"];

function normalizeCommit(value) {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, COMMIT_LENGTH);
}

function git(...args) {
  try {
    return (
      execFileSync("git", args, {
        cwd: MONOREPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: GIT_TIMEOUT_MS,
      }).trim() || null
    );
  } catch {
    return null;
  }
}

function resolveCommit() {
  const envCommit = normalizeCommit(process.env.MARINARA_GIT_COMMIT ?? process.env.GITHUB_SHA);
  if (envCommit) return envCommit;
  return normalizeCommit(git("rev-parse", `--short=${COMMIT_LENGTH}`, "HEAD"));
}

function resolveRepoSlug(remoteUrl) {
  const trimmed = remoteUrl?.trim();
  if (!trimmed) return null;
  const match = /(?:[/:])([^/:]+)\/([^/]+?)(?:\.git)?\/?$/u.exec(trimmed);
  return match ? `${match[1]}/${match[2]}` : null;
}

function readBaseVersion(baseCommit) {
  const manifest = git("show", `${baseCommit}:package.json`);
  if (!manifest) return null;

  try {
    const version = JSON.parse(manifest)?.version;
    return typeof version === "string" && version.trim() ? version.trim() : null;
  } catch {
    return null;
  }
}

// Baked in at build time so container and packaged installs keep reporting the
// fork base after the `.git` directory is gone. Mirrors probeForkInfo() in
// src/config/build-info.ts.
function resolveForkInfo() {
  if (!git("rev-parse", "HEAD")) return null;

  let best = null;
  for (const baseRef of FORK_BASE_REF_CANDIDATES) {
    if (!git("rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`)) continue;

    const baseCommit = git("merge-base", "HEAD", baseRef);
    if (!baseCommit) continue;

    const commitsAhead = Number.parseInt(git("rev-list", "--count", `${baseCommit}..HEAD`) ?? "", 10);
    if (!Number.isInteger(commitsAhead)) continue;
    if (commitsAhead === 0) return null;
    if (!best || commitsAhead < best.commitsAhead) {
      best = { baseRef, baseCommit, commitsAhead };
    }
  }
  if (!best) return null;

  return {
    repo: resolveRepoSlug(git("remote", "get-url", "origin")),
    branch: git("branch", "--show-current"),
    baseRef: best.baseRef,
    baseCommit: normalizeCommit(best.baseCommit),
    baseVersion: readBaseVersion(best.baseCommit),
    commitsAhead: best.commitsAhead,
  };
}

mkdirSync(resolve(PACKAGE_ROOT, "dist", "config"), { recursive: true });
writeFileSync(
  BUILD_META_PATH,
  `${JSON.stringify({ commit: resolveCommit(), fork: resolveForkInfo(), builtAt: new Date().toISOString() }, null, 2)}\n`,
  "utf8",
);
