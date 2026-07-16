"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Positions a floating tooltip relative to a hover/focus target. Returns
 * open state and viewport-relative coordinates; the caller is responsible
 * for rendering the tooltip (typically via `createPortal(..., document.body)`)
 * and supplying its content. The `bind(content)` API caches the per-target
 * payload so the tooltip content updates as the user moves between targets.
 *
 * Why no ref parameter: the three target components have a one-to-many
 * shape (e.g. the heatmap has dozens of month cells) where a single
 * `useRef` slot can only point to one of them. Instead, the per-target
 * element comes from `event.currentTarget` inside each handler, and the
 * hook tracks the active target via a ref that's only read inside event
 * handlers and effects (never during render — see #478).
 *
 * Behavior:
 * - mouseenter/leave → open/close
 * - focus/blur (keyboard a11y) → open/close
 * - tap on the target toggles the tooltip; an outside tap or Escape closes
 * - viewport collision: flips horizontally if within 12px of the right
 *   edge, vertically if within 12px of the bottom edge
 * - re-positions on scroll/resize while open so the tooltip tracks the
 *   target if the user scrolls
 *
 * The hook is the non-Recharts counterpart to Recharts' built-in
 * `<Tooltip>`, which positions itself automatically. The three non-Recharts
 * charts called out in #478 (income-heatmap, holding-sparkline, mini-split
 * bar) need this manual positioning layer since they don't render inside
 * Recharts' SVG context.
 *
 * Panel-size feedback loop: `setSize` is meant to be wired to
 * {@link ChartTooltipPanel}'s `onSize` prop. The hook uses the stored
 * size to decide viewport-collision flips; until the panel reports back
 * (typically on the first render of the open tooltip), the hook falls
 * back to a 200×80 approximation. This replaced a hardcoded constant
 * pair in the #478 review (#5): the real size matters for longer /
 * multi-row tooltips that exceed the approximation.
 */
export function useChartTooltip<C>() {
  const targetElRef = useRef<Element | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [content, setContent] = useState<C | null>(null);
  // Approximate the tooltip's footprint so collision-flip works before the
  // tooltip is actually rendered. Matches ChartTooltipPanel's minWidth + the
  // typical single-row height of a title + 1-2 rows. The panel reports its
  // real size via `setSize`; once it does, this approximation is replaced
  // and subsequent flips use the measured dimensions.
  //
  // The size is held in a ref rather than state so that `setSize` can
  // write the new size and synchronously call `update` (which reads
  // from this ref) in the same tick. A `useState` here would be stale
  // until the next render — `update` would close over the old size
  // and the position would be computed with the previous dimensions.
  // The position state (`pos`) handles the downstream re-render that
  // propagates the new coordinates to the consumer; the size ref
  // handles the synchronous write/read.
  const panelSizeRef = useRef<{ width: number; height: number }>({ width: 200, height: 80 });

  const update = useCallback((el: Element) => {
    const r = el.getBoundingClientRect();
    const TIP_W = panelSizeRef.current.width;
    const TIP_H = panelSizeRef.current.height;
    const GAP = 8;
    const flipX = r.right + TIP_W + GAP > window.innerWidth - 12;
    const flipY = r.bottom + TIP_H + GAP > window.innerHeight - 12;
    setPos({
      x: flipX ? Math.max(12, r.left - TIP_W - GAP) : r.right + GAP,
      y: flipY ? Math.max(12, r.top - TIP_H - GAP) : r.bottom + GAP,
    });
  }, []);

  // Stable identity across renders so the panel's `useEffect([onSize])`
  // doesn't re-fire on every parent render. Returning a new function
  // each render would re-trigger the effect → onSize() → setSize →
  // re-render → new onSize → infinite loop.
  //
  // Also re-invokes `update` for the currently-open tooltip so the first
  // tooltip in a session that opens near a viewport edge snaps to the
  // correct position the moment the real size is measured, instead of
  // waiting for the next hover or scroll. (Reviewer observation in the
  // #491 follow-up: "position doesn't self-correct for the current
  // open tooltip once the real size arrives.") `targetElRef.current` is
  // the active target's element (set by mouseenter/focus/click,
  // cleared by leave/blur), so guarding on it is equivalent to "a
  // tooltip is (or was just) open" — the existing setSize call site
  // is the panel's mount effect, so this only runs while the panel
  // is mounted.
  const setSize = useCallback(
    (size: { width: number; height: number }) => {
      panelSizeRef.current = size;
      if (targetElRef.current) update(targetElRef.current);
    },
    [update],
  );

  /**
   * Returns a spread of listeners to attach to the hover target. `cellContent`
   * is captured per-call so the tooltip renders the right payload for the
   * target the user is currently over (e.g. the specific heatmap cell).
   * The current element is read from `event.currentTarget` so a single hook
   * can serve a one-to-many target set.
   *
   * Event types are typed against `Element` (the common supertype of
   * `HTMLElement` and `SVGElement`) so the same listeners spread onto both
   * HTML and SVG targets without contravariance errors.
   */
  const bind = useCallback(
    (cellContent: C) => ({
      onMouseEnter: (e: React.MouseEvent<Element>) => {
        const el = e.currentTarget;
        targetElRef.current = el;
        setContent(cellContent);
        setOpen(true);
        update(el);
      },
      onMouseLeave: () => {
        targetElRef.current = null;
        setOpen(false);
      },
      onFocus: (e: React.FocusEvent<Element>) => {
        const el = e.currentTarget;
        targetElRef.current = el;
        setContent(cellContent);
        setOpen(true);
        update(el);
      },
      onBlur: () => {
        targetElRef.current = null;
        setOpen(false);
      },
      onClick: (e: React.MouseEvent<Element>) => {
        const el = e.currentTarget;
        targetElRef.current = el;
        setContent(cellContent);
        setOpen((o) => !o);
        update(el);
      },
    }),
    [update],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onOutside = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node | null;
      if (t && targetElRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onScroll = () => {
      const el = targetElRef.current;
      if (el) update(el);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onOutside, true);
    window.addEventListener("touchstart", onOutside, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onOutside, true);
      window.removeEventListener("touchstart", onOutside, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, update]);

  return {
    open,
    x: pos.x,
    y: pos.y,
    content,
    bind,
    setSize,
    close: () => setOpen(false),
  };
}
