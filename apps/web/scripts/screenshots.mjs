import { mkdir } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { mintSessionCookie } from "./mint-session.mjs";

/**
 * Screenshot driver for the reproducible demo pipeline — see
 * `.claude/plans/can-we-make-some-distributed-seal.md` and `scripts/screenshots.mjs`
 * at the repo root (the orchestrator that seeds data + boots API/web before calling
 * this). Captures the Hero-5 screens × {light, dark} × {narrow, wide} into
 * `apps/web/public/screenshots/` — the source for both the README embeds and the
 * PWA manifest `screenshots` array (issue #100).
 *
 * Auth: mints a forged Auth.js session cookie from the seeded personal-access token
 * (see `mint-session.mjs`'s doc comment for why this is safe and how it works) —
 * no real Authentik login needed.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, "../public/screenshots");

const WEB_URL = process.env.SCREENSHOTS_WEB_URL ?? "http://localhost:3005";
const PAT_FILE = process.env.SCREENSHOTS_PAT_FILE;
const AUTH_SECRET = process.env.AUTH_SECRET;
const AUTH_SUB = process.env.SCREENSHOTS_AUTH_SUB ?? "demo|pocket";

// The Pocket 5-tab IA (see nav-items.tsx): Holdings is the home/net-worth screen
// (the old standalone "/dashboard" now just redirects here — see
// dashboard/page.tsx), Activity is the transaction ledger, Reports/Insights/Tax
// round out the hero set with the app's other visually distinct screens. Tax is a
// leaf under the Reports tab, not a top-level nav item, but is rich enough (FSA
// allowance, realized gains, harvest suggestions) to be worth its own capture.
const SCREENS = [
  { slug: "holdings", path: "/en/holdings" },
  { slug: "activity", path: "/en/transactions" },
  { slug: "insights", path: "/en/insights" },
  { slug: "reports", path: "/en/reports" },
  { slug: "tax", path: "/en/tax" },
];

const THEMES = ["light", "dark"];

// "narrow" MUST be under the app's `md:` breakpoint (768px CSS px — see
// app-shell.tsx/bottom-nav.tsx's `md:hidden`/`md:flex`), or the desktop sidebar
// layout renders instead of the real single-column/bottom-nav mobile UI. A real
// phone logical size (iPhone 11/XR: 414×896) at 2x device-scale gives a crisp,
// representative capture of what a phone install actually looks like.
const FACTORS = [
  { name: "narrow", width: 414, height: 896, deviceScaleFactor: 2, form_factor: "narrow" },
  { name: "wide", width: 2560, height: 1440, deviceScaleFactor: 1, form_factor: "wide" },
];

async function main() {
  if (!PAT_FILE) throw new Error("SCREENSHOTS_PAT_FILE env var is required");
  if (!AUTH_SECRET) throw new Error("AUTH_SECRET env var is required");

  const patSecret = (await readFile(PAT_FILE, "utf8")).trim();
  const secure = WEB_URL.startsWith("https://");
  const cookie = await mintSessionCookie({
    patSecret,
    authSub: AUTH_SUB,
    secret: AUTH_SECRET,
    secure,
  });

  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const manifestEntries = [];

  try {
    for (const factor of FACTORS) {
      for (const theme of THEMES) {
        const context = await browser.newContext({
          viewport: { width: factor.width, height: factor.height },
          deviceScaleFactor: factor.deviceScaleFactor,
          colorScheme: theme,
        });
        await context.addCookies([
          {
            name: cookie.name,
            value: cookie.value,
            domain: new URL(WEB_URL).hostname,
            path: "/",
            httpOnly: true,
            secure,
            sameSite: "Lax",
          },
        ]);
        // next-themes reads this synchronously before hydration (its inline
        // FOUC-prevention script) — set it before the very first navigation so the
        // `class="dark"|"light"` on <html> is correct from first paint, not just
        // after a client-side re-render.
        await context.addInitScript((t) => {
          window.localStorage.setItem("theme", t);
        }, theme);

        const page = await context.newPage();
        for (const screen of SCREENS) {
          const url = `${WEB_URL}${screen.path}`;
          await page.goto(url, { waitUntil: "networkidle" });
          // next/font uses display:"swap" (see layout.tsx) — text paints in a fallback
          // system font first, then swaps once Plus Jakarta Sans/DM Mono finish loading.
          // Without this, captures can race that swap and ship with the wrong font.
          await page.evaluate(() => document.fonts.ready);
          // Let charts/animations settle (recharts entrance transitions, skeleton→data).
          await page.waitForTimeout(600);

          const filename = `${screen.slug}-${theme}-${factor.name}.png`;
          const outPath = path.join(OUT_DIR, filename);
          await page.screenshot({ path: outPath, fullPage: false });
          console.log(`captured ${filename}`);

          manifestEntries.push({
            filename,
            slug: screen.slug,
            theme,
            width: factor.width,
            height: factor.height,
            form_factor: factor.form_factor,
          });
        }
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  // Written for the orchestrator to fold into the manifest — see
  // scripts/screenshots.mjs (repo root) and update-manifest.mjs.
  return manifestEntries;
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  const entries = await main();
  console.log(`Done — ${entries.length} screenshots written to ${OUT_DIR}`);
}

export { main, SCREENS, THEMES, FACTORS, OUT_DIR };
