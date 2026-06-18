import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyBaseLogger } from "fastify";

// The injectable spawn seam — tests pass a fake so CI never launches real Python.
export type SpawnFn = typeof nodeSpawn;

export interface PytrRunnerOptions {
  pythonBin: string;
  // Directory holding the vendored entrypoints (tr_login.py / tr_export.py).
  scriptDir: string;
  wafStrategy: "awswaf" | "playwright";
  enabled: boolean;
  spawn?: SpawnFn;
  // How long a pairing child may stay alive waiting for the app-push approval (ms).
  // Must exceed the Python side's own approval timeout (PYTR_APPROVAL_TIMEOUT_S, 180s).
  pairingTimeoutMs?: number;
  // How long an export may run before being killed (ms).
  exportTimeoutMs?: number;
  // Injectable logger — pass app.log so subprocess lifecycle events are observable.
  // Optional: if absent (e.g. in tests that inject a mock runner), logs are suppressed.
  log?: FastifyBaseLogger;
}

/** Return the first non-empty line of a multi-line string, trimmed. */
function firstLine(s: string): string {
  const idx = s.indexOf("\n");
  return (idx === -1 ? s : s.slice(0, idx)).trim();
}

export class PytrUnavailableError extends Error {
  constructor(message = "pytr is not available") {
    super(message);
    this.name = "PytrUnavailableError";
  }
}

// Thrown when the saved session can no longer be resumed (re-pairing required).
export class PytrAuthError extends Error {
  constructor(message = "trade republic session expired") {
    super(message);
    this.name = "PytrAuthError";
  }
}

// Thrown when the v2 app-push login is rejected or expires unapproved (exit code 3).
export class PytrApprovalError extends Error {
  constructor(message = "login was not approved") {
    super(message);
    this.name = "PytrApprovalError";
  }
}

export class PytrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PytrError";
  }
}

// A raw timeline event as emitted by tr_export.py (NDJSON). Shape is validated
// downstream by the mapper — kept loose here on purpose.
export type RawTrEvent = Record<string, unknown>;

// The trailing summary line: TR's own reported balances, used to reconcile our derived
// figures against the broker's. `amount` is a decimal-ish value (number or string).
export interface TrExportSummary {
  cash?: { currency: string; amount: number | string }[] | null;
}

interface PendingPairing {
  child: ChildProcess;
  cookiesFile: string;
  tmpDir: string;
  stderr: string;
  // Settled when the init line ({processId,status}) arrives — the app push has been sent.
  onInit: { resolve: (processId: string) => void; reject: (e: Error) => void } | null;
  // Settled by awaitApproval() once the child exits (approved → sessionData, else reject).
  onApproval: { resolve: (sessionData: string) => void; reject: (e: Error) => void } | null;
  // If the child exits before awaitApproval() is attached, the outcome is cached here and
  // collected by the next awaitApproval() call (handles a fast in-app approval race).
  settled: { sessionData: string } | { error: Error } | null;
  timer: NodeJS.Timeout;
}

/**
 * Drives the vendored pytr Python entrypoints as subprocesses. Pairing is the v2
 * push-approval flow: `tr_login.py` POSTs the login (sending a push to the TR mobile app),
 * prints its processId, then polls until the user approves in-app and exits. The child is
 * held in `pending` across that window; `awaitApproval` resolves with the saved session on
 * exit. Sync (`export`) is a cheap one-shot from saved cookies.
 *
 * Secrets (phone/PIN/WAF token) are passed via env, never argv (argv is world-readable
 * in the process list). Cookie material lives only in a per-op temp dir, removed in a
 * finally.
 */
export class PytrRunner {
  private readonly opts: Required<Omit<PytrRunnerOptions, "spawn" | "log">> & { spawn: SpawnFn };
  private readonly log: FastifyBaseLogger | null;
  private readonly pending = new Map<string, PendingPairing>();

  constructor(options: PytrRunnerOptions) {
    this.log = options.log ?? null;
    this.opts = {
      pythonBin: options.pythonBin,
      scriptDir: options.scriptDir,
      wafStrategy: options.wafStrategy,
      enabled: options.enabled,
      spawn: options.spawn ?? nodeSpawn,
      pairingTimeoutMs: options.pairingTimeoutMs ?? 210_000,
      exportTimeoutMs: options.exportTimeoutMs ?? 120_000,
    };
  }

  get isEnabled(): boolean {
    return this.opts.enabled;
  }

  private script(name: string): string {
    return join(this.opts.scriptDir, name);
  }

  /**
   * Begin a pairing: spawn `tr_login.py pair`, resolve with the login processId once Trade
   * Republic has sent the approval push to the mobile app. The child keeps polling for
   * approval and stays alive until it exits; collect the result with awaitApproval().
   */
  async startPairing(
    userId: string,
    input: { phone: string; pin: string; wafToken?: string },
  ): Promise<{ processId: string }> {
    if (!this.opts.enabled) throw new PytrUnavailableError();
    // A fresh attempt supersedes any in-flight one for this user.
    this.cancelPairing(userId);

    const tmpDir = await mkdtemp(join(tmpdir(), "pytr-pair-"));
    const cookiesFile = join(tmpDir, "cookies.txt");

    let child: ChildProcess;
    try {
      child = this.opts.spawn(
        this.opts.pythonBin,
        [
          this.script("tr_login.py"),
          "pair",
          "--cookies-file",
          cookiesFile,
          "--waf-strategy",
          input.wafToken ? "token" : this.opts.wafStrategy,
        ],
        {
          env: {
            ...process.env,
            TR_PHONE: input.phone,
            TR_PIN: input.pin,
            ...(input.wafToken ? { TR_WAF_TOKEN: input.wafToken } : {}),
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    } catch (err) {
      this.log?.error({ err }, "pytr spawn failed");
      await rm(tmpDir, { recursive: true, force: true });
      throw new PytrUnavailableError(
        err instanceof Error ? err.message : "failed to spawn python",
      );
    }
    this.log?.info(
      { userId, pythonBin: this.opts.pythonBin, wafStrategy: input.wafToken ? "token" : this.opts.wafStrategy },
      "pytr pairing spawned",
    );

    return new Promise<{ processId: string }>((resolve, reject) => {
      const entry: PendingPairing = {
        child,
        cookiesFile,
        tmpDir,
        stderr: "",
        onInit: {
          resolve: (processId) => resolve({ processId }),
          reject,
        },
        onApproval: null,
        settled: null,
        timer: setTimeout(() => {
          this.failPairing(userId, new PytrError("pairing timed out"));
        }, this.opts.pairingTimeoutMs),
      };
      this.pending.set(userId, entry);

      readLines(child, (line) => this.onPairLine(userId, line));
      child.stderr?.on("data", (d: Buffer) => {
        entry.stderr += d.toString();
      });
      child.on("error", (err) => this.failPairing(userId, err));
      child.on("exit", (code) => this.onPairExit(userId, code));
    });
  }

  private onPairLine(userId: string, line: string): void {
    const entry = this.pending.get(userId);
    if (!entry?.onInit) return;
    let parsed: { processId?: unknown; status?: unknown };
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // ignore non-JSON log noise
    }
    if (typeof parsed.processId === "string" && parsed.processId) {
      const { resolve } = entry.onInit;
      entry.onInit = null;
      resolve(parsed.processId);
    }
  }

  private onPairExit(userId: string, code: number | null): void {
    const entry = this.pending.get(userId);
    if (!entry) return;
    clearTimeout(entry.timer);
    const finalize = async () => {
      try {
        if (code === 0) {
          this.log?.info({ userId }, "pytr pairing approved");
          const sessionData = await readFile(entry.cookiesFile, "utf8");
          if (entry.onApproval) {
            entry.onApproval.resolve(sessionData);
            this.pending.delete(userId);
          } else {
            // Approved before awaitApproval() attached — cache for it to collect.
            entry.settled = { sessionData };
          }
        } else {
          this.log?.warn({ userId, code, stderr: firstLine(entry.stderr) }, "pytr pairing exited nonzero");
          const msg = entry.stderr.trim() || `pytr login exited with code ${code}`;
          const err = code === 3 ? new PytrApprovalError(msg) : new PytrError(msg);
          // A failure before the init line means startPairing() is still pending.
          entry.onInit?.reject(err);
          entry.onInit = null;
          if (entry.onApproval) {
            entry.onApproval.reject(err);
            this.pending.delete(userId);
          } else {
            entry.settled = { error: err };
          }
        }
      } catch (err) {
        const e = err instanceof Error ? err : new PytrError("failed to read session");
        entry.onInit?.reject(e);
        entry.onInit = null;
        if (entry.onApproval) {
          entry.onApproval.reject(e);
          this.pending.delete(userId);
        } else {
          entry.settled = { error: e };
        }
      } finally {
        await rm(entry.tmpDir, { recursive: true, force: true });
      }
    };
    void finalize();
  }

  private failPairing(userId: string, err: Error): void {
    const entry = this.pending.get(userId);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.onInit?.reject(err);
    entry.onApproval?.reject(err);
    entry.onInit = null;
    entry.onApproval = null;
    try {
      entry.child.kill("SIGKILL");
    } catch (killErr) {
      this.log?.warn({ userId, err: killErr }, "pytr kill failed");
    }
    this.pending.delete(userId);
    void rm(entry.tmpDir, { recursive: true, force: true });
  }

  /** True if a pairing is waiting for (or has just received) its app-push approval. */
  hasPendingPairing(userId: string): boolean {
    return this.pending.has(userId);
  }

  /**
   * Wait for the user to approve the login push in the TR mobile app, resolving with the
   * saved session (the pytr cookie file contents). Rejects with PytrApprovalError if the
   * login is declined or expires unapproved. Safe to call after the child has already
   * exited (a fast approval) — the cached outcome is returned.
   */
  awaitApproval(userId: string): Promise<string> {
    const entry = this.pending.get(userId);
    if (!entry) {
      return Promise.reject(new PytrError("no pairing in progress"));
    }
    if (entry.settled) {
      const settled = entry.settled;
      this.pending.delete(userId);
      return "sessionData" in settled
        ? Promise.resolve(settled.sessionData)
        : Promise.reject(settled.error);
    }
    return new Promise<string>((resolve, reject) => {
      entry.onApproval = { resolve, reject };
    });
  }

  cancelPairing(userId: string): void {
    const entry = this.pending.get(userId);
    if (!entry) return;
    clearTimeout(entry.timer);
    try {
      entry.child.kill("SIGKILL");
    } catch (killErr) {
      this.log?.warn({ userId, err: killErr }, "pytr kill failed");
    }
    this.pending.delete(userId);
    void rm(entry.tmpDir, { recursive: true, force: true });
  }

  /**
   * Run a one-shot export from a saved session, returning the raw timeline events.
   * pytr's constructor needs phone/PIN even to resume cookies, so they are passed too
   * (via env, never argv). Throws PytrAuthError when the session can no longer be
   * resumed (→ mark the connection expired).
   */
  async export(input: {
    phone: string;
    pin: string;
    sessionData: string;
  }): Promise<{ events: RawTrEvent[]; sessionData: string; summary?: TrExportSummary }> {
    if (!this.opts.enabled) throw new PytrUnavailableError();
    this.log?.info({ exportTimeoutMs: this.opts.exportTimeoutMs }, "pytr export started");
    const tmpDir = await mkdtemp(join(tmpdir(), "pytr-export-"));
    const cookiesFile = join(tmpDir, "cookies.txt");
    try {
      await writeFile(cookiesFile, input.sessionData, "utf8");
      const { code, stdout, stderr } = await this.run(
        this.script("tr_export.py"),
        ["--cookies-file", cookiesFile],
        this.opts.exportTimeoutMs,
        { TR_PHONE: input.phone, TR_PIN: input.pin },
      );
      if (code === 2) {
        this.log?.warn({}, "pytr session expired");
        throw new PytrAuthError(stderr.trim() || undefined);
      }
      if (code !== 0) {
        this.log?.error({ code, stderr: firstLine(stderr) }, "pytr export failed");
        throw new PytrError(stderr.trim() || `pytr export exited with code ${code}`);
      }
      const lines = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l) as RawTrEvent | { __summary__: TrExportSummary });
      // The export emits one trailing `{__summary__: …}` line (TR's reported balances);
      // everything else is a timeline event.
      let summary: TrExportSummary | undefined;
      const events: RawTrEvent[] = [];
      for (const line of lines) {
        if (line && typeof line === "object" && "__summary__" in line) {
          summary = (line as { __summary__: TrExportSummary }).__summary__;
        } else {
          events.push(line as RawTrEvent);
        }
      }
      // The export refreshes the session cookie; persist the rolling jar to extend the
      // session's life. Fall back to the original if it wasn't rewritten.
      const sessionData = await readFile(cookiesFile, "utf8").catch(
        () => input.sessionData,
      );
      return { events, sessionData, summary };
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }

  /** Whether the configured Python interpreter + pytr are importable. */
  async isAvailable(): Promise<boolean> {
    if (!this.opts.enabled) return false;
    try {
      const { code } = await this.run("-c", ["import pytr"], 10_000);
      return code === 0;
    } catch (err) {
      this.log?.warn({ pythonBin: this.opts.pythonBin, err }, "pytr unavailable");
      return false;
    }
  }

  private run(
    first: string,
    args: string[],
    timeoutMs: number,
    extraEnv: Record<string, string> = {},
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.opts.spawn(this.opts.pythonBin, [first, ...args], {
          env: { ...process.env, ...extraEnv },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        reject(
          new PytrUnavailableError(
            err instanceof Error ? err.message : "failed to spawn python",
          ),
        );
        return;
      }
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch (killErr) {
          this.log?.debug({ first, err: killErr }, "pytr timeout kill failed");
        }
        this.log?.warn({ first, timeoutMs }, "pytr process timed out");
        reject(new PytrError("pytr process timed out"));
      }, timeoutMs);
      child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", (err) => {
        clearTimeout(timer);
        this.log?.error({ first, err }, "pytr process error");
        reject(new PytrUnavailableError(err.message));
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        this.log?.debug({ first, code, signal }, "pytr subprocess exited");
        resolve({ code, stdout, stderr });
      });
    });
  }
}

let runner: PytrRunner | null = null;

/**
 * The app's pytr runner, built from config. The vendored Python entrypoints live in
 * services/api/python (copied next to dist in the runtime image); resolve that dir
 * relative to this module so it works in both dev (src) and prod (dist).
 *
 * Pass `log` (the Fastify app logger) to enable subprocess lifecycle logging.
 * Tests always inject a mock runner via BuildAppOptions, so this factory is never
 * called in tests — the log param is test-safe.
 */
export function getPytrRunner(
  config: {
    PYTR_PYTHON_BIN: string;
    PYTR_WAF_STRATEGY: "awswaf" | "playwright";
    PYTR_ENABLED: boolean;
  },
  log?: FastifyBaseLogger,
): PytrRunner {
  if (!runner) {
    runner = new PytrRunner({
      pythonBin: config.PYTR_PYTHON_BIN,
      wafStrategy: config.PYTR_WAF_STRATEGY,
      enabled: config.PYTR_ENABLED,
      scriptDir: fileURLToPath(new URL("../../../python", import.meta.url)),
      log,
    });
  }
  return runner;
}

// Read a child's stdout line-by-line, invoking `onLine` for each complete line.
function readLines(child: ChildProcess, onLine: (line: string) => void): void {
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
