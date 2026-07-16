import type { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import type { FastifyBaseLogger } from "fastify";
import { PytrError, PytrUnavailableError } from "./errors.js";

// Low-level subprocess plumbing shared by every pytr entrypoint (login / export / documents):
// spawn → collect stdout/stderr → enforce a timeout → resolve the exit code. Extracted from
// runner.ts so the runner class is left with the TR-specific orchestration only.

// The injectable spawn seam — tests pass a fake so CI never launches real Python.
export type SpawnFn = typeof nodeSpawn;

/** What runProcess needs from the runner: the spawn seam, the interpreter, and a logger. */
export interface ProcessConfig {
  spawn: SpawnFn;
  pythonBin: string;
  log: FastifyBaseLogger | null;
}

/**
 * Spawn a Python process, optionally writing `stdinData` to its stdin, then collect all
 * stdout/stderr and resolve with the exit code. stdin is closed (end) after writing so the
 * child sees EOF. Rejects with PytrUnavailableError if the interpreter can't be spawned, or
 * PytrError on timeout.
 */
export function runProcess(
  cfg: ProcessConfig,
  first: string,
  args: string[],
  timeoutMs: number,
  extraEnv: Record<string, string> = {},
  stdinData: string | null = null,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = cfg.spawn(cfg.pythonBin, [first, ...args], {
        env: { ...process.env, ...extraEnv },
        // Use "pipe" for stdin so we can write to it; keep stdout/stderr piped.
        stdio: [stdinData !== null ? "pipe" : "ignore", "pipe", "pipe"],
      });
    } catch (err) {
      reject(
        new PytrUnavailableError(err instanceof Error ? err.message : "failed to spawn python"),
      );
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch (killErr) {
        cfg.log?.debug({ first, err: killErr }, "pytr timeout kill failed");
      }
      cfg.log?.warn({ first, timeoutMs }, "pytr process timed out");
      reject(new PytrError("pytr process timed out"));
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      cfg.log?.error({ first, err }, "pytr process error");
      reject(new PytrUnavailableError(err.message));
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      cfg.log?.debug({ first, code, signal }, "pytr subprocess exited");
      resolve({ code, stdout, stderr });
    });
    // Write stdin data and close the pipe so the child sees EOF.
    if (stdinData !== null && child.stdin) {
      child.stdin.write(stdinData);
      child.stdin.end();
    }
  });
}

// Read a child's stdout line-by-line, invoking `onLine` for each complete line.
export function readLines(child: ChildProcess, onLine: (line: string) => void): void {
  let buffer = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      onLine(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf("\n");
    }
  });
}

/**
 * Remove a temp dir, logging (never throwing) on failure. Used for best-effort cleanup so a
 * cleanup error neither leaks silently nor masks the real result of the surrounding operation
 * when awaited in a `finally`.
 */
export function safeRm(
  dir: string,
  log: FastifyBaseLogger | null,
  ctx?: Record<string, unknown>,
): Promise<void> {
  return rm(dir, { recursive: true, force: true }).catch((err) => {
    log?.warn({ ...ctx, dir, err }, "pytr temp cleanup failed");
  });
}
