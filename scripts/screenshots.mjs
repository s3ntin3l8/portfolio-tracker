#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Orchestrates the reproducible demo-screenshot pipeline: seed a throwaway PGlite
 * dataset → boot the API + web app against it → capture every hero screen via
 * Playwright → tear everything down. See
 * `.claude/plans/can-we-make-some-distributed-seal.md` for the full design and
 * `services/api/src/db/seed-demo.ts` / `apps/web/scripts/screenshots.mjs` / `apps/web/
 * scripts/mint-session.mjs` for the pieces this wires together.
 *
 * Run: `npm run screenshots` (from the repo root).
 *
 * Nothing here touches real user data or real Authentik — the API/web pair is a
 * fully isolated instance (its own PGlite dir, its own random AUTH_SECRET, dummy
 * Authentik env just to satisfy the `authConfigured` check) on dedicated ports, torn
 * down unconditionally when the run ends.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = (name) => path.join(REPO_ROOT, "node_modules", ".bin", name);

const API_PORT = process.env.SCREENSHOTS_API_PORT ?? "3910";
const WEB_PORT = process.env.SCREENSHOTS_WEB_PORT ?? "3915";

/** Run a command to completion, streaming output, rejecting on non-zero exit. */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...opts });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`)),
    );
    child.on("error", reject);
  });
}

/**
 * Launch a long-lived server as its own process group (`detached: true`) so
 * `killGroup` below can reliably tear down every descendant it spawns (next dev
 * forks its own worker processes) — a plain `child.kill()` only signals the direct
 * child and can leak the rest of the tree.
 */
function spawnServer(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], detached: true, ...opts });
  child.stdout.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
  return child;
}

function killGroup(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

async function waitForHttp(url, timeoutMs = 60_000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${url}${lastError ? `: ${lastError}` : ""}`);
}

async function main() {
  const scratch = await mkdtemp(path.join(tmpdir(), "pocket-screenshots-"));
  const dbDir = path.join(scratch, "db");
  const patFile = path.join(scratch, "pat.txt");
  // Random per-run — only encrypts a throwaway cookie for this ephemeral, immediately
  // torn-down demo instance. Never persisted, never reused across runs.
  const authSecret = randomBytes(32).toString("base64url");

  console.log(`[orchestrator] scratch dir: ${scratch}`);

  console.log("[orchestrator] seeding demo data...");
  await run(BIN("tsx"), ["services/api/src/db/seed-demo.ts", patFile], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: `pglite://${dbDir}` },
  });

  console.log("[orchestrator] starting API + web...");
  const api = spawnServer("api", BIN("tsx"), ["services/api/src/server.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: `pglite://${dbDir}`,
      // Dummy but non-empty — satisfies the auth plugin's boot guard (see
      // plugins/auth.ts) without ever being used: the screenshot driver
      // authenticates via a seeded personal-access token, which short-circuits
      // before any JWT/issuer verification happens.
      AUTHENTIK_ISSUER: "https://demo.invalid/application/o/pocket-demo/",
      AUTHENTIK_AUDIENCE: "pocket-demo",
      // Never "stale" → the price cache never falls through to a live provider
      // (no API keys needed, no network calls, no flakiness).
      MARKET_DATA_TTL_MS: "999999999",
      // A real Playwright run + Next's own background polling easily exceeds the
      // default 100 req/min guard against this single-purpose, single-user instance.
      RATE_LIMIT_MAX: "100000",
      PORT: API_PORT,
      LOG_LEVEL: "warn",
    },
  });

  const web = spawnServer("web", BIN("next"), ["dev", "-p", WEB_PORT], {
    cwd: path.join(REPO_ROOT, "apps/web"),
    env: {
      ...process.env,
      AUTH_SECRET: authSecret,
      // Sets the unprefixed (http) session-cookie name mint-session.mjs targets —
      // see its doc comment on why the salt must match this exactly.
      AUTH_URL: `http://localhost:${WEB_PORT}`,
      AUTHENTIK_ISSUER: "https://demo.invalid/application/o/pocket-demo/",
      AUTHENTIK_CLIENT_ID: "demo",
      // Never used — the PAT bypass (mint-session.mjs) short-circuits before any real
      // OAuth exchange, so this dummy value only satisfies NextAuth's required option.
      AUTHENTIK_CLIENT_SECRET: "demo", // pragma: allowlist secret
      API_URL: `http://localhost:${API_PORT}`,
      PORT: WEB_PORT,
    },
  });

  try {
    console.log("[orchestrator] waiting for API...");
    await waitForHttp(`http://localhost:${API_PORT}/health`);
    console.log("[orchestrator] waiting for web...");
    await waitForHttp(`http://localhost:${WEB_PORT}/en`);

    console.log("[orchestrator] capturing screenshots...");
    await run(process.execPath, ["scripts/screenshots.mjs"], {
      cwd: path.join(REPO_ROOT, "apps/web"),
      env: {
        ...process.env,
        SCREENSHOTS_WEB_URL: `http://localhost:${WEB_PORT}`,
        SCREENSHOTS_PAT_FILE: patFile,
        AUTH_SECRET: authSecret,
      },
    });
    console.log("[orchestrator] done — see apps/web/public/screenshots/");
  } finally {
    console.log("[orchestrator] tearing down...");
    killGroup(api);
    killGroup(web);
    // Give the just-killed API a beat to release its PGlite file handles before
    // deleting the scratch dir — otherwise `rm` can race a still-flushing WAL file
    // (ENOTEMPTY). Best-effort: a leftover scratch dir under the OS tmpdir is
    // harmless (cleaned up by the OS eventually), so a cleanup failure here must
    // never mask an otherwise-successful screenshot run.
    await new Promise((r) => setTimeout(r, 300));
    try {
      await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch (err) {
      console.warn(`[orchestrator] scratch cleanup failed (harmless, left in ${scratch}): ${err}`);
    }
  }
}

main().catch((err) => {
  console.error("[orchestrator] failed:", err);
  process.exitCode = 1;
});
