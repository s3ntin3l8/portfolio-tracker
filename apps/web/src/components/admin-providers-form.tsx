"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  GripVertical,
  KeyRound,
  Loader2,
  ShieldOff,
  Trash2,
} from "lucide-react";
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
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { AdminProvider, AdminProvidersResponse, ApiClient, ProviderCredentialInput } from "@portfolio/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

/** The slice of the API client this form needs (injectable for tests). */
export type AdminProvidersClient = Pick<
  ApiClient,
  "updateAdminProviders" | "setAdminProviderCredential" | "clearAdminProviderCredential"
>;

/** A read-only "X / Y today" (or "X this month") badge from a provider's usage figures. */
function UsageBadge({ usage }: { usage: AdminProvider["usage"] }) {
  const t = useTranslations("Admin");
  if (!usage || usage.used === null) return null;
  const window = {
    minute: t("usageMinute"),
    day: t("usageDay"),
    month: t("usageMonth"),
  }[usage.window];
  const used = usage.used.toLocaleString();
  const text =
    usage.limit !== null
      ? t("usageUsedOfLimit", { used, limit: usage.limit.toLocaleString(), window })
      : t("usageUsed", { used, window });
  return (
    <span className="text-xs tabular-nums text-muted-foreground">
      {text}
      {usage.source === "local" && ` (${t("usageLocalHint")})`}
    </span>
  );
}

/** Inline key-set / clear form for one provider. */
function CredentialEditor({
  provider,
  encryptionEnabled,
  onSet,
  onClear,
}: {
  provider: AdminProvider;
  encryptionEnabled: boolean;
  onSet: (id: string, body: ProviderCredentialInput) => Promise<void>;
  onClear: (id: string) => Promise<void>;
}) {
  const t = useTranslations("Admin");
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSet(e: React.FormEvent) {
    e.preventDefault();
    if (!apiKey.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onSet(provider.id, { apiKey: apiKey.trim() });
      setApiKey("");
      setOpen(false);
    } catch {
      setError(t("credentialError"));
    } finally {
      setBusy(false);
    }
  }

  async function handleClear() {
    setBusy(true);
    setError(null);
    try {
      await onClear(provider.id);
    } catch {
      setError(t("credentialError"));
    } finally {
      setBusy(false);
    }
  }

  if (!encryptionEnabled) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {provider.keySource === "env" && (
          <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {t("keyFromEnv")}
          </span>
        )}
        <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
          <ShieldOff className="size-3 shrink-0" />
          {t("encryptionDisabled")}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {provider.hasKey ? (
          <>
            <span className="flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs font-mono text-muted-foreground">
              <KeyRound className="size-3 shrink-0" />
              {provider.keyHint}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-xs"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
            >
              {t("credentialRotate")}
              {open ? <ChevronUp className="ml-1 size-3" /> : <ChevronDown className="ml-1 size-3" />}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-xs text-destructive hover:text-destructive"
              disabled={busy}
              onClick={handleClear}
              aria-label={t("credentialClear")}
            >
              {busy ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
            </Button>
          </>
        ) : (
          <>
            {provider.keySource === "env" && (
              <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                {t("keyFromEnv")}
              </span>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-xs"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
            >
              {t("credentialSet")}
              {open ? <ChevronUp className="ml-1 size-3" /> : <ChevronDown className="ml-1 size-3" />}
            </Button>
          </>
        )}
      </div>

      {open && (
        <form onSubmit={handleSet} className="flex gap-2">
          <div className="relative flex-1">
            <Input
              type={showKey ? "text" : "password"}
              placeholder={t("credentialPlaceholder")}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="h-7 pr-8 text-xs font-mono"
              autoComplete="off"
              autoFocus
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label={showKey ? t("credentialHide") : t("credentialShow")}
            >
              {showKey ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
            </button>
          </div>
          <Button type="submit" size="sm" className="h-7 text-xs" disabled={busy || !apiKey.trim()}>
            {busy ? <Loader2 className="size-3 animate-spin" /> : t("credentialSave")}
          </Button>
        </form>
      )}

      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}
    </div>
  );
}

/** Drag-sortable list item wrapping one provider row. */
function SortableRow({
  id,
  dragHandleLabel,
  children,
}: {
  id: string;
  dragHandleLabel: string;
  children: (handle: React.ReactNode) => React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const handle = (
    <button
      type="button"
      {...attributes}
      {...listeners}
      aria-label={dragHandleLabel}
      className="cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
    >
      <GripVertical className="size-4" />
    </button>
  );

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`space-y-2 px-3 py-2.5 text-sm${isDragging ? " opacity-50" : ""}`}
    >
      {children(handle)}
    </li>
  );
}

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
    setRows((rs) =>
      rs.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)),
    );
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
      // Priority is the current display order (lower = tried first).
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

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <ul className="divide-y divide-border rounded-md border border-border">
          <SortableContext items={rows.map((r) => r.id)} strategy={verticalListSortingStrategy}>
            {rows.map((p, i) => (
              <SortableRow key={p.id} id={p.id} dragHandleLabel={t("dragHandle")}>
                {(handle) => (
                  <>
                    <div className="flex items-center gap-3">
                      {handle}
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {i + 1}
                      </span>
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="font-medium">{p.label}</span>
                        {!p.configured ? (
                          <span className="text-xs text-muted-foreground">
                            {t("notConfigured")}
                          </span>
                        ) : (
                          <UsageBadge usage={p.usage} />
                        )}
                      </div>

                      <Switch
                        checked={p.enabled}
                        disabled={!p.configured}
                        onCheckedChange={() => toggle(p.id)}
                        aria-label={p.enabled ? t("enabled") : t("disabled")}
                      />
                    </div>

                    <div className="pl-6">
                      <CredentialEditor
                        provider={p}
                        encryptionEnabled={encryptionEnabled}
                        onSet={handleSetCredential}
                        onClear={handleClearCredential}
                      />
                    </div>
                  </>
                )}
              </SortableRow>
            ))}
          </SortableContext>
        </ul>
      </DndContext>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={busy || !dirty}>
          {busy && <Loader2 className="size-4 animate-spin" />}
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
