"use client";

import { useState, useEffect, useRef } from "react";
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

interface TriggerButtonProps {
  name: string;
  supportsForce?: boolean;
  onTriggered: (priorLastRunAt: string | null, force: boolean) => void;
  currentLastRunAt: string | null;
}

function TriggerButton({ name, supportsForce, onTriggered, currentLastRunAt }: TriggerButtonProps) {
  const t = useTranslations("Admin");
  const api = useApiClient();
  const [pending, setPending] = useState(false);
  const [forcePending, setForcePending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function trigger(force: boolean) {
    setError(null);
    if (force) setForcePending(true);
    else setPending(true);
    try {
      await api.triggerAdminJob(name, force ? { force: true } : undefined);
      onTriggered(currentLastRunAt, force);
    } catch {
      setError(t("jobTriggerFailed"));
    } finally {
      if (force) setForcePending(false);
      else setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-1">
        <Button size="sm" variant="outline" onClick={() => { void trigger(false); }} disabled={pending || forcePending}>
          {pending ? t("jobRunning") : t("jobRunNow")}
        </Button>
        {supportsForce && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => { void trigger(true); }}
            disabled={pending || forcePending}
            aria-label={t("jobForce")}
            title={t("jobForce")}
          >
            {forcePending ? t("jobRunning") : t("jobForce")}
          </Button>
        )}
      </div>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}

interface PendingEntry {
  priorLastRunAt: string | null;
  timedOut?: boolean;
}

const POLL_INTERVAL_MS = 3_000;
const MAX_POLLS = 10;

interface AdminJobsProps {
  initialJobs: AdminJob[];
  schedulerAvailable: boolean;
}

export function AdminJobs({ initialJobs, schedulerAvailable }: AdminJobsProps) {
  const t = useTranslations("Admin");
  const api = useApiClient();
  const [jobs, setJobs] = useState<AdminJob[]>(initialJobs);
  const [pending, setPending] = useState<Record<string, PendingEntry>>({});
  const pollCounts = useRef<Record<string, number>>({});

  const hasPending = Object.values(pending).some((e) => !e.timedOut);

  useEffect(() => {
    if (!hasPending) return;

    const id = setInterval(async () => {
      let fresh: AdminJob[] | null = null;
      try {
        const result = await api.getAdminJobs();
        fresh = result.jobs;
      } catch {
        return;
      }

      setPending((prev) => {
        const next = { ...prev };
        for (const [name, entry] of Object.entries(prev)) {
          if (entry.timedOut) continue;
          pollCounts.current[name] = (pollCounts.current[name] ?? 0) + 1;
          const freshJob = fresh?.find((j) => j.name === name);
          const didTimeOut = pollCounts.current[name] >= MAX_POLLS;

          if (didTimeOut) {
            next[name] = { ...entry, timedOut: true };
          } else if (!freshJob) {
            delete next[name];
            delete pollCounts.current[name];
          } else if (freshJob.lastRunAt !== entry.priorLastRunAt) {
            delete next[name];
            delete pollCounts.current[name];
          }
        }
        return next;
      });

      if (fresh) {
        setJobs((prev) =>
          prev.map((job) => fresh!.find((f) => f.name === job.name) ?? job),
        );
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(id);
  }, [hasPending, api]);

  if (!schedulerAvailable) {
    return (
      <p className="text-sm text-muted-foreground italic">{t("schedulerUnavailable")}</p>
    );
  }

  return (
    <>
      <div className="hidden overflow-x-auto rounded-md border border-border md:block">
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
            {jobs.map((job) => {
              const entry = pending[job.name];
              const isPending = Boolean(entry) && !entry?.timedOut;
              const timedOut = Boolean(entry?.timedOut);
              return (
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
                  <td className="px-3 py-2 text-muted-foreground" aria-live="polite">
                    {isPending ? (
                      <span className="text-xs text-green-600">{t("jobQueued")}</span>
                    ) : timedOut ? (
                      <span className="text-xs text-amber-600">{t("jobPollTimedOut")}</span>
                    ) : (
                      <span className="text-xs">{formatRelative(job.lastRunAt)}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 hidden sm:table-cell">
                    <StatusBadge status={job.lastStatus} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <TriggerButton
                      name={job.name}
                      supportsForce={job.supportsForce}
                      currentLastRunAt={job.lastRunAt}
                      onTriggered={(priorLastRunAt) => {
                        pollCounts.current[job.name] = 0;
                        setPending((prev) => ({
                          ...prev,
                          [job.name]: { priorLastRunAt },
                        }));
                      }}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="space-y-3 md:hidden">
        {jobs.map((job) => {
          const entry = pending[job.name];
          const isPending = Boolean(entry) && !entry?.timedOut;
          const timedOut = Boolean(entry?.timedOut);
          return (
            <div key={job.name} className="rounded-[14px] border border-border bg-card p-3.5">
              <div className="flex items-start justify-between gap-2">
                <span className="text-sm font-bold">{job.label}</span>
                <StatusBadge status={job.lastStatus} />
              </div>
              {job.description && (
                <div className="mt-0.5 text-xs text-muted-foreground">{job.description}</div>
              )}
              <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
                <code className="rounded bg-muted px-1 py-0.5">{job.cron ?? "on-demand"}</code>
                <span>·</span>
                {isPending ? (
                  <span className="text-green-600">{t("jobQueued")}</span>
                ) : timedOut ? (
                  <span className="text-amber-600">{t("jobPollTimedOut")}</span>
                ) : (
                  <span>{formatRelative(job.lastRunAt)}</span>
                )}
              </div>
              <div className="mt-2">
                <TriggerButton
                  name={job.name}
                  supportsForce={job.supportsForce}
                  currentLastRunAt={job.lastRunAt}
                  onTriggered={(priorLastRunAt) => {
                    pollCounts.current[job.name] = 0;
                    setPending((prev) => ({
                      ...prev,
                      [job.name]: { priorLastRunAt },
                    }));
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
