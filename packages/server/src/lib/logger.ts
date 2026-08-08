// ──────────────────────────────────────────────
// Shared Logger — Pino singleton
// ──────────────────────────────────────────────
// Every module in the server package should import `logger` from here
// instead of using `console.log/warn/error` directly. This ensures
// LOG_LEVEL actually controls what gets printed.
//
// Fastify builds its own separate pino instance (see app.ts), but both it and
// this singleton now derive their config from the shared buildLoggerOptions()
// below so the two can never drift. The env-watcher hot-reload still mutates
// only this singleton's level, so req.log / reply.log do NOT track runtime
// LOG_LEVEL changes — a restart picks those up for Fastify.
//
// When LOG_FILE is set, buildLoggerOptions() emits a multi-target transport:
// the console keeps LOG_LEVEL while a rotating file (pino-roll) captures at
// LOG_FILE_LEVEL. Because the root level gates every target before per-target
// levels apply, the root is pinned to the most verbose of the two.
// ──────────────────────────────────────────────
import pino, { type LoggerOptions } from "pino";
import { getLogFileLevel, getLogFilePath, getLogLevel, getNodeEnv } from "../config/runtime-config.js";

// Rotation defaults for the on-disk log: cap each file at ~10MB and keep the
// last 5, bounding disk usage to ~50MB without any extra config knobs.
const FILE_ROTATION_SIZE = "10m";
const FILE_ROTATION_LIMIT = 5;

// Lower numeric pino level = more verbose (trace=10 … fatal=60). Unknown labels
// fall back to info (30); the callers only pass validated level names.
function mostVerboseLevel(a: string, b: string): string {
  const values = pino.levels.values;
  const av = values[a] ?? 30;
  const bv = values[b] ?? 30;
  return av <= bv ? a : b;
}

/**
 * The pino options shared by the singleton below and Fastify's own instance
 * (app.ts). With LOG_FILE unset this is the historical console-only setup;
 * with it set, a rotating file target is added alongside the console.
 */
export function buildLoggerOptions(): LoggerOptions {
  const consoleLevel = getLogLevel();
  const filePath = getLogFilePath();
  const isDev = getNodeEnv() !== "production";

  if (!filePath) {
    return {
      level: consoleLevel,
      transport: isDev ? { target: "pino-pretty", options: { colorize: true } } : undefined,
    };
  }

  const fileLevel = getLogFileLevel();
  const consoleTarget = isDev
    ? { target: "pino-pretty", level: consoleLevel, options: { colorize: true } }
    : { target: "pino/file", level: consoleLevel, options: { destination: 1 } };
  const fileTarget = {
    target: "pino-roll",
    level: fileLevel,
    options: { file: filePath, size: FILE_ROTATION_SIZE, limit: { count: FILE_ROTATION_LIMIT }, mkdir: true },
  };

  return {
    level: mostVerboseLevel(consoleLevel, fileLevel),
    transport: { targets: [consoleTarget, fileTarget] },
  };
}

/**
 * The level the root logger should carry given current config: the floor (most
 * verbose) across console + file when file logging is on, otherwise just the
 * console level. The env-watcher uses this so a live LOG_LEVEL change never
 * raises the root gate above the file target's level.
 */
export function getRootLogLevel(): string {
  const consoleLevel = getLogLevel();
  if (!getLogFilePath()) return consoleLevel;
  return mostVerboseLevel(consoleLevel, getLogFileLevel());
}

export const logger = pino(buildLoggerOptions());

export function logDebugOverride(overrideEnabled: boolean, message: string, ...args: any[]) {
  if (overrideEnabled && !logger.isLevelEnabled("debug")) {
    // Default LOG_LEVEL is warn, so explicit UI debug mode must log at warn to be visible.
    logger.warn(message, ...args);
    return;
  }

  logger.debug(message, ...args);
}
