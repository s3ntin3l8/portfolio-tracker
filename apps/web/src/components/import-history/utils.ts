import type { ImportRecord } from "@portfolio/api-client";
import { parserToSourceType, SRC_STYLE, DEFAULT_SRC } from "@/lib/source-style";

export const isDeadSyncAnchor = (i: ImportRecord) =>
  (i.parser === "ibkr" || i.parser === "pytr") && i.status === "confirmed";

export function statusLabelKey(imp: ImportRecord): string {
  if ((imp.parser === "ibkr" || imp.parser === "pytr") && imp.status === "draft") {
    return "status.syncNeedsAttention";
  }
  return `status.${imp.status}`;
}

export function sourceMeta(imp: ImportRecord, ts: (key: string) => string) {
  const sourceType = parserToSourceType(imp.parser);
  const style = SRC_STYLE[sourceType] ?? DEFAULT_SRC;
  let sourceLabel = sourceType;
  try {
    sourceLabel = ts(`sources.${sourceType}`);
  } catch {
    /* unknown source type — keep the raw value */
  }
  return { style, sourceLabel, label: imp.originalFilename ?? sourceLabel };
}
