import type { AdminStats } from "@portfolio/api-client";

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatRows(rows: number | null): string {
  if (rows === null) return "—";
  return rows.toLocaleString();
}

/**
 * Server-rendered DB statistics card. Pure display — no client interactivity needed.
 */
export function AdminStats({ stats }: { stats: AdminStats }) {
  const { db, objectStorage } = stats;

  return (
    <div className="space-y-4">
      {/* DB size summary */}
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-medium">Database</span>
        {db.sizeBytes !== null ? (
          <span className="text-sm text-muted-foreground">
            {formatBytes(db.sizeBytes)} total
          </span>
        ) : (
          <span className="text-xs text-muted-foreground italic">size unavailable</span>
        )}
      </div>

      {/* Per-table breakdown */}
      {db.tables.length > 0 ? (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Table</th>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">Rows (est.)</th>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">Size</th>
              </tr>
            </thead>
            <tbody>
              {db.tables.map((t) => (
                <tr key={t.name} className="border-b border-border last:border-0">
                  <td className="px-3 py-1.5 font-mono text-xs">{t.name}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                    {formatRows(t.rows)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                    {formatBytes(t.sizeBytes)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground italic">
          Table breakdown unavailable in this environment.
        </p>
      )}

      {/* Object storage */}
      <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
        <span className="text-sm font-medium">Object storage</span>
        <p className="mt-0.5 text-xs text-muted-foreground">{objectStorage.note}</p>
      </div>
    </div>
  );
}
