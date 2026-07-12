import { useRef, useState } from "react";
import { haptics } from "@/lib/haptics";

/**
 * Long-press-to-select gesture for a mobile card list: checkboxes stay hidden until a
 * touch-and-hold (or long-click) enters selection mode, mirroring the pattern already
 * shipped inline in `transactions-table.tsx` (same 450ms hold / 10px move-cancel threshold).
 * Extracted here so a second list (`ImportHistory`) can reuse the gesture without duplicating
 * the timing logic or touching that larger, heavily-tested file.
 *
 * This hook owns only the gesture and the `selectionMode` flag — it does NOT own a selected-
 * ids Set, since a list that already has bulk actions (desktop checkboxes, a bulk-delete bar)
 * needs one `selected` state shared across both layouts. Pass `onLongPress` to add the pressed
 * row to that existing selection when the hold completes.
 *
 * Usage: spread `longPressHandlers(id)` onto a pressable row; call `consumeLongPress()` at the
 * top of the row's tap/click handler and bail out if it returns true — that swallows the click
 * a long-press's pointerup otherwise still fires.
 */
export function useLongPressSelect(onLongPress: (id: string) => void) {
  const [selectionMode, setSelectionMode] = useState(false);

  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);
  const pressStart = useRef<{ x: number; y: number } | null>(null);

  function clearLongPress() {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }

  function startLongPress(id: string, e: React.PointerEvent) {
    longPressFired.current = false;
    pressStart.current = { x: e.clientX, y: e.clientY };
    clearLongPress();
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      setSelectionMode(true);
      haptics.selectionStart();
      onLongPress(id);
    }, 450);
  }

  // Cancel the hold only on real movement (a scroll), not the sub-pixel finger jitter touch
  // browsers report while holding still — a bare "cancel on any move" never fires on touch.
  // 10px threshold distinguishes a hold from a scroll/drag.
  function onPressMove(e: React.PointerEvent) {
    const start = pressStart.current;
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) {
      clearLongPress();
    }
  }

  function longPressHandlers(id: string) {
    return {
      onPointerDown: (e: React.PointerEvent) => startLongPress(id, e),
      onPointerUp: clearLongPress,
      onPointerLeave: clearLongPress,
      onPointerMove: onPressMove,
    };
  }

  // Called at the top of a row's tap/click handler — returns true (and resets the flag) if
  // this click is the one following a long-press, so the caller can bail out instead of also
  // treating it as a normal tap.
  function consumeLongPress(): boolean {
    if (longPressFired.current) {
      longPressFired.current = false;
      return true;
    }
    return false;
  }

  return { selectionMode, setSelectionMode, longPressHandlers, consumeLongPress };
}
