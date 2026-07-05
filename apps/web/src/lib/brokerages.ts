// Brokerage registry: maps the free-text `brokerage` field on a portfolio to a known
// brokerage (slug + bundled logo) for display, and derives a colored monogram fallback
// for brokerages we don't have a logo for. Pure logic only (no React) so it stays inside
// the coverage gate — see `brokerage-icon.tsx` for the rendering.
//
// To add a logo: add/extend an entry here with `icon`, then run
// `node scripts/fetch-brokerage-icons.ts` to vendor the SVG(s) into `public/brokerages/`.

export interface BrokerageDef {
  /** Slug — also the SVG filename base under `public/brokerages/<key>[.-light|-dark].svg`. */
  key: string;
  /** Canonical display label; also feeds the form's datalist suggestions. */
  label: string;
  /** Extra terms to match against (lowercased, alphanumeric-collapsed). */
  aliases?: string[];
  /**
   * Present only when a logo has been vendored. `variants` means the upstream ships
   * separate `-light`/`-dark` files; `source` records provenance for attribution and is
   * read by the fetch script.
   */
  icon?: { variants: boolean; source: "selfhst" | "homarr" };
}

/**
 * Known brokerages. Entries with `icon` render their bundled logo; the rest (and any
 * unknown free-text value) fall back to a monogram. Indonesian brokers have no upstream
 * logo yet, so they ride the monogram fallback until one is added to `public/brokerages/`.
 */
export const BROKERAGES: BrokerageDef[] = [
  {
    key: "trade-republic",
    label: "Trade Republic",
    aliases: ["traderepublic", "tr"],
    icon: { variants: true, source: "selfhst" },
  },
  {
    key: "interactive-brokers",
    label: "Interactive Brokers",
    aliases: ["ibkr", "ib"],
    icon: { variants: true, source: "selfhst" },
  },
  {
    key: "dkb",
    label: "DKB",
    aliases: ["deutsche kreditbank"],
    icon: { variants: false, source: "homarr" },
  },
  { key: "stockbit", label: "Stockbit" },
  { key: "bibit", label: "Bibit" },
  { key: "pluang", label: "Pluang" },
  { key: "ajaib", label: "Ajaib" },
];

/** Display labels for the create/edit form's `<datalist>` autocomplete. */
export const KNOWN_BROKERAGES = BROKERAGES.map((b) => b.label);

/** Lowercase and collapse anything non-alphanumeric to a single space, then trim. */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Resolve a free-text brokerage value to a known brokerage by matching its key, label,
 * or aliases (all case- and punctuation-insensitive). Returns `null` when unrecognized.
 */
export function resolveBrokerage(value: string | null | undefined): BrokerageDef | null {
  if (!value) return null;
  const needle = normalize(value);
  if (!needle) return null;
  for (const def of BROKERAGES) {
    const terms = [def.key, def.label, ...(def.aliases ?? [])].map(normalize);
    if (terms.includes(needle)) return def;
  }
  return null;
}

/**
 * 1–2 letter monogram for a brokerage name: initials of the first two words, or the
 * first two letters of a single word.
 */
export function monogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * Deterministic background color for a monogram, derived from the name so the same
 * brokerage always gets the same hue. Mid lightness/saturation reads on white text in
 * both light and dark mode.
 */
export function tintFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) % 360;
  }
  return `hsl(${hash} 55% 45%)`;
}

/**
 * Soft, hash-derived rounded-square tone (pastel wash + colored initials) for a monogram
 * whose asset class isn't known — the savings-plan rows in `Pocket Prototype.dc.html` use
 * this look ("tint bg + saturated fg") rather than the solid-fill/white-initials fallback.
 * The alpha wash reads on both light and dark cards; the same name always maps to one hue.
 */
export function softTintFor(name: string): { bg: string; fg: string } {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) % 360;
  }
  return { bg: `hsl(${hash} 60% 50% / 0.16)`, fg: `hsl(${hash} 50% 45%)` };
}

/**
 * Soft tinted background + matching foreground color for a monogram badge, keyed by
 * asset class — matches the reference (`Pocket Prototype.dc.html`'s per-holding
 * `chipBg`/`chipFg`): a pastel fill with colored (not white) initials, one hue per
 * class, rather than a hash-derived color unrelated to what's actually held.
 */
export function assetClassTone(assetClass: string | null | undefined): {
  bg: string;
  fg: string;
} {
  switch (assetClass) {
    case "equity":
      return { bg: "rgba(14,159,110,.14)", fg: "var(--chart-1)" };
    case "etf":
      return { bg: "rgba(124,92,252,.16)", fg: "var(--chart-4)" };
    case "mutual_fund":
      return { bg: "rgba(13,148,136,.16)", fg: "var(--chart-3)" };
    case "gold":
      return { bg: "rgba(224,165,58,.16)", fg: "var(--gold-fg)" };
    case "bond":
      return { bg: "rgba(59,130,246,.16)", fg: "#3B82F6" };
    case "crypto":
      return { bg: "rgba(249,115,22,.16)", fg: "#F97316" };
    case "cash":
      return { bg: "rgba(100,116,139,.16)", fg: "var(--chart-5)" };
    default:
      return { bg: "var(--muted)", fg: "var(--muted-foreground)" };
  }
}
