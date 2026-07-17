"use client";

import { useState, useMemo } from "react";
import { useLongPressSelect } from "@/lib/use-long-press-select";
import { haptics } from "@/lib/haptics";
import type { ImportRecord } from "@portfolio/api-client";
import type { ApiClient } from "@portfolio/api-client";
import { isDeadSyncAnchor } from "./utils";

export function useImportSelection(
  allItems: ImportRecord[],
  visibleItems: ImportRecord[],
  api: ApiClient,
  router: { refresh: () => void },
  onError?: () => void,
  onClearBusy?: (busy: boolean) => void,
) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [confirmingBulk, setConfirmingBulk] = useState(false);

  const { selectionMode, setSelectionMode, longPressHandlers, consumeLongPress } =
    useLongPressSelect((id) => toggleOne(id));

  const discardedIds = useMemo(
    () => allItems.filter((i) => i.status === "discarded").map((i) => i.id),
    [allItems],
  );

  const confirmedCount = useMemo(
    () => allItems.filter((i) => i.status === "confirmed" && !isDeadSyncAnchor(i)).length,
    [allItems],
  );

  const allSelected = visibleItems.length > 0 && visibleItems.every((i) => selected.has(i.id));

  const selectedItems = useMemo(
    () => visibleItems.filter((i) => selected.has(i.id)),
    [visibleItems, selected],
  );

  const selectedConfirmedTx = useMemo(
    () =>
      selectedItems.filter((i) => i.status === "confirmed").reduce((sum, i) => sum + i.count, 0),
    [selectedItems],
  );

  function exitSelection() {
    setSelected(new Set());
    setSelectionMode(false);
    setConfirmingBulk(false);
  }

  function toggleOne(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
    if (next.size === 0) setSelectionMode(false);
    setConfirmingBulk(false);
  }

  function setMany(ids: string[], on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
    setConfirmingBulk(false);
  }

  function toggleAllVisible() {
    setMany(
      visibleItems.map((i) => i.id),
      !allSelected,
    );
  }

  async function bulkDelete() {
    if (selectedConfirmedTx > 0 && !confirmingBulk) {
      setConfirmingBulk(true);
      return;
    }
    haptics.destructiveConfirm();
    setBulkBusy(true);
    try {
      await api.bulkDeleteImports([...selected]);
      setSelected(new Set());
      setSelectionMode(false);
      setConfirmingBulk(false);
      router.refresh();
    } catch {
      onError?.();
    } finally {
      setBulkBusy(false);
    }
  }

  async function clearAllDiscarded() {
    onClearBusy?.(true);
    try {
      await api.bulkClearImports(discardedIds);
      router.refresh();
    } catch {
      onError?.();
    } finally {
      onClearBusy?.(false);
    }
  }

  return {
    selected,
    setSelected,
    bulkBusy,
    confirmingBulk,
    setConfirmingBulk,
    selectionMode,
    setSelectionMode,
    longPressHandlers,
    consumeLongPress,
    discardedIds,
    confirmedCount,
    allSelected,
    selectedItems,
    selectedConfirmedTx,
    exitSelection,
    toggleOne,
    setMany,
    toggleAllVisible,
    bulkDelete,
    clearAllDiscarded,
  };
}
