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
}: {
  title?: string;
  rows: ChartTooltipRow[];
}) {
  if (rows.length === 0) return null;
  return (
    <div
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
