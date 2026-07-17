"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, Check, Lock } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type {
  AdminProvider,
  AdminProvidersResponse,
  ApiClient,
  ProviderCredentialInput,
} from "@portfolio/api-client";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SortableRow, SortableCard } from "@/components/sortable-utils";
import { UsageCell } from "./admin-providers-form/usage-cell";
import { CredentialCell } from "./admin-providers-form/credential-cell";

/** The slice of the API client this form needs (injectable for tests). */
export type AdminProvidersClient = Pick<
  ApiClient,
  "updateAdminProviders" | "setAdminProviderCredential" | "clearAdminProviderCredential"
>;

// Order + enabled flags only — id/label/configured are immutable here.
const signature = (rows: AdminProvider[]) =>
  rows.map((r) => `${r.id}:${r.enabled ? 1 : 0}`).join(",");

export function AdminProvidersForm({
  client,
  initialProviders,
  encryptionEnabled,
  onSuccess,
}: {
  client: AdminProvidersClient;
  initialProviders: AdminProvider[];
  encryptionEnabled: boolean;
  onSuccess?: () => void;
}) {
  const t = useTranslations("Admin");
  const [rows, setRows] = useState(initialProviders);
  // Baseline the form diffs against; advances on a successful save.
  const [baseline, setBaseline] = useState(initialProviders);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);
  const [reorderMode, setReorderMode] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const dirty = signature(rows) !== signature(baseline);

  function refreshFromResponse(res: AdminProvidersResponse) {
    setRows(res.providers);
    setBaseline(res.providers);
    onSuccess?.();
  }

  function toggle(id: string) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)));
    setSaved(false);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setRows((rs) => {
        const oldIndex = rs.findIndex((r) => r.id === active.id);
        const newIndex = rs.findIndex((r) => r.id === over.id);
        return arrayMove(rs, oldIndex, newIndex);
      });
      setSaved(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!dirty || busy) return;
    setBusy(true);
    setError(false);
    setSaved(false);
    try {
      const updated = await client.updateAdminProviders(
        rows.map((r, i) => ({ id: r.id, enabled: r.enabled, priority: i + 1 })),
      );
      refreshFromResponse(updated);
      setSaved(true);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  async function handleSetCredential(id: string, body: ProviderCredentialInput) {
    const updated = await client.setAdminProviderCredential(id, body);
    refreshFromResponse(updated);
  }

  async function handleClearCredential(id: string) {
    const updated = await client.clearAdminProviderCredential(id);
    refreshFromResponse(updated);
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <AlertCircle className="size-4 shrink-0" />
          {t("updateError")}
        </div>
      )}

      {encryptionEnabled && (
        <div className="flex items-center gap-2.5 rounded-[14px] border border-primary/20 bg-primary/10 px-3.5 py-2.5">
          <Lock className="size-[17px] shrink-0 text-primary" strokeWidth={2} />
          <p className="text-xs">
            <span className="font-semibold text-foreground">{t("credentialEncrypted")}</span>{" "}
            <span className="font-medium text-text-2">· {t("credentialEncryptedMeta")}</span>
          </p>
        </div>
      )}

      {/* Desktop: separate DndContext so useSortable ids don't collide with mobile */}
      <DndContext
        id="admin-providers-desktop"
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <div className="hidden overflow-x-auto rounded-md border border-border md:block">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="w-8 px-3 py-2" aria-label={t("dragHandle")} />
                <th className="px-3 py-2 text-left font-medium text-muted-foreground hidden sm:table-cell">
                  #
                </th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                  {t("providerName")}
                </th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                  {t("enabledHeader")}
                </th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground hidden sm:table-cell">
                  {t("apiCalls")}
                </th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">
                  {t("apiKey")}
                </th>
              </tr>
            </thead>
            <tbody>
              <SortableContext items={rows.map((r) => r.id)} strategy={verticalListSortingStrategy}>
                {rows.map((p, i) => (
                  <SortableRow key={p.id} id={p.id} dragHandleLabel={t("dragHandle")}>
                    {(handle) => (
                      <>
                        <td className="px-3 py-2">{handle}</td>
                        <td className="px-3 py-2 text-xs tabular-nums text-muted-foreground hidden sm:table-cell">
                          {i + 1}
                        </td>
                        <td className="px-3 py-2">
                          <div className="font-medium">{p.label}</div>
                          {!p.configured && (
                            <div className="text-xs text-muted-foreground">
                              {t("notConfigured")}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <Switch
                            checked={p.enabled}
                            disabled={!p.configured}
                            onCheckedChange={() => toggle(p.id)}
                            aria-label={p.enabled ? t("enabled") : t("disabled")}
                          />
                        </td>
                        <td className="px-3 py-2 hidden sm:table-cell">
                          <UsageCell usage={p.usage} />
                        </td>
                        <td className="px-3 py-2">
                          <CredentialCell
                            provider={p}
                            encryptionEnabled={encryptionEnabled}
                            onSet={handleSetCredential}
                            onClear={handleClearCredential}
                          />
                        </td>
                      </>
                    )}
                  </SortableRow>
                ))}
              </SortableContext>
            </tbody>
          </table>
        </div>
      </DndContext>

      {/* Mobile: reorder toggle + cards. Separate DndContext to avoid useSortable
          id collisions with the always-mounted desktop SortableRows. */}
      <DndContext
        id="admin-providers-mobile"
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <div className="md:hidden">
          <div className="mb-3 flex items-center justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setReorderMode((v) => !v)}
            >
              {reorderMode ? t("done") : t("reorder")}
            </Button>
          </div>

          <SortableContext items={rows.map((r) => r.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-2">
              {rows.map((p, i) => {
                if (reorderMode) {
                  return (
                    <SortableCard
                      key={p.id}
                      id={p.id}
                      disabled={false}
                      dragHandleLabel={t("dragHandle")}
                    >
                      {(handle) => (
                        <div className="flex items-center gap-3">
                          {handle}
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-bold">{p.label}</div>
                            {!p.configured && (
                              <div className="text-xs text-muted-foreground">
                                {t("notConfigured")}
                              </div>
                            )}
                          </div>
                          <span className="tabular-nums text-xs text-muted-foreground">
                            #{i + 1}
                          </span>
                        </div>
                      )}
                    </SortableCard>
                  );
                }

                return (
                  <div key={p.id} className="rounded-[14px] border border-border bg-card p-3.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-bold">{p.label}</span>
                      <Switch
                        checked={p.enabled}
                        disabled={!p.configured}
                        onCheckedChange={() => toggle(p.id)}
                        aria-label={p.enabled ? t("enabled") : t("disabled")}
                      />
                    </div>
                    {!p.configured && (
                      <div className="mt-1 text-xs text-muted-foreground">{t("notConfigured")}</div>
                    )}
                    <div className="mt-2">
                      <CredentialCell
                        provider={p}
                        encryptionEnabled={encryptionEnabled}
                        onSet={handleSetCredential}
                        onClear={handleClearCredential}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </SortableContext>
        </div>
      </DndContext>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={busy || !dirty}>
          {busy && <Spinner size="sm" />}
          {busy ? t("saving") : t("save")}
        </Button>
        {saved && !dirty && (
          <span className="flex items-center gap-1 text-sm text-muted-foreground">
            <Check className="size-4" />
            {t("saved")}
          </span>
        )}
      </div>
    </form>
  );
}
