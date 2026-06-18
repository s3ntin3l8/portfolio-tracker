"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  AlertCircle,
  Check,
  Eye,
  EyeOff,
  GripVertical,
  Loader2,
  Pencil,
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
import type {
  AdminVisionProvider,
  AdminVisionProvidersResponse,
  ApiClient,
  ProviderCredentialInput,
} from "@portfolio/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/** The slice of the API client this form needs (injectable for tests). */
export type AdminVisionProvidersClient = Pick<
  ApiClient,
  | "updateAdminVisionProviders"
  | "setAdminVisionProviderCredential"
  | "clearAdminVisionProviderCredential"
>;

/** Cell showing the current credential state + pencil edit button (Dialog) + inline clear. */
function VisionCredentialCell({
  provider,
  encryptionEnabled,
  onSet,
  onClear,
}: {
  provider: AdminVisionProvider;
  encryptionEnabled: boolean;
  onSet: (id: string, body: ProviderCredentialInput) => Promise<void>;
  onClear: (id: string) => Promise<void>;
}) {
  const t = useTranslations("Admin");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Ollama is a URL-based provider — edit a URL, not an API key.
  const isUrlProvider = provider.id === "ollama";
  const hasCredential = isUrlProvider ? provider.hasUrl : provider.hasKey;

  function handleDialogChange(open: boolean) {
    setDialogOpen(open);
    if (!open) {
      setApiKey("");
      setError(null);
      setShowKey(false);
    }
  }

  async function handleSet(e: React.FormEvent) {
    e.preventDefault();
    if (!apiKey.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const body: ProviderCredentialInput = isUrlProvider
        ? { urlOverride: apiKey.trim() }
        : { apiKey: apiKey.trim() };
      await onSet(provider.id, body);
      setApiKey("");
      setDialogOpen(false);
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

  // Encryption disabled — only key-based (non-URL) providers need encryption.
  if (!encryptionEnabled && !isUrlProvider) {
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

  // Inline credential state display.
  let display: React.ReactNode;
  if (hasCredential) {
    display = (
      <span className="font-mono text-xs text-muted-foreground">
        {provider.keyHint ?? (isUrlProvider ? t("visionUrlSet") : "••••")}
      </span>
    );
  } else if (provider.keySource === "env") {
    display = (
      <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
        {t("keyFromEnv")}
      </span>
    );
  } else {
    display = (
      <span className="text-xs text-muted-foreground">{t("keyNone")}</span>
    );
  }

  return (
    <div className="flex items-center gap-1">
      {display}
      {error && <span className="text-xs text-destructive">{error}</span>}

      <Dialog open={dialogOpen} onOpenChange={handleDialogChange}>
        <DialogTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
            aria-label={t("editCredential")}
          >
            <Pencil className="size-3" />
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{provider.label}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSet} className="space-y-3">
            <div className="relative">
              <Input
                type={isUrlProvider ? "url" : showKey ? "text" : "password"}
                placeholder={isUrlProvider ? t("visionUrlPlaceholder") : t("credentialPlaceholder")}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="pr-8 font-mono"
                autoComplete="off"
                autoFocus
              />
              {!isUrlProvider && (
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={showKey ? t("credentialHide") : t("credentialShow")}
                >
                  {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              )}
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={busy || !apiKey.trim()}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : t("credentialSave")}
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      {hasCredential && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-destructive hover:text-destructive"
          disabled={busy}
          onClick={handleClear}
          aria-label={t("credentialClear")}
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
        </Button>
      )}
    </div>
  );
}

/** Drag-sortable table row wrapping one vision provider. */
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
    <tr
      ref={setNodeRef}
      style={style}
      className={`border-b border-border last:border-0${isDragging ? " opacity-50" : ""}`}
    >
      {children(handle)}
    </tr>
  );
}

const signature = (rows: AdminVisionProvider[]) =>
  rows.map((r) => `${r.id}:${r.enabled ? 1 : 0}`).join(",");

export function AdminVisionProvidersForm({
  client,
  initialProviders,
  encryptionEnabled,
  onSuccess,
}: {
  client: AdminVisionProvidersClient;
  initialProviders: AdminVisionProvider[];
  encryptionEnabled: boolean;
  onSuccess?: () => void;
}) {
  const t = useTranslations("Admin");
  const [rows, setRows] = useState(initialProviders);
  const [baseline, setBaseline] = useState(initialProviders);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const dirty = signature(rows) !== signature(baseline);

  function refreshFromResponse(res: AdminVisionProvidersResponse) {
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
      const updated = await client.updateAdminVisionProviders(
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
    const updated = await client.setAdminVisionProviderCredential(id, body);
    refreshFromResponse(updated);
  }

  async function handleClearCredential(id: string) {
    const updated = await client.clearAdminVisionProviderCredential(id);
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
        <div className="overflow-x-auto rounded-md border border-border">
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
                        <td className="px-3 py-2">
                          <VisionCredentialCell
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
