import type { FastifyRequest } from "fastify";
import pino from "pino";

const ENABLED = process.env.TIMING_ENABLED === "true";

/**
 * Pino instance for timing logs emitted outside of request scope (service-level code in
 * valuation.ts etc.). Uses pino's default destination (stdout fd 1), which is the same fd
 * the app's `pino.multistream` stdout stream writes to — so both appear in the terminal.
 *
 * The pino-roll file writer (`LOG_DIR`) is wired into the app's pino multistream in
 * `app.ts` — this fallback instance does NOT write to that file. Exporting the app's
 * logger from a shared module would create a circular dep (app.ts imports timing, timing
 * imports app's logger). Two workarounds:
 *
 *   a) Accept that service-level timing entries only go to terminal, not to the log file.
 *      For baseline analysis, pipe/grep the terminal output to a file instead.
 *   b) Thread `request.log` through every service call (more invasive).
 *
 * We go with (a): terminal-only for service-level timing, pino-roll file for route-level
 * timing. Both are visible during `make dev` and can be captured via shell redirect.
 */
const fallbackLogger = pino({ name: "timing", level: ENABLED ? "info" : "silent" });

export function logTiming(
  request: { log: FastifyRequest["log"] } | undefined,
  name: string,
  durationMs: number,
  extra?: Record<string, unknown>,
): void {
  if (!ENABLED) return;
  const logger = request?.log ?? fallbackLogger;
  logger.info({ durationMs: Math.round(durationMs * 100) / 100, ...extra }, `[timing] ${name}`);
}
