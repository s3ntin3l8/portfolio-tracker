// Vendor brokerage logos into `public/brokerages/` from their upstream icon repos.
//
// Run manually (not part of the build) whenever the registry's `icon` entries change:
//   node scripts/fetch-brokerage-icons.ts
//
// The PWA must work offline, so logos are bundled rather than hotlinked. This downloads
// the SVG(s) for every BROKERAGES entry that declares an `icon`, then regenerates
// CREDITS.md with the per-icon source + license attribution (required by CC-BY-4.0).

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BROKERAGES } from "../src/lib/brokerages.ts";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "brokerages");

const SOURCES = {
  selfhst: {
    base: "https://cdn.jsdelivr.net/gh/selfhst/icons/svg",
    repo: "selfhst/icons",
    license: "CC-BY-4.0",
  },
  homarr: {
    base: "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg",
    repo: "homarr-labs/dashboard-icons",
    license: "Apache-2.0",
  },
} as const;

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  // codeql[js/http-to-file-access] URLs are hardcoded constants, not user input
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  console.log(`  ✓ ${url.split("/").pop()}`);
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  const credited: { label: string; repo: string; license: string }[] = [];

  for (const def of BROKERAGES) {
    if (!def.icon) continue;
    const src = SOURCES[def.icon.source];
    // Variant icons ship as `<key>-light` / `<key>-dark`; others as a single `<key>`.
    const files = def.icon.variants ? [`${def.key}-light`, `${def.key}-dark`] : [def.key];
    console.log(`${def.label} (${src.repo})`);
    for (const file of files) {
      await download(`${src.base}/${file}.svg`, join(OUT_DIR, `${file}.svg`));
    }
    credited.push({ label: def.label, repo: src.repo, license: src.license });
  }

  const lines = [
    "# Brokerage logo attribution",
    "",
    "Logos in this folder are vendored (not hotlinked) so the PWA works offline.",
    "Regenerate with `node scripts/fetch-brokerage-icons.ts`. All trademarks are the",
    "property of their respective owners; logos are used for identification only.",
    "",
    "| Brokerage | Source | License |",
    "| --- | --- | --- |",
    ...credited.map(
      (c) => `| ${c.label} | [${c.repo}](https://github.com/${c.repo}) | ${c.license} |`,
    ),
    "",
  ];
  await writeFile(join(OUT_DIR, "CREDITS.md"), lines.join("\n"));
  console.log(`\nWrote ${credited.length} logos + CREDITS.md to ${OUT_DIR}`);
}

await main();
