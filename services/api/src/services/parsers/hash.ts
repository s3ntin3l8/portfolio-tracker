import type { ParsedTransaction } from "@portfolio/schema";

/**
 * Deterministic short hash (djb2) for content-derived idempotency keys.
 * Exported so all parsers share one implementation; previously private to dkb.ts.
 */
export function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

/**
 * Normalise a decimal string for fingerprint comparison so trivially-different
 * spellings of the same number (`"5"` vs `"5.0000"`, `"0.3355"`) collapse to one
 * canonical form. Falls back to the trimmed raw string when it isn't a finite number.
 */
function canonicalDecimal(raw: string | null | undefined): string {
  const n = Number(raw);
  return Number.isFinite(n) ? String(n) : String(raw ?? "").trim();
}

/**
 * Source-independent **economic fingerprint** of a trade — the key for cross-format /
 * cross-source duplicate detection (#196). Unlike {@link assignContentExternalIds}'s
 * content key (which also folds in fees + currency + source tag), this keys only on the
 * economic essence — instrument, action, calendar day, quantity, price — so the *same*
 * trade imported as a CSV row and a PDF settlement note fingerprints identically even
 * though their broker refs (and `source`) differ.
 *
 * `key` is the caller's choice of instrument identity: the resolved `instrumentId` at
 * confirm time (reliable), or the `isin` at upload time (best-effort, before resolution).
 * `executedAt` is truncated to the day (tolerance: same-day match, ignoring intraday time).
 */
export function economicFingerprint(input: {
  key: string;
  action: string;
  executedAt: Date | string;
  quantity: string;
  price: string;
}): string {
  const day =
    input.executedAt instanceof Date
      ? input.executedAt.toISOString().slice(0, 10)
      : new Date(input.executedAt).toISOString().slice(0, 10);
  return [
    input.key,
    input.action,
    day,
    canonicalDecimal(input.quantity),
    canonicalDecimal(input.price),
  ].join("|");
}

/**
 * Assign deterministic, content-derived externalIds to draft transactions that
 * don't already have one (DKB booking refs, pytr event ids, etc. are left untouched).
 *
 * WHY at parse time, not confirm time: the confirm route supports *partial* confirm
 * (the user can confirm a subset of drafts). If the occurrence counter were computed
 * in the confirm fallback, confirming a file with N identical rows in separate batches
 * would recompute `occ` from 0 each time → collision → a real transaction silently
 * dropped by `onConflictDoNothing`. Computing it once over the full draft set and
 * storing the id in `parsedJson.drafts[].externalId` makes subset-confirm safe.
 *
 * The content key hashes the *draft's own* economic fields — not the resolved
 * instrumentId — so the id is stable without relying on `findOrCreateInstrument`
 * being deterministic for name-only instruments.
 *
 * Caveat: parse-time hashing reflects the original parse. Later UI edits to a draft
 * don't change its dedup id. That is the correct trade for dedup-on-file-content;
 * moving the hash back to confirm would reintroduce the partial-confirm bug above.
 *
 * @param drafts  The draft array from the parser result (mutated in place).
 * @param tag     Short source tag used as the id prefix ("csv" or "screenshot").
 */
export function assignContentExternalIds(drafts: ParsedTransaction[], tag: string): void {
  const occurrences = new Map<string, number>();
  for (const draft of drafts) {
    if (draft.externalId) continue; // already has a stable id from the parser
    const content = [
      draft.isin ?? draft.ticker ?? draft.name ?? "",
      draft.action,
      draft.quantity,
      draft.price,
      draft.fees,
      draft.currency,
      draft.executedAt instanceof Date
        ? draft.executedAt.toISOString()
        : new Date(draft.executedAt).toISOString(),
    ].join("|");
    const hash = shortHash(content);
    const occ = occurrences.get(hash) ?? 0;
    occurrences.set(hash, occ + 1);
    // externalId is typed as `string | null | undefined` — cast through unknown to
    // bypass the readonly inference on the schema's inferred type.
    (draft as Record<string, unknown>).externalId = `${tag}:${hash}:${occ}`;
  }
}
