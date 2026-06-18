"use client";

import { useState, useTransition } from "react";
import { useApiClient } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useTranslations } from "next-intl";
import type { AdminJob } from "@portfolio/api-client";

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function StatusBadge({ status }: { status: AdminJob["lastStatus"] }) {
  if (!status) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <Badge variant={status === "completed" ? "default" : "destructive"} className="text-xs">
      {status}
    </Badge>
  );
}

function TriggerButton({ name, onTriggered }: { name: string; onTriggered: () => void }) {
  const t = useTranslations("Admin");
  const api = useApiClient();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleClick() {
    setError(null);
    startTransition(async () => {
      try {
        await api.triggerAdminJob(name);
        onTriggered();
      } catch {
        setError(t("jobTriggerFailed"));
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" variant="outline" onClick={handleClick} disabled={pending}>
        {pending ? t("jobRunning") : t("jobRunNow")}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}

interface AdminJobsProps {
  initialJobs: AdminJob[];
  schedulerAvailable: boolean;
}

export function AdminJobs({ initialJobs, schedulerAvailable }: AdminJobsProps) {
  const t = useTranslations("Admin");
  const [triggeredAt, setTriggeredAt] = useState<Record<string, string>>({});

  if (!schedulerAvailable) {
    return (
      <p className="text-sm text-muted-foreground italic">{t("schedulerUnavailable")}</p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/50">
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">
              {t("jobName")}
            </th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground hidden sm:table-cell">
              {t("jobSchedule")}
            </th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">
              {t("jobLastRun")}
            </th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground hidden sm:table-cell">
              {t("jobStatus")}
            </th>
            <th className="px-3 py-2 text-right font-medium text-muted-foreground">
              {t("jobAction")}
            </th>
          </tr>
        </thead>
        <tbody>
          {initialJobs.map((job) => (
            <tr key={job.name} className="border-b border-border last:border-0">
              <td className="px-3 py-2">
                <div className="font-medium">{job.label}</div>
                <div className="text-xs text-muted-foreground mt-0.5 hidden sm:block">
                  {job.description}
                </div>
              </td>
              <td className="px-3 py-2 hidden sm:table-cell">
                <code className="text-xs bg-muted px-1 py-0.5 rounded">{job.cron ?? "on-demand"}</code>
              </td>
              <td className="px-3 py-2 text-muted-foreground">
                {triggeredAt[job.name]
                  ? <span className="text-xs text-green-600">{t("jobQueued")}</span>
                  : <span className="text-xs">{formatRelative(job.lastRunAt)}</span>}
              </td>
              <td className="px-3 py-2 hidden sm:table-cell">
                <StatusBadge status={job.lastStatus} />
              </td>
              <td className="px-3 py-2 text-right">
                <TriggerButton
                  name={job.name}
                  onTriggered={() =>
                    setTriggeredAt((prev) => ({
                      ...prev,
                      [job.name]: new Date().toISOString(),
                    }))
                  }
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
