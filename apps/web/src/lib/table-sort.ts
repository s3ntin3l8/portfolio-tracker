"use client";

import { useCallback, useRef, useState } from "react";

export type SortDir = "asc" | "desc";
export type ColType = "text" | "numeric" | "date";

export interface ColDef<T> {
  key: string;
  get: (row: T) => unknown;
  type: ColType;
}

export interface UseTableSortResult<T> {
  sortKey: string | null;
  sortDir: SortDir;
  toggle: (key: string) => void;
  sort: (rows: T[]) => T[];
}

const TEXT_COLLATOR = new Intl.Collator(undefined, {
  sensitivity: "base",
  numeric: true,
});

function compareValues(a: unknown, b: unknown, type: ColType): number {
  switch (type) {
    case "text":
      return TEXT_COLLATOR.compare(String(a ?? ""), String(b ?? ""));
    case "numeric":
      return Number(a) - Number(b);
    case "date": {
      const aNum = Date.parse(String(a ?? ""));
      const bNum = Date.parse(String(b ?? ""));
      if (isNaN(aNum)) return isNaN(bNum) ? 0 : 1;
      if (isNaN(bNum)) return -1;
      return aNum - bNum;
    }
  }
}

export function useTableSort<T>(cols: ColDef<T>[]): UseTableSortResult<T> {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const toggle = useCallback(
    (key: string) => {
      if (sortKey === key) {
        setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
      } else {
        setSortKey(key);
        setSortDir("asc");
      }
    },
    [sortKey],
  );

  const colsRef = useRef(cols);
  // eslint-disable-next-line react-hooks/refs
  colsRef.current = cols;

  const sort = useCallback(
    (rows: T[]): T[] => {
      if (sortKey === null) return rows;
      const col = colsRef.current.find((c) => c.key === sortKey);
      if (!col) return rows;
      return [...rows].sort((a, b) => {
        const aVal = col.get(a);
        const bVal = col.get(b);
        const aMissing = aVal == null || aVal === "";
        const bMissing = bVal == null || bVal === "";
        if (aMissing && bMissing) return 0;
        if (aMissing) return 1;
        if (bMissing) return -1;
        const cmp = compareValues(aVal, bVal, col.type);
        return sortDir === "asc" ? cmp : -cmp;
      });
    },
    [sortKey, sortDir],
  );

  return { sortKey, sortDir, toggle, sort };
}
