import { useMemo } from "react";
import type { ImportRecord } from "@portfolio/api-client";

export function useBatchGroups(visibleItems: ImportRecord[]) {
  const batchGroups = useMemo(() => {
    const byBatch = new Map<string, ImportRecord[]>();
    for (const it of visibleItems) {
      if (!it.batchId) continue;
      const arr = byBatch.get(it.batchId) ?? [];
      arr.push(it);
      byBatch.set(it.batchId, arr);
    }
    return [...byBatch.entries()]
      .filter(([, arr]) => arr.length >= 2)
      .map(([batchId, arr]) => ({
        batchId,
        rows: [...arr].sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt)),
        uploadedAt: arr.reduce(
          (min, r) => (r.createdAt < min ? r.createdAt : min),
          arr[0]!.createdAt,
        ),
      }))
      .sort((a, b) => +new Date(b.uploadedAt) - +new Date(a.uploadedAt));
  }, [visibleItems]);

  const batchedIds = useMemo(
    () => new Set(batchGroups.flatMap((g) => g.rows.map((r) => r.id))),
    [batchGroups],
  );

  const looseItems = useMemo(
    () => visibleItems.filter((i) => !batchedIds.has(i.id)),
    [visibleItems, batchedIds],
  );

  return { batchGroups, looseItems };
}
