import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import {
  PytrRunner,
  PytrUnavailableError,
  PytrAuthError,
  PytrError,
  type SpawnFn,
} from "../../src/services/pytr/runner.js";

// A controllable stand-in for a spawned Python process. The tests drive its stdout /
// stderr / exit so no real Python ever runs.
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: vi.fn(), end: vi.fn() };
  kill = vi.fn();
  constructor(
    readonly args: string[],
    readonly opts: { env?: Record<string, string> },
  ) {
    super();
  }
  cookiesFile(): string | undefined {
    const i = this.args.indexOf("--cookies-file");
    return i >= 0 ? this.args[i + 1] : undefined;
  }
  emitLine(line: string): void {
    this.stdout.emit("data", Buffer.from(line));
  }
}

function makeSpawn(opts: { throwOnSpawn?: boolean } = {}) {
  const ready: FakeChild[] = [];
  const waiters: ((c: FakeChild) => void)[] = [];
  const spawn = ((_cmd: string, args: string[], options: { env?: Record<string, string> }) => {
    if (opts.throwOnSpawn) throw new Error("ENOENT: python not found");
    const child = new FakeChild(args, options ?? {});
    const w = waiters.shift();
    if (w) w(child);
    else ready.push(child);
    return child as unknown as ChildProcess;
  }) as unknown as SpawnFn;
  const nextChild = () =>
    new Promise<FakeChild>((resolve) => {
      const c = ready.shift();
      if (c) resolve(c);
      else waiters.push(resolve);
    });
  return { spawn, nextChild };
}

function makeRunner(spawn: SpawnFn, overrides = {}) {
  return new PytrRunner({
    pythonBin: "python3",
    scriptDir: "/scripts",
    wafStrategy: "awswaf",
    enabled: true,
    spawn,
    pairingTimeoutMs: 50,
    exportTimeoutMs: 50,
    ...overrides,
  });
}

describe("PytrRunner pairing", () => {
  it("resolves the countdown, delivers the code on stdin, returns the saved session", async () => {
    const { spawn, nextChild } = makeSpawn();
    const runner = makeRunner(spawn);

    const startP = runner.startPairing("u1", { phone: "+4915", pin: "1234" });
    const child = await nextChild();
    // argv allowlist + env (secrets via env, never argv)
    expect(child.args).toEqual([
      "/scripts/tr_login.py",
      "pair",
      "--cookies-file",
      expect.stringContaining("cookies.txt"),
      "--waf-strategy",
      "awswaf",
    ]);
    expect(child.opts.env?.TR_PHONE).toBe("+4915");
    expect(child.opts.env?.TR_PIN).toBe("1234");
    expect(child.args).not.toContain("1234"); // pin not on the command line

    child.emitLine('{"processId":"pid-1","countdown":30}\n');
    expect(await startP).toEqual({ countdown: 30 });
    expect(runner.hasPendingPairing("u1")).toBe(true);

    const submitP = runner.submitCode("u1", "9999");
    expect(child.stdin.write).toHaveBeenCalledWith("9999\n");
    // pytr would have written the cookie jar before exiting cleanly
    await writeFile(child.cookiesFile()!, "MOZILLA_COOKIE_JAR");
    child.emit("exit", 0);
    expect(await submitP).toBe("MOZILLA_COOKIE_JAR");
    expect(runner.hasPendingPairing("u1")).toBe(false);
  });

  it("uses the token waf strategy and TR_WAF_TOKEN when a pasted token is supplied", async () => {
    const { spawn, nextChild } = makeSpawn();
    const runner = makeRunner(spawn);
    const startP = runner.startPairing("u1", {
      phone: "+4915",
      pin: "1234",
      wafToken: "pasted-token",
    });
    const child = await nextChild();
    expect(child.args).toContain("token");
    expect(child.opts.env?.TR_WAF_TOKEN).toBe("pasted-token");
    child.emitLine('{"processId":"p","countdown":10}\n');
    await startP;
  });

  it("rejects when the child exits before login completes (bad code)", async () => {
    const { spawn, nextChild } = makeSpawn();
    const runner = makeRunner(spawn);
    const startP = runner.startPairing("u1", { phone: "+49", pin: "1" });
    const child = await nextChild();
    child.emitLine('{"processId":"p","countdown":10}\n');
    await startP;
    const submitP = runner.submitCode("u1", "0000");
    child.stderr.emit("data", Buffer.from("complete_weblogin failed: bad code"));
    child.emit("exit", 3);
    await expect(submitP).rejects.toThrow(/bad code/);
  });

  it("times out a pairing that never receives its code", async () => {
    const { spawn, nextChild } = makeSpawn();
    const runner = makeRunner(spawn, { pairingTimeoutMs: 20 });
    const startP = runner.startPairing("u1", { phone: "+49", pin: "1" });
    const child = await nextChild();
    child.emitLine('{"processId":"p","countdown":10}\n');
    await startP;
    const submitP = runner.submitCode("u1", "1111");
    await expect(submitP).rejects.toThrow(/timed out/);
    expect(child.kill).toHaveBeenCalled();
  });

  it("rejects submitCode when no pairing is in progress", async () => {
    const { spawn } = makeSpawn();
    const runner = makeRunner(spawn);
    await expect(runner.submitCode("nobody", "1234")).rejects.toThrow(
      /no pairing in progress/,
    );
  });

  it("throws PytrUnavailableError when disabled or the interpreter is missing", async () => {
    const disabled = makeRunner(makeSpawn().spawn, { enabled: false });
    await expect(disabled.startPairing("u1", { phone: "+49", pin: "1" })).rejects.toThrow(
      PytrUnavailableError,
    );

    const { spawn } = makeSpawn({ throwOnSpawn: true });
    const runner = makeRunner(spawn);
    await expect(runner.startPairing("u1", { phone: "+49", pin: "1" })).rejects.toThrow(
      PytrUnavailableError,
    );
  });
});

describe("PytrRunner export", () => {
  it("parses NDJSON timeline events on a clean exit", async () => {
    const { spawn, nextChild } = makeSpawn();
    const runner = makeRunner(spawn);
    const exportP = runner.export({ phone: "+49", pin: "1", sessionData: "JAR" });
    const child = await nextChild();
    expect(child.args[0]).toBe("/scripts/tr_export.py");
    expect(child.opts.env?.TR_PHONE).toBe("+49");
    // the saved cookie jar is written to the temp cookies file the child is told to read
    expect(await readFile(child.cookiesFile()!, "utf8")).toBe("JAR");
    child.stdout.emit("data", Buffer.from('{"id":"e1","eventType":"CREDIT"}\n{"id":'));
    child.stdout.emit("data", Buffer.from('"e2"}\n'));
    child.emit("exit", 0);
    const result = await exportP;
    expect(result.events).toEqual([
      { id: "e1", eventType: "CREDIT" },
      { id: "e2" },
    ]);
    // the rolling cookie jar is read back (here unchanged by the fake child)
    expect(result.sessionData).toBe("JAR");
  });

  it("maps exit code 2 to PytrAuthError (session expired)", async () => {
    const { spawn, nextChild } = makeSpawn();
    const runner = makeRunner(spawn);
    const exportP = runner.export({ phone: "+49", pin: "1", sessionData: "JAR" });
    const child = await nextChild();
    child.stderr.emit("data", Buffer.from("session expired"));
    child.emit("exit", 2);
    await expect(exportP).rejects.toThrow(PytrAuthError);
  });

  it("maps any other non-zero exit to PytrError", async () => {
    const { spawn, nextChild } = makeSpawn();
    const runner = makeRunner(spawn);
    const exportP = runner.export({ phone: "+49", pin: "1", sessionData: "JAR" });
    const child = await nextChild();
    child.emit("exit", 1);
    await expect(exportP).rejects.toThrow(PytrError);
  });
});

describe("PytrRunner.isAvailable", () => {
  it("is false when disabled", async () => {
    const runner = makeRunner(makeSpawn().spawn, { enabled: false });
    expect(await runner.isAvailable()).toBe(false);
  });

  it("is true when `python -c import pytr` exits 0, false otherwise", async () => {
    const ok = makeSpawn();
    const runner = makeRunner(ok.spawn);
    const p = runner.isAvailable();
    const child = await ok.nextChild();
    expect(child.args).toEqual(["-c", "import pytr"]);
    child.emit("exit", 0);
    expect(await p).toBe(true);

    const bad = makeSpawn();
    const runner2 = makeRunner(bad.spawn);
    const p2 = runner2.isAvailable();
    (await bad.nextChild()).emit("exit", 1);
    expect(await p2).toBe(false);
  });
});
