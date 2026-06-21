import type { AdminStats } from "@portfolio/api-client";

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatRows(rows: number | null | undefined): string {
  if (rows == null) return "—";
  return rows.toLocaleString();
}

/**
 * Server-rendered DB + storage statistics card. Pure display — no client interactivity needed.
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

      {/* Object storage stats */}
      <div className="rounded-md border border-border bg-muted/30 px-3 py-2 space-y-1">
        <span className="text-sm font-medium">Object storage</span>
        {!objectStorage.configured ? (
          <p className="text-xs text-muted-foreground">Not yet configured or stats unavailable.</p>
        ) : (
          <>
            {"error" in objectStorage && objectStorage.error ? (
              <p className="text-xs text-destructive">{objectStorage.error}</p>
            ) : (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-muted-foreground mt-1">
                {objectStorage.provider && (
                  <>
                    <dt>Provider</dt>
                    <dd className="font-mono">{objectStorage.provider}</dd>
                  </>
                )}
                {objectStorage.objectCount !== undefined && (
                  <>
                    <dt>Objects</dt>
                    <dd className="tabular-nums">{objectStorage.objectCount.toLocaleString()}</dd>
                  </>
                )}
                {objectStorage.totalBytes !== undefined && (
                  <>
                    <dt>Used</dt>
                    <dd className="tabular-nums">{formatBytes(objectStorage.totalBytes)}</dd>
                  </>
                )}
                {objectStorage.freeBytes !== undefined && (
                  <>
                    <dt>Free</dt>
                    <dd className="tabular-nums">{formatBytes(objectStorage.freeBytes)}</dd>
                  </>
                )}
                {objectStorage.diskTotalBytes !== undefined && (
                  <>
                    <dt>Disk total</dt>
                    <dd className="tabular-nums">{formatBytes(objectStorage.diskTotalBytes)}</dd>
                  </>
                )}
              </dl>
            )}
          </>
        )}
      </div>
    </div>
  );
}
