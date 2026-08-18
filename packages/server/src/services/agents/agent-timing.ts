// ──────────────────────────────────────────────
// Agents: performance instrumentation helpers
// ──────────────────────────────────────────────
// Answers the question "why does adding agents make a turn slower?" by
// separating the three costs that grow with agent count:
//
//   1. Serial work  — resolution, context building, sub-batch loops that
//      await one item at a time.
//   2. Queued work  — jobs that were ready but waiting on a concurrency slot
//      (provider `maxParallelJobs`, phase group cap, tool-call cap).
//   3. Real latency — the LLM calls themselves. Batching trades N requests
//      for one request with an N-times-larger output budget, so a batch does
//      not shrink wall-clock the way running N calls in parallel would.
//
// Everything here is debug-only and gated behind `agentPerfEnabled()` so the
// hot path stays free when LOG_LEVEL is above debug.
// ──────────────────────────────────────────────
import { logger } from "../../lib/logger.js";

/** Log tag shared by every agent performance line, so `grep agent-perf` finds them all. */
export const AGENT_PERF_TAG = "[agent-perf]";

/** Agent performance logging is debug-only — skip the bookkeeping otherwise. */
export function agentPerfEnabled(): boolean {
  return logger.isLevelEnabled("debug");
}

/** A single timed unit of agent work. */
export interface AgentPerfSpan {
  label: string;
  /** Wall-clock ms when the job actually began doing work. */
  startedAt: number;
  /** Wall-clock ms when the job finished. */
  endedAt: number;
  /**
   * Ms the job was ready but had not started yet. Either it was queued behind a
   * concurrency limit, or the single-threaded event loop was busy running
   * another job's synchronous work (prompt assembly, serialization).
   */
  waitMs: number;
  /** Free-form detail rendered into the summary line (sizes, models, counts). */
  detail?: Record<string, unknown>;
  /**
   * A breakdown of work already covered by an enclosing span. Nested spans are
   * shown in the timeline but excluded from the summary, so a group and its own
   * sub-steps never read as two concurrent jobs.
   */
  nested?: boolean;
}

export interface AgentPerfSummary {
  spanCount: number;
  /** First start → last end. What the user actually waits for. */
  wallMs: number;
  /** Sum of every span's duration. `busyMs / wallMs` is the achieved parallelism. */
  busyMs: number;
  /** Union of the span intervals — wall time during which *something* was running. */
  mergedBusyMs: number;
  /** Wall time inside the phase with nothing running (serial gaps between jobs). */
  idleMs: number;
  /** Total time jobs were ready but not yet started. */
  waitMs: number;
  /** busyMs / wallMs, rounded to 2dp. 1.0 means fully serial. */
  achievedParallelism: number;
  /** Highest number of spans overlapping at any instant. */
  peakConcurrency: number;
  /** The single longest span — the critical path of the phase. */
  slowest: { label: string; durationMs: number } | null;
}

function spanDuration(span: AgentPerfSpan): number {
  return Math.max(0, span.endedAt - span.startedAt);
}

/**
 * Reduce a set of spans to the numbers that show whether more parallelism
 * would help: achieved parallelism, peak concurrency, idle gaps, queue wait.
 */
export function summarizeAgentPerfSpans(allSpans: AgentPerfSpan[]): AgentPerfSummary {
  const spans = allSpans.filter((span) => !span.nested);
  if (spans.length === 0) {
    return {
      spanCount: 0,
      wallMs: 0,
      busyMs: 0,
      mergedBusyMs: 0,
      idleMs: 0,
      waitMs: 0,
      achievedParallelism: 0,
      peakConcurrency: 0,
      slowest: null,
    };
  }

  const start = Math.min(...spans.map((span) => span.startedAt));
  const end = Math.max(...spans.map((span) => span.endedAt));
  const wallMs = Math.max(0, end - start);
  const busyMs = spans.reduce((sum, span) => sum + spanDuration(span), 0);
  const waitMs = spans.reduce((sum, span) => sum + Math.max(0, span.waitMs), 0);

  // Sweep the interval endpoints once for both merged coverage and peak overlap.
  const events = spans
    .flatMap((span) => [
      { at: span.startedAt, delta: 1 },
      { at: span.endedAt, delta: -1 },
    ])
    .sort((a, b) => a.at - b.at || a.delta - b.delta);

  let active = 0;
  let peakConcurrency = 0;
  let mergedBusyMs = 0;
  let coverageStart = 0;
  for (const event of events) {
    if (active === 0 && event.delta === 1) coverageStart = event.at;
    active += event.delta;
    peakConcurrency = Math.max(peakConcurrency, active);
    if (active === 0) mergedBusyMs += Math.max(0, event.at - coverageStart);
  }

  const slowestSpan = spans.reduce(
    (worst, span) => (spanDuration(span) > spanDuration(worst) ? span : worst),
    spans[0]!,
  );

  return {
    spanCount: spans.length,
    wallMs,
    busyMs,
    mergedBusyMs,
    idleMs: Math.max(0, wallMs - mergedBusyMs),
    waitMs,
    achievedParallelism: wallMs > 0 ? Math.round((busyMs / wallMs) * 100) / 100 : 0,
    // Ends are swept before starts at an identical timestamp so that a job
    // finishing exactly as the next begins is not counted as overlap. That
    // makes a zero-duration span sweep to 0, so floor it at 1 — something ran.
    peakConcurrency: Math.max(1, peakConcurrency),
    slowest: { label: slowestSpan.label, durationMs: spanDuration(slowestSpan) },
  };
}

function formatDetail(detail: Record<string, unknown> | undefined): string {
  if (!detail) return "";
  const parts = Object.entries(detail)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${typeof value === "number" ? value : String(value)}`);
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

/**
 * Render one line per span, relative to the phase start, so overlap is
 * readable at a glance:
 *   `+0ms→+2140ms (2140ms, wait 0ms) group#0 [tracker, director]`
 */
export function formatAgentPerfSpans(spans: AgentPerfSpan[]): string {
  if (spans.length === 0) return "  (no spans)";
  const origin = Math.min(...spans.map((span) => span.startedAt));
  return [...spans]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map(
      (span) =>
        `  ${span.nested ? "└" : "•"} +${span.startedAt - origin}ms→+${span.endedAt - origin}ms (${spanDuration(span)}ms, start delay ${Math.max(0, Math.round(span.waitMs))}ms) ${span.label}${formatDetail(span.detail)}`,
    )
    .join("\n");
}

export interface AgentPerfPhaseTimer {
  /** Ms elapsed since the phase timer was created. */
  elapsedMs(): number;
  /**
   * Open a span. Pass `queuedAt` — the moment the job became *eligible* to run
   * — to capture start delay separately from the work itself. Pass
   * `nested: true` for a breakdown of work an outer span already covers.
   */
  startSpan(
    label: string,
    options?: { queuedAt?: number; nested?: boolean },
  ): { end(detail?: Record<string, unknown>): void };
  /** Record an already-measured span (for work timed elsewhere). */
  addSpan(span: AgentPerfSpan): void;
  /** Emit the phase summary. Safe to call when nothing was recorded. */
  finish(detail?: Record<string, unknown>): AgentPerfSummary;
}

const NOOP_SPAN = { end: () => {} };

/**
 * Create a phase-scoped timer. Returns a no-op recorder when debug logging is
 * off so callers can instrument unconditionally.
 */
export function createAgentPerfPhaseTimer(scope: string, context: Record<string, unknown> = {}): AgentPerfPhaseTimer {
  const createdAt = Date.now();

  if (!agentPerfEnabled()) {
    return {
      elapsedMs: () => Date.now() - createdAt,
      startSpan: () => NOOP_SPAN,
      addSpan: () => {},
      finish: () => summarizeAgentPerfSpans([]),
    };
  }

  const spans: AgentPerfSpan[] = [];

  return {
    elapsedMs: () => Date.now() - createdAt,
    startSpan(label, options) {
      const startedAt = Date.now();
      const queuedAt = options?.queuedAt;
      const waitMs = queuedAt === undefined ? 0 : Math.max(0, startedAt - queuedAt);
      const nested = options?.nested === true;
      let closed = false;
      return {
        end(detail) {
          if (closed) return;
          closed = true;
          spans.push({ label, startedAt, endedAt: Date.now(), waitMs, detail, nested });
        },
      };
    },
    addSpan(span) {
      spans.push(span);
    },
    finish(detail) {
      const summary = summarizeAgentPerfSpans(spans);
      const totalMs = Date.now() - createdAt;
      logger.debug(
        "%s %s: %dms total, %d job(s), busy %dms, idle %dms, start delay %dms, parallelism %s×, peak %d concurrent%s%s",
        AGENT_PERF_TAG,
        scope,
        totalMs,
        summary.spanCount,
        summary.busyMs,
        summary.idleMs,
        Math.round(summary.waitMs),
        summary.achievedParallelism.toFixed(2),
        summary.peakConcurrency,
        formatDetail({ ...context, ...detail }),
        summary.slowest ? ` | critical path: ${summary.slowest.label} (${summary.slowest.durationMs}ms)` : "",
      );
      if (spans.length > 0) {
        logger.debug("%s %s span timeline:\n%s", AGENT_PERF_TAG, scope, formatAgentPerfSpans(spans));
      }
      return summary;
    },
  };
}

/**
 * Time a single awaited step and log it as a one-off `[agent-perf]` line.
 * Use for serial steps that are suspected of blocking (DB lookups, context
 * assembly, a phase the main generation waits on).
 */
export async function timeAgentPerfStep<T>(
  label: string,
  run: () => Promise<T>,
  detail?: (result: T) => Record<string, unknown>,
): Promise<T> {
  if (!agentPerfEnabled()) return run();
  const startedAt = Date.now();
  try {
    const result = await run();
    logger.debug("%s %s: %dms%s", AGENT_PERF_TAG, label, Date.now() - startedAt, formatDetail(detail?.(result)));
    return result;
  } catch (error) {
    logger.debug("%s %s: %dms (threw)", AGENT_PERF_TAG, label, Date.now() - startedAt);
    throw error;
  }
}
