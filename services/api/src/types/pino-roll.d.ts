/**
 * Minimal ambient declarations for pino-roll (no bundled types).
 * Full API: https://github.com/mcollina/pino-roll
 */
declare module "pino-roll" {
  import type { DestinationStream } from "pino";

  export interface PinoRollOptions {
    /** File path (including name). pino-roll appends a date suffix on rotation. */
    file: string;
    /** Rotate by frequency: "daily" | "hourly" | number (ms). */
    frequency?: "daily" | "hourly" | number;
    /** Rotate when the file exceeds this size, e.g. "20m", "1g". */
    size?: string;
    /** Keep at most this many rolled files. */
    limit?: { count: number };
    /** Create the directory if it doesn't exist. */
    mkdir?: boolean;
    /** Open the file synchronously. Default false. */
    sync?: boolean;
  }

  /** Open a rolling file stream compatible with pino's `destination` argument. */
  function pinoRoll(options: PinoRollOptions): Promise<DestinationStream>;
  export default pinoRoll;
}
