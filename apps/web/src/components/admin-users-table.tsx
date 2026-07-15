import type { AdminUser } from "@portfolio/api-client";
import { AdminUserActions } from "@/components/admin-user-actions";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function AdminUsersTable({ users }: { users: AdminUser[] }) {
  if (users.length === 0) {
    return <p className="text-sm text-muted-foreground italic">No users registered yet.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className="px-3 py-2 font-medium text-muted-foreground">Email</th>
            <th className="px-3 py-2 font-medium text-muted-foreground">Name</th>
            <th className="px-3 py-2 font-medium text-muted-foreground">Signed up</th>
            <th className="px-3 py-2 text-right font-medium text-muted-foreground">Portfolios</th>
            <th className="px-3 py-2 text-right font-medium text-muted-foreground">Transactions</th>
            <th className="px-3 py-2 text-right font-medium text-muted-foreground">Documents</th>
            <th className="px-3 py-2 text-right font-medium text-muted-foreground">Storage</th>
            <th className="px-3 py-2 text-right font-medium text-muted-foreground">Tokens</th>
            <th className="px-3 py-2 text-right font-medium text-muted-foreground">Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className="border-b border-border last:border-0">
              <td className="px-3 py-1.5">{u.email}</td>
              <td className="px-3 py-1.5 text-muted-foreground">{u.name ?? "—"}</td>
              <td className="px-3 py-1.5 text-muted-foreground tabular-nums">
                {new Date(u.createdAt).toLocaleDateString()}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                {u.portfolioCount}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                {u.transactionCount}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                {u.documentCount}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                {formatBytes(u.storageBytes)}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                {u.tokenCount}
              </td>
              <td className="px-3 py-1.5 text-right">
                <AdminUserActions userId={u.id} email={u.email} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
