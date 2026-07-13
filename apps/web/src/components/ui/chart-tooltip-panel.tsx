"use client";

import { useEffect, useRef } from "react";

/**
 * Shared visual shell for all chart tooltips in the app. Renders a
 * var(--color-card) panel with a title row and a list of label/value rows
 * (each row can carry an optional 8x8 colored dot). Matches the visual
 * styling of Recharts' built-in `<Tooltip>` so every chart in the app
 * (donut, bar, area, overlay, and the bespoke non-Recharts tooltips
 * described in #478 — heatmap, sparkline, split bar) reads consistently.
 *
 * Position is the caller's responsibility: Recharts' `<Tooltip content={…}>`
 * positions this inside its own portal; the bespoke tooltips use
 * {@link useChartTooltip} and `createPortal(..., document.body)` with
 * `position: fixed` coordinates. This component only renders the inner
 * card.
 *
 * `onSize` reports the panel's measured dimensions back to the caller so
 * the positioning hook can flip the tooltip away from the viewport edge
 * using the *real* panel size instead of an approximation. This is the
 * #5 follow-up from the #478 review: previously `useChartTooltip` used
 * a fixed `TIP_W=200, TIP_H=80` to decide whether to flip, which could
 * overflow on longer or multi-row tooltips. The first render still uses
 * the hook's approximation (the panel isn't measured yet); once it
 * mounts, the real size flows back and the next `update()` uses it.
 */

export interface ChartTooltipRow {
  label: string;
  value: string;
  /** Optional 8x8 colored dot rendered before the label. */
  dot?: string;
  dotOpacity?: number;
}

export function ChartTooltipPanel({
  title,
  rows,
  onSize,
}: {
  title?: string;
  rows: ChartTooltipRow[];
  /**
   * Called whenever the rendered panel resizes (initial mount + every
   * subsequent size change). Wired by {@link useChartTooltip} via its
   * returned `setSize` so the hook can flip the tooltip away from
   * viewport edges using the real panel footprint.
   */
  onSize?: (size: { width: number; height: number }) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!onSize || !ref.current) return;
    const el = ref.current;
    // Fire the initial size synchronously so the hook's next update() can
    // use the real dimensions without waiting for a ResizeObserver tick.
    onSize({ width: el.offsetWidth, height: el.offsetHeight });
    // Explicit `entries: ResizeObserverEntry[]` annotation. The callback
    // signature in lib.dom.d.ts is `(entries, observer) => void`, and the
    // CodeQL `js/superfluous-trailing-arguments` rule misreads the
    // inferred single-arg form as "passing an unexpected argument to the
    // default constructor." Annotating the first parameter makes the
    // intended type explicit and silences the false positive without
    // needing a codeql suppression comment.
    const ro = new ResizeObserver((entries: ResizeObserverEntry[]) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      onSize({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [onSize]);

  if (rows.length === 0) return null;
  return (
    <div
      ref={ref}
      style={{
        background: "var(--color-card)",
        border: "1px solid var(--color-border)",
        borderRadius: 8,
        fontSize: 12,
        padding: "8px 12px",
        minWidth: 168,
      }}
    >
      {title && (
        <p style={{ marginBottom: 6, fontWeight: 700 }}>{title}</p>
      )}
      {rows.map((row, i) => (
        <div
          key={row.label}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 14,
            marginTop: i === 0 ? 0 : 4,
          }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: 6, opacity: 0.85 }}>
            {row.dot && (
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: row.dot,
                  opacity: row.dotOpacity ?? 1,
                  display: "inline-block",
                }}
              />
            )}
            {row.label}
          </span>
          <span style={{ fontWeight: 700 }}>{row.value}</span>
        </div>
      ))}
    </div>
  );
}
