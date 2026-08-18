// ──────────────────────────────────────────────
// Agents: bounded worker-pool helpers
// ──────────────────────────────────────────────
// Both helpers are instrumented for `[agent-perf]` debug logging: they report
// how long jobs sat waiting for a slot and how many ever ran at once. A pool
// whose peak concurrency stays well below its limit is serialized somewhere
// else; a pool with large queue wait is limited by the cap itself.
// ──────────────────────────────────────────────
import { logger } from "../../lib/logger.js";
import { AGENT_PERF_TAG, agentPerfEnabled } from "./agent-timing.js";

export async function settleAgentJobsWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  label?: string,
): Promise<PromiseSettledResult<R>[]> {
  if (items.length === 0) return [];

  const normalizedLimit = Number.isFinite(limit) ? Math.trunc(limit) : 1;
  const concurrent = Math.max(1, Math.min(items.length, normalizedLimit));
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let nextIndex = 0;

  const perf = label && agentPerfEnabled() ? { queuedAt: Date.now(), totalWaitMs: 0, maxWaitMs: 0 } : null;
  const startedAt = Date.now();

  await Promise.all(
    Array.from({ length: concurrent }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        if (perf) {
          const waitMs = Date.now() - perf.queuedAt;
          perf.totalWaitMs += waitMs;
          perf.maxWaitMs = Math.max(perf.maxWaitMs, waitMs);
        }
        try {
          results[index] = { status: "fulfilled", value: await worker(items[index]!, index) };
        } catch (reason) {
          results[index] = { status: "rejected", reason };
        }
      }
    }),
  );

  if (perf) {
    const wallMs = Date.now() - startedAt;
    logger.debug(
      "%s pool %s: %d job(s) at limit %d in %dms (%d slot(s) used, start delay total %dms / max %dms)",
      AGENT_PERF_TAG,
      label,
      items.length,
      normalizedLimit,
      wallMs,
      concurrent,
      perf.totalWaitMs,
      perf.maxWaitMs,
    );
    if (perf.maxWaitMs > 0 && items.length <= normalizedLimit) {
      // Slots were free, so the delay is the event loop: an earlier job's
      // synchronous work (prompt assembly, template rendering, serialization)
      // ran before the later jobs could start their own requests.
      logger.debug(
        "%s pool %s: every job had a free slot yet one waited %dms to start — that delay is synchronous work on the event loop, not the concurrency limit",
        AGENT_PERF_TAG,
        label,
        perf.maxWaitMs,
      );
    }
  }

  return results;
}

/** Counters describing how hard a limiter was pushed during one phase. */
export interface AgentConcurrencyLimiterStats {
  limit: number;
  totalJobs: number;
  /** Jobs that had to wait for a slot rather than starting immediately. */
  queuedJobs: number;
  totalWaitMs: number;
  maxWaitMs: number;
  /** Highest number of jobs running at once. Below `limit` means the cap was never the constraint. */
  peakActiveJobs: number;
  /** Longest observed queue depth — how far behind the limiter fell. */
  peakQueueDepth: number;
}

export interface AgentConcurrencyLimiter {
  <R>(job: () => Promise<R>): Promise<R>;
  /** Snapshot of the counters above; always populated (cheap integer bookkeeping). */
  stats(): AgentConcurrencyLimiterStats;
}

export function createAgentConcurrencyLimiter(limit: number): AgentConcurrencyLimiter {
  const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 1;
  let activeJobs = 0;
  const waiting: Array<() => void> = [];
  const stats: AgentConcurrencyLimiterStats = {
    limit: normalizedLimit,
    totalJobs: 0,
    queuedJobs: 0,
    totalWaitMs: 0,
    maxWaitMs: 0,
    peakActiveJobs: 0,
    peakQueueDepth: 0,
  };

  const acquire = () =>
    new Promise<void>((resolve) => {
      stats.totalJobs += 1;
      if (activeJobs < normalizedLimit) {
        activeJobs += 1;
        stats.peakActiveJobs = Math.max(stats.peakActiveJobs, activeJobs);
        resolve();
        return;
      }
      const queuedAt = Date.now();
      stats.queuedJobs += 1;
      waiting.push(() => {
        activeJobs += 1;
        stats.peakActiveJobs = Math.max(stats.peakActiveJobs, activeJobs);
        const waitMs = Date.now() - queuedAt;
        stats.totalWaitMs += waitMs;
        stats.maxWaitMs = Math.max(stats.maxWaitMs, waitMs);
        resolve();
      });
      stats.peakQueueDepth = Math.max(stats.peakQueueDepth, waiting.length);
    });

  const runWithAgentConcurrencyLimit = async function <R>(job: () => Promise<R>): Promise<R> {
    await acquire();
    try {
      return await job();
    } finally {
      activeJobs -= 1;
      waiting.shift()?.();
    }
  } as AgentConcurrencyLimiter;

  runWithAgentConcurrencyLimit.stats = () => ({ ...stats });

  return runWithAgentConcurrencyLimit;
}
