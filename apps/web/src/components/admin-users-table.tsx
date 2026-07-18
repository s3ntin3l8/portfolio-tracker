import { getTranslations } from "next-intl/server";
import type { AdminUser } from "@portfolio/api-client";
import { AdminUserActions } from "@/components/admin-user-actions";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export async function AdminUsersTable({ users }: { users: AdminUser[] }) {
  const t = await getTranslations("Admin");

  if (users.length === 0) {
    return <p className="text-sm text-muted-foreground italic">{t("usersNoUsers")}</p>;
  }

  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="px-3 py-2 font-medium text-muted-foreground">{t("usersEmail")}</th>
              <th className="px-3 py-2 font-medium text-muted-foreground">{t("usersName")}</th>
              <th className="px-3 py-2 font-medium text-muted-foreground">
                {t("usersSignupDate")}
              </th>
              <th className="px-3 py-2 text-right font-medium text-muted-foreground">
                {t("usersPortfolios")}
              </th>
              <th className="px-3 py-2 text-right font-medium text-muted-foreground">
                {t("usersTransactions")}
              </th>
              <th className="px-3 py-2 text-right font-medium text-muted-foreground">
                {t("usersDocuments")}
              </th>
              <th className="px-3 py-2 text-right font-medium text-muted-foreground">
                {t("usersStorage")}
              </th>
              <th className="px-3 py-2 text-right font-medium text-muted-foreground">
                {t("usersTokens")}
              </th>
              <th className="px-3 py-2 text-right font-medium text-muted-foreground">
                {t("usersActions")}
              </th>
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
                  <AdminUserActions
                    userId={u.id}
                    email={u.email}
                    onboardingCompleted={u.onboardingCompletedAt !== null}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="divide-y divide-border md:hidden">
        {users.map((u) => (
          <div key={u.id} className="px-4 py-3.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-sm font-bold">{u.email}</span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {new Date(u.createdAt).toLocaleDateString()}
              </span>
            </div>
            <div className="mt-0.5 truncate text-xs font-medium text-text-2">{u.name ?? "—"}</div>
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              <span>
                {u.portfolioCount} {t("usersPortfolios")}
              </span>
              <span>
                {u.transactionCount} {t("usersTransactions")}
              </span>
              <span>
                {u.documentCount} {t("usersDocuments")}
              </span>
              <span>{formatBytes(u.storageBytes)}</span>
              <span>
                {u.tokenCount} {t("usersTokens")}
              </span>
            </div>
            <div className="mt-2">
              <AdminUserActions
                userId={u.id}
                email={u.email}
                onboardingCompleted={u.onboardingCompletedAt !== null}
              />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
