import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { resolveLogDestination } from "../../src/app.js";

/** Poll until `predicate()` is true or `timeoutMs` elapses — pino-roll's own writes are
 *  async (`sync: false`), so the file may not contain the line immediately after `write()`. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000, intervalMs = 20) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("condition not met within timeout");
}

describe("resolveLogDestination (LOG_DIR rotation)", () => {
  const originalLogDir = process.env.LOG_DIR;
  let tempDir: string | undefined;

  afterEach(() => {
    if (originalLogDir === undefined) delete process.env.LOG_DIR;
    else process.env.LOG_DIR = originalLogDir;
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it("returns stdout when LOG_DIR is unset", async () => {
    delete process.env.LOG_DIR;
    await expect(resolveLogDestination()).resolves.toBe(process.stdout);
  });

  it("returns an injected stream as-is, ignoring LOG_DIR", async () => {
    process.env.LOG_DIR = "/should/not/be/touched";
    const injected = { write: () => true };
    await expect(resolveLogDestination(injected)).resolves.toBe(injected);
  });

  it("persists log lines to a rotating file under LOG_DIR when set", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "api-log-dir-test-"));
    process.env.LOG_DIR = tempDir;

    const dest = await resolveLogDestination();
    // Drive the destination through a real pino logger, same as production (app.log.info(...))
    // — pino.multistream's write() routes by parsing the level out of a real pino log line;
    // a raw dest.write() of an arbitrary string is silently swallowed.
    pino({ level: "info" }, dest).info("log-rotation-test");

    // pino-roll inserts the rotation sequence number before the extension
    // (e.g. "api.1.log"), not "api.log" literally.
    const filePath = join(tempDir, "api.1.log");
    await waitFor(
      () => existsSync(filePath) && readFileSync(filePath, "utf8").includes("log-rotation-test"),
    );
    expect(readFileSync(filePath, "utf8")).toContain("log-rotation-test");
  });
});
