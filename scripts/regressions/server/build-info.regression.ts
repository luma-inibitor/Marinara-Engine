// Build info: reading the commit, branch and fork base a build records, and which branch an install reports.
import assert from "node:assert/strict";
import {
  parseBuildMeta,
  parseForkBaseStamp,
  parseForkInfo,
  resolveBuildBranch,
  resolveRepoSlug,
} from "../../../packages/server/src/config/build-info.js";

const validBuildMeta = parseBuildMeta('{"commit":"abcdef123456","branch":"staging"}');
assert.deepEqual(validBuildMeta, { commit: "abcdef123456", branch: "staging" });
assert.equal(parseBuildMeta('{"commit":"abcdef123456","branch":42}'), null);
assert.equal(parseBuildMeta(undefined), null);
assert.equal(resolveBuildBranch(undefined, validBuildMeta?.branch, "main"), "staging");
assert.equal(
  resolveBuildBranch(undefined, parseBuildMeta(undefined)?.branch, "refs/heads/feature/test"),
  "feature/test",
);
const forkBuildMeta = parseBuildMeta(
  '{"commit":"fedcba654321","fork":{"repo":"luma-inibitor/Marinara-Engine","branch":"luma/staging",' +
    '"baseRef":"origin/staging","baseCommit":"abcdef123456","baseVersion":"2.4.2","commitsAhead":6}}',
);
assert.deepEqual(forkBuildMeta?.fork, {
  repo: "luma-inibitor/Marinara-Engine",
  branch: "luma/staging",
  baseRef: "origin/staging",
  baseCommit: "abcdef123456",
  baseVersion: "2.4.2",
  commitsAhead: 6,
});
assert.deepEqual(parseBuildMeta('{"commit":"abcdef123456","fork":null}'), { commit: "abcdef123456", fork: null });
// A malformed fork block must not silently drop the commit alongside it.
assert.equal(parseBuildMeta('{"commit":"abcdef123456","fork":{"baseRef":"origin/staging"}}'), null);
assert.equal(parseForkInfo({ baseRef: "origin/staging", baseCommit: "abcdef123456", commitsAhead: 1.5 }), null);
assert.deepEqual(parseForkInfo({ baseRef: "origin/staging", baseCommit: "abcdef123456", commitsAhead: 3 }), {
  repo: null,
  branch: null,
  baseRef: "origin/staging",
  baseCommit: "abcdef123456",
  baseVersion: null,
  commitsAhead: 3,
});
assert.deepEqual(parseForkBaseStamp({ baseRef: "upstream/staging", baseCommit: "2b3232ff15df" }), {
  baseRef: "upstream/staging",
  baseCommit: "2b3232ff15df",
});
for (const rejected of [
  null,
  "upstream/staging",
  { baseCommit: "2b3232ff15df" },
  { baseRef: "upstream/staging" },
  { baseRef: "   ", baseCommit: "2b3232ff15df" },
  // Too short to be a commit, and a ref name where a SHA belongs — both would
  // otherwise be handed to `git rev-parse` as attacker-influenced input.
  { baseRef: "upstream/staging", baseCommit: "2b323" },
  { baseRef: "upstream/staging", baseCommit: "HEAD" },
  { baseRef: "upstream/staging", baseCommit: "--upload-pack=touch /tmp/pwned" },
]) {
  assert.equal(parseForkBaseStamp(rejected), null, `A fork-base stamp of ${JSON.stringify(rejected)} must be rejected`);
}
for (const [remoteUrl, expectedSlug] of [
  ["https://github.com/luma-inibitor/Marinara-Engine", "luma-inibitor/Marinara-Engine"],
  ["https://github.com/luma-inibitor/Marinara-Engine.git", "luma-inibitor/Marinara-Engine"],
  ["git@github.com:Pasta-Devs/Marinara-Engine.git", "Pasta-Devs/Marinara-Engine"],
  ["", null],
] as const) {
  assert.equal(resolveRepoSlug(remoteUrl), expectedSlug, `resolveRepoSlug must handle ${remoteUrl || "an empty URL"}`);
}
