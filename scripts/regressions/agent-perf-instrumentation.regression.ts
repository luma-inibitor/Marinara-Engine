// Agent performance instrumentation must report parallelism honestly: the
// numbers are the whole reason the logging exists, so a wrong summary is worse
// than none. LOG_LEVEL is forced to debug before the logger singleton is built
// so the phase timer records spans instead of no-oping.
process.env.LOG_LEVEL = "debug";

import assert from "node:assert/strict";
import type { AgentPerfSpan } from "../../packages/server/src/services/agents/agent-timing.js";

// Static imports are hoisted above the LOG_LEVEL assignment above, and the Pino
// singleton reads the level once at module load — so the modules under test
// have to be pulled in dynamically, after the env is set.
const { agentPerfEnabled, createAgentPerfPhaseTimer, formatAgentPerfSpans, summarizeAgentPerfSpans } =
  await import("../../packages/server/src/services/agents/agent-timing.js");
const { createAgentConcurrencyLimiter, settleAgentJobsWithConcurrencyLimit } =
  await import("../../packages/server/src/services/agents/agent-concurrency.js");

const span = (label: string, startedAt: number, endedAt: number, waitMs = 0): AgentPerfSpan => ({
  label,
  startedAt,
  endedAt,
  waitMs,
});

assert.equal(agentPerfEnabled(), true, "LOG_LEVEL=debug must enable agent performance logging");

// ── Empty input stays inert ──
const empty = summarizeAgentPerfSpans([]);
assert.equal(empty.spanCount, 0, "no spans must summarize to zero");
assert.equal(empty.slowest, null, "no spans must report no critical path");

// ── Fully serial: three back-to-back 100ms jobs ──
const serial = summarizeAgentPerfSpans([span("a", 1_000, 1_100), span("b", 1_100, 1_200), span("c", 1_200, 1_300)]);
assert.equal(serial.wallMs, 300, "serial wall clock spans first start to last end");
assert.equal(serial.busyMs, 300, "serial busy time equals the sum of the jobs");
assert.equal(serial.achievedParallelism, 1, "back-to-back jobs achieve exactly 1x parallelism");
assert.equal(serial.peakConcurrency, 1, "back-to-back jobs never overlap");
assert.equal(serial.idleMs, 0, "back-to-back jobs leave no idle gap");

// ── Fully parallel: three overlapping 100ms jobs ──
const parallel = summarizeAgentPerfSpans([span("a", 1_000, 1_100), span("b", 1_000, 1_100), span("c", 1_000, 1_100)]);
assert.equal(parallel.wallMs, 100, "overlapping jobs cost only the slowest");
assert.equal(parallel.achievedParallelism, 3, "three overlapping jobs achieve 3x parallelism");
assert.equal(parallel.peakConcurrency, 3, "three overlapping jobs peak at 3 concurrent");

// ── Idle gaps are the signal that something ran sequentially ──
const gapped = summarizeAgentPerfSpans([span("a", 0, 100), span("b", 400, 500)]);
assert.equal(gapped.wallMs, 500, "gapped wall clock covers the whole window");
assert.equal(gapped.mergedBusyMs, 200, "merged busy time excludes the gap");
assert.equal(gapped.idleMs, 300, "the gap between jobs is reported as idle");

// ── Queue wait and the critical path are surfaced separately ──
const queued = summarizeAgentPerfSpans([span("fast", 0, 50, 10), span("slow", 0, 900, 250)]);
assert.equal(queued.waitMs, 260, "queue wait is summed across spans");
assert.equal(queued.slowest?.label, "slow", "the longest span is the reported critical path");
assert.equal(queued.slowest?.durationMs, 900, "critical path duration is the longest span's duration");

// Touching timestamps must not double-count as overlap.
const adjacent = summarizeAgentPerfSpans([span("a", 0, 100), span("b", 100, 200)]);
assert.equal(adjacent.peakConcurrency, 1, "a job ending as another starts is not concurrency");

// A span too fast to measure still ran, so peak concurrency must not read 0.
const instant = summarizeAgentPerfSpans([span("instant", 500, 500)]);
assert.equal(instant.peakConcurrency, 1, "a zero-duration span must still count as one concurrent job");

const timeline = formatAgentPerfSpans([span("a", 1_000, 1_100), span("b", 1_050, 1_400)]);
assert.match(timeline, /\+0ms→\+100ms/, "timeline renders spans relative to the phase start");
assert.match(timeline, /\+50ms→\+400ms/, "timeline preserves each span's own offsets");
assert.match(
  formatAgentPerfSpans([{ ...span("nested", 0, 10), nested: true }]),
  /└/,
  "the timeline must mark nested spans as breakdowns",
);

// Nested spans are breakdowns of an enclosing span, so they must never be
// counted as extra concurrent work.
const withNested = summarizeAgentPerfSpans([span("outer", 0, 100), { ...span("outer llm", 10, 90), nested: true }]);
assert.equal(withNested.spanCount, 1, "nested spans must not be counted as jobs");
assert.equal(withNested.peakConcurrency, 1, "a span and its own breakdown are not two concurrent jobs");
assert.equal(withNested.busyMs, 100, "nested spans must not double-count busy time");

// ── The phase timer records what actually ran ──
const timer = createAgentPerfPhaseTimer("regression phase", { agents: 2 });
const first = timer.startSpan("first");
const second = timer.startSpan("second");
await new Promise((resolve) => setTimeout(resolve, 10));
first.end({ agents: 1 });
second.end({ agents: 1 });
const nestedSpan = timer.startSpan("first llm", { nested: true });
nestedSpan.end();
const summary = timer.finish();
assert.equal(summary.spanCount, 2, "the phase timer must record every opened top-level span");
assert.equal(summary.peakConcurrency, 2, "concurrently opened spans must register as overlapping");

// Ending a span twice must not inflate the counts.
const doubleEnded = createAgentPerfPhaseTimer("double end");
const once = doubleEnded.startSpan("once");
once.end();
once.end();
assert.equal(doubleEnded.finish().spanCount, 1, "a span must only be recorded once");

// ── Limiter counters describe real contention ──
const limiter = createAgentConcurrencyLimiter(2);
let active = 0;
let peakActive = 0;
await Promise.all(
  Array.from({ length: 5 }, () =>
    limiter(async () => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
    }),
  ),
);
const stats = limiter.stats();
assert.equal(peakActive, 2, "the limiter must never run more jobs than its limit");
assert.equal(stats.limit, 2, "the limiter reports its normalized limit");
assert.equal(stats.totalJobs, 5, "every job passed through the limiter is counted");
assert.equal(stats.queuedJobs, 3, "jobs beyond the limit are counted as queued");
assert.equal(stats.peakActiveJobs, 2, "peak active jobs matches the observed concurrency");
assert.ok(stats.peakQueueDepth >= 1, "queue depth is recorded when jobs wait");
assert.ok(stats.totalWaitMs > 0, "queued jobs must accumulate measurable wait time");
assert.ok(stats.maxWaitMs > 0, "the longest queue wait must be recorded");

// A limiter that is never saturated must report zero contention, so an
// unchanged limit is not mistaken for a bottleneck.
const roomyLimiter = createAgentConcurrencyLimiter(4);
await Promise.all(Array.from({ length: 3 }, () => roomyLimiter(async () => {})));
const roomyStats = roomyLimiter.stats();
assert.equal(roomyStats.queuedJobs, 0, "an unsaturated limiter must report no queued jobs");
assert.equal(roomyStats.totalWaitMs, 0, "an unsaturated limiter must report no wait time");

// ── The labelled worker pool keeps its results in input order ──
const settled = await settleAgentJobsWithConcurrencyLimit(
  [30, 5, 20],
  2,
  async (delayMs, index) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return index;
  },
  "regression-pool",
);
assert.deepEqual(
  settled.map((entry) => (entry.status === "fulfilled" ? entry.value : null)),
  [0, 1, 2],
  "instrumenting the pool must not reorder its results",
);

console.log("Agent performance instrumentation regression checks passed.");
