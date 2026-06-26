import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyBaseLogger } from "fastify";
import { runProcess, readLines, safeRm, type SpawnFn } from "./process.js";
import {
  PytrApprovalError,
  PytrAuthError,
  PytrError,
  PytrUnavailableError,
} from "./errors.js";

// Re-exported so existing `from "./runner.js"` imports keep working after the split.
export { PytrApprovalError, PytrAuthError, PytrError, PytrUnavailableError };
export type { SpawnFn };

export interface DocDownloadResult {
  buf: Buffer;
  mimeType: string;
}

export interface DownloadDocumentsResult {
  /** Successfully downloaded docs, keyed by docId. */
  docs: Map<string, DocDownloadResult>;
  /** Per-doc failures (parse errors, 4xx from TR, file-read failures, etc.). */
  failures: { docId: string | null; error: string }[];
}

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

// A raw timeline event as emitted by tr_export.py (NDJSON). Shape is validated
// downstream by the mapper — kept loose here on purpose.
export type RawTrEvent = Record<string, unknown>;

// The trailing summary line: TR's own reported balances, used to reconcile our derived
// figures against the broker's. `amount` is a decimal-ish value (number or string).
export interface TrExportSummary {
  cash?: { currency: string; amount: number | string }[] | null;
  /** Per-ISIN position snapshot from compactPortfolio (qty is decimal-ish). */
  positions?: { isin: string; qty: number | string }[] | null;
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
      exportTimeoutMs: options.exportTimeoutMs ?? 300_000,
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
      await safeRm(tmpDir, this.log);
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
          this.log?.warn({ userId, code, stderr: entry.stderr.trim() }, "pytr pairing exited nonzero");
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
        await safeRm(entry.tmpDir, this.log, { userId });
      }
    };
    finalize().catch((err) => this.log?.warn({ userId, err }, "pytr pairing finalize failed"));
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
    void safeRm(entry.tmpDir, this.log, { userId });
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
    void safeRm(entry.tmpDir, this.log, { userId });
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
        this.log?.error({ code, stderr: stderr.trim() }, "pytr export failed");
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
      await safeRm(tmpDir, this.log);
    }
  }

  /**
   * Download postbox document bytes for a set of (eventId, docId) pairs.
   *
   * Spawns `tr_documents.py --cookies-file COOKIES --out OUTDIR`, feeds pairs as NDJSON
   * on stdin, reads per-doc results from stdout. Per-doc failures are collected in
   * `result.failures` (logged + surfaced to callers) rather than silently dropped.
   * Process-level errors still throw (PytrAuthError on code 2, PytrError on code≠0).
   *
   * The bytes channel is an `--out` temp dir (mirrors the `--cookies-file` seam) rather
   * than stdout so binary content never corrupts the NDJSON stream.
   */
  async downloadDocuments(
    session: { phone: string; pin: string; sessionData: string },
    pairs: { eventId: string; docId: string }[],
  ): Promise<DownloadDocumentsResult> {
    if (!this.opts.enabled) throw new PytrUnavailableError();
    if (pairs.length === 0) return { docs: new Map(), failures: [] };

    const tmpDir = await mkdtemp(join(tmpdir(), "pytr-docs-"));
    const cookiesFile = join(tmpDir, "cookies.txt");
    const outDir = join(tmpDir, "out");
    // mkdtemp already creates the parent; create the out sub-dir manually.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(outDir, { recursive: true });

    try {
      await writeFile(cookiesFile, session.sessionData, "utf8");

      const { code, stdout, stderr } = await this.runWithStdin(
        this.script("tr_documents.py"),
        ["--cookies-file", cookiesFile, "--out", outDir],
        this.opts.exportTimeoutMs,
        { TR_PHONE: session.phone, TR_PIN: session.pin },
        pairs.map((p) => JSON.stringify(p)).join("\n") + "\n",
      );

      if (code === 2) {
        this.log?.warn({}, "pytr session expired during document download");
        throw new PytrAuthError(stderr.trim() || undefined);
      }
      if (code !== 0) {
        this.log?.error({ code, stderr: stderr.trim() }, "pytr documents download failed");
        throw new PytrError(stderr.trim() || `tr_documents.py exited with code ${code}`);
      }

      // Parse NDJSON result lines; load bytes for each ok result. Per-doc failures are
      // collected (not dropped) so callers can surface them in logs and metrics.
      const docs = new Map<string, DocDownloadResult>();
      const failures: { docId: string | null; error: string }[] = [];
      const lines = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);

      for (const line of lines) {
        let parsed: { docId?: string; file?: string; mimeType?: string; ok?: boolean; error?: string };
        try {
          parsed = JSON.parse(line);
        } catch {
          this.log?.warn({ line }, "tr_documents: unparseable stdout line");
          failures.push({ docId: null, error: `unparseable line: ${line.slice(0, 100)}` });
          continue;
        }
        if (!parsed.ok || !parsed.docId || !parsed.file) {
          const reason = parsed.error ?? (parsed.docId ? "missing file field" : "missing docId");
          this.log?.warn(
            { docId: parsed.docId, error: reason },
            "tr_documents: per-doc failure",
          );
          failures.push({ docId: parsed.docId ?? null, error: reason });
          continue;
        }
        try {
          const buf = await readFile(join(outDir, parsed.file));
          docs.set(parsed.docId, { buf, mimeType: parsed.mimeType ?? "application/pdf" });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          this.log?.warn({ docId: parsed.docId, err }, "tr_documents: failed to read output file");
          failures.push({ docId: parsed.docId, error: `file read failed: ${reason}` });
        }
      }

      this.log?.debug({ requested: pairs.length, downloaded: docs.size, failed: failures.length }, "pytr documents fetched");
      return { docs, failures };
    } finally {
      await safeRm(tmpDir, this.log);
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

  // The spawn config the low-level process helpers need, captured from this runner's opts.
  private get procCfg() {
    return { spawn: this.opts.spawn, pythonBin: this.opts.pythonBin, log: this.log };
  }

  private run(
    first: string,
    args: string[],
    timeoutMs: number,
    extraEnv: Record<string, string> = {},
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return runProcess(this.procCfg, first, args, timeoutMs, extraEnv, null);
  }

  private runWithStdin(
    first: string,
    args: string[],
    timeoutMs: number,
    extraEnv: Record<string, string> = {},
    stdinData: string | null = null,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return runProcess(this.procCfg, first, args, timeoutMs, extraEnv, stdinData);
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
