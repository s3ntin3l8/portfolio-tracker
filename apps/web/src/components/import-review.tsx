"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Pencil, Trash2, X } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ImportDraft, ImportIssue, ReviewDraft } from "@/components/import-flow";

// Actions the mapping editor can assign to an unmapped event.
const MAP_ACTIONS = [
  "buy",
  "sell",
  "dividend",
  "coupon",
  "interest",
  "savings_plan",
  "deposit",
  "withdrawal",
] as const;

// Confidence below this reads as "needs review" — same threshold as the badge colour.
const NEEDS_REVIEW_BELOW = 0.9;

export interface ImportReviewProps {
  drafts: ReviewDraft[];
  onUpdate: (uid: string, patch: Partial<ImportDraft>) => void;
  onRemove: (uid: string) => void;
  onRemoveMany: (uids: string[]) => void;
  /** Confirm all drafts, or just the passed subset (confirm-selected). */
  onConfirm: (uids?: string[]) => void | Promise<void>;
  onDiscard: () => void | Promise<void>;
  /** Unmapped/skipped events surfaced for review (Trade Republic imports). */
  issues?: ImportIssue[];
  /** Turn an "attention" issue into a draft (user completed it in the map dialog). */
  onMapIssue?: (eventId: string, draft: ImportDraft) => void;
}

/**
 * The review step of the import flow: a compact, filterable, bulk-selectable list of
 * draft transactions. Renders a dense table on desktop and stacked cards on mobile;
 * editing happens in a focused dialog. Every action keys off the draft's stable `uid`,
 * so selection and edits stay correct while filtering hides rows or removals reindex
 * the underlying array.
 */
export function ImportReview({
  drafts,
  onUpdate,
  onRemove,
  onRemoveMany,
  onConfirm,
  onDiscard,
  issues = [],
  onMapIssue,
}: ImportReviewProps) {
  const t = useTranslations("Import");
  const tm = useTranslations("Manage");

  const attention = issues.filter((i) => i.severity === "attention" && i.eventId);
  const ignorable = issues.filter((i) => !(i.severity === "attention" && i.eventId));
  // The issue currently open in the map dialog, plus its in-progress draft fields.
  const [mapping, setMapping] = useState<ImportIssue | null>(null);
  const [mapForm, setMapForm] = useState<ImportDraft | null>(null);

  function openMap(issue: ImportIssue) {
    const raw = issue.raw ?? {};
    const amount = raw.amount != null ? Math.abs(raw.amount) : 0;
    setMapping(issue);
    setMapForm({
      assetClass: "equity",
      action: "buy",
      isin: raw.isin ?? null,
      name: raw.name ?? issue.eventType ?? "",
      quantity: "0",
      unit: "shares",
      price: String(amount),
      fees: "0",
      currency: raw.currency ?? "EUR",
      executedAt: (raw.executedAt ?? new Date().toISOString()).slice(0, 10),
      confidence: 1,
      externalId: issue.eventId ?? null,
    });
  }

  function saveMap() {
    if (mapping?.eventId && mapForm && onMapIssue) onMapIssue(mapping.eventId, mapForm);
    setMapping(null);
    setMapForm(null);
  }

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [editingUid, setEditingUid] = useState<string | null>(null);
  // Which write is in flight, so we can disable + spin its button. A large import
  // (hundreds of rows) can take 20–30s to commit; without this the button looks idle.
  const [pending, setPending] = useState<
    "confirm" | "confirmSelected" | "discard" | null
  >(null);
  const busy = pending !== null;

  async function runConfirm(
    action: "confirm" | "confirmSelected",
    uids?: string[],
  ) {
    setPending(action);
    try {
      await onConfirm(uids);
    } finally {
      setPending(null);
    }
  }

  async function runDiscard() {
    setPending("discard");
    try {
      await onDiscard();
    } finally {
      setPending(null);
    }
  }

  // Multi-select filters: an empty set means "all". A non-empty set is OR within the
  // dimension (e.g. buy OR sell), and dimensions AND together — so you can isolate exactly
  // the rows you want to confirm in one pass.
  const [assetClassFilter, setAssetClassFilter] = useState<Set<string>>(new Set());
  const [actionFilter, setActionFilter] = useState<Set<string>>(new Set());
  const [needsReviewOnly, setNeedsReviewOnly] = useState(false);
  const [query, setQuery] = useState("");

  function toggleFilter(
    setter: React.Dispatch<React.SetStateAction<Set<string>>>,
    value: string,
  ) {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  const assetClasses = useMemo(
    () => [...new Set(drafts.map((d) => d.assetClass))].sort(),
    [drafts],
  );
  const actions = useMemo(
    () => [...new Set(drafts.map((d) => d.action))].sort(),
    [drafts],
  );

  const filtersActive =
    assetClassFilter.size > 0 ||
    actionFilter.size > 0 ||
    needsReviewOnly ||
    query.trim() !== "";

  const view = useMemo(() => {
    const q = query.trim().toLowerCase();
    return drafts.filter((d) => {
      if (assetClassFilter.size && !assetClassFilter.has(d.assetClass)) return false;
      if (actionFilter.size && !actionFilter.has(d.action)) return false;
      if (needsReviewOnly && d.confidence >= NEEDS_REVIEW_BELOW) return false;
      if (q && !(d.name ?? "").toLowerCase().includes(q)) return false;
      return true;
    });
  }, [drafts, assetClassFilter, actionFilter, needsReviewOnly, query]);

  // Resolve selection through the live drafts so stale uids (from removals) never count.
  const selectedIds = useMemo(
    () => drafts.filter((d) => selected.has(d.uid)).map((d) => d.uid),
    [drafts, selected],
  );
  const allVisibleSelected =
    view.length > 0 && view.every((d) => selected.has(d.uid));

  function toggle(uid: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) for (const d of view) next.delete(d.uid);
      else for (const d of view) next.add(d.uid);
      return next;
    });
  }

  function handleRemove(uid: string) {
    onRemove(uid);
    setSelected((prev) => {
      if (!prev.has(uid)) return prev;
      const next = new Set(prev);
      next.delete(uid);
      return next;
    });
  }

  function removeSelected() {
    onRemoveMany(selectedIds);
    setSelected(new Set());
    setConfirming(false);
  }

  function clearFilters() {
    setAssetClassFilter(new Set());
    setActionFilter(new Set());
    setNeedsReviewOnly(false);
    setQuery("");
  }

  const editingDraft = drafts.find((d) => d.uid === editingUid) ?? null;
  const pct = (c: number) => t("confidence", { pct: Math.round(c * 100) });
  const dateOf = (d: ReviewDraft) => d.executedAt.slice(0, 10);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t("draftCount", { count: drafts.length })} — {t("reviewHint")}
      </p>

      {/* Issues: events that didn't map cleanly. "Attention" ones can be completed into
          drafts via the map dialog; ignorable info is tucked behind a disclosure. */}
      {(attention.length > 0 || ignorable.length > 0) && (
        <div className="space-y-2 rounded-lg border border-border bg-card/40 p-3">
          {attention.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-sm font-medium">
                {t("review.issues.attention", { count: attention.length })}
              </p>
              <ul className="space-y-1.5">
                {attention.map((issue) => (
                  <li
                    key={issue.eventId}
                    className="flex flex-wrap items-center justify-between gap-2 text-sm"
                  >
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {issue.raw?.name ?? issue.eventType} — {issue.message}
                    </span>
                    {onMapIssue && (
                      <Button size="sm" variant="secondary" onClick={() => openMap(issue)}>
                        {t("review.issues.map")}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {ignorable.length > 0 && (
            <details className="text-sm text-muted-foreground">
              <summary className="cursor-pointer">
                {t("review.issues.ignored", { count: ignorable.length })}
              </summary>
              <ul className="mt-1.5 space-y-1 pl-4">
                {ignorable.map((issue, i) => (
                  <li key={issue.eventId ?? i}>{issue.message}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {/* Filter bar */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        {assetClasses.length > 1 && (
          <ChipGroup
            label={t("review.filters.assetClass")}
            values={assetClasses}
            selected={assetClassFilter}
            onToggle={(v) => toggleFilter(setAssetClassFilter, v)}
          />
        )}
        {actions.length > 1 && (
          <ChipGroup
            label={t("review.filters.action")}
            values={actions}
            selected={actionFilter}
            onToggle={(v) => toggleFilter(setActionFilter, v)}
          />
        )}
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            className="size-4 align-middle accent-primary"
            checked={needsReviewOnly}
            onChange={(e) => setNeedsReviewOnly(e.target.checked)}
          />
          {t("review.filters.needsReview")}
        </label>
        <Input
          type="search"
          aria-label={t("review.filters.search")}
          placeholder={t("review.filters.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-9 sm:w-48"
        />
        {filtersActive && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>
              {t("review.filters.showing", { shown: view.length, total: drafts.length })}
            </span>
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              {t("review.filters.clear")}
            </Button>
          </div>
        )}
      </div>

      {/* Bulk-action toolbar (shown when anything is selected) */}
      {selectedIds.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card/60 px-4 py-2 text-sm">
          <span className="text-muted-foreground">
            {t("review.batch.selected", { count: selectedIds.length })}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => runConfirm("confirmSelected", selectedIds)}
            >
              {pending === "confirmSelected" && (
                <Loader2 className="size-3.5 animate-spin" />
              )}
              {t("review.batch.confirmSelected")}
            </Button>
            {confirming ? (
              <span className="flex items-center gap-2">
                <span className="text-muted-foreground">
                  {t("review.batch.removePrompt")}
                </span>
                <Button size="sm" variant="destructive" onClick={removeSelected}>
                  {t("review.batch.removeConfirm")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirming(false)}
                >
                  {t("review.batch.cancel")}
                </Button>
              </span>
            ) : (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => setConfirming(true)}
              >
                <Trash2 className="size-3.5" />
                {t("review.batch.remove")}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Desktop: dense table */}
      <div className="hidden rounded-xl border border-border md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <input
                  type="checkbox"
                  className="size-4 align-middle accent-primary"
                  aria-label={t("review.selectAll")}
                  checked={allVisibleSelected}
                  onChange={toggleAll}
                />
              </TableHead>
              <TableHead>{t("review.columns.confidence")}</TableHead>
              <TableHead>{t("review.columns.assetClass")}</TableHead>
              <TableHead>{t("review.columns.action")}</TableHead>
              <TableHead>{t("fields.name")}</TableHead>
              <TableHead>{t("fields.executedAt")}</TableHead>
              <TableHead className="text-right">{t("fields.quantity")}</TableHead>
              <TableHead className="text-right">{t("fields.price")}</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">{tm("actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.map((d) => {
              const isSelected = selected.has(d.uid);
              return (
                <TableRow key={d.uid} data-state={isSelected ? "selected" : undefined}>
                  <TableCell>
                    <input
                      type="checkbox"
                      className="size-4 align-middle accent-primary"
                      aria-label={t("review.selectRow")}
                      checked={isSelected}
                      onChange={() => toggle(d.uid)}
                    />
                  </TableCell>
                  <TableCell>
                    <Badge variant={d.confidence >= NEEDS_REVIEW_BELOW ? "success" : "warning"}>
                      {pct(d.confidence)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{d.assetClass}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="success">{d.action}</Badge>
                  </TableCell>
                  <TableCell className="font-medium">{d.name ?? "—"}</TableCell>
                  <TableCell className="tabular whitespace-nowrap text-muted-foreground">
                    {dateOf(d)}
                  </TableCell>
                  <TableCell className="tabular text-right">{d.quantity}</TableCell>
                  <TableCell className="tabular text-right">{d.price}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t("review.edit.open")}
                        onClick={() => setEditingUid(d.uid)}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      {drafts.length > 1 && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t("remove")}
                          onClick={() => handleRemove(d.uid)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {view.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={9}
                  className="py-8 text-center text-sm text-muted-foreground"
                >
                  {t("review.empty")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Mobile: stacked cards */}
      <div className="space-y-2 md:hidden">
        {view.map((d) => (
          <div key={d.uid} className="rounded-lg border border-border p-3">
            <div className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1 size-4 shrink-0 align-middle accent-primary"
                aria-label={t("review.selectRow")}
                checked={selected.has(d.uid)}
                onChange={() => toggle(d.uid)}
              />
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => setEditingUid(d.uid)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{d.name ?? "—"}</span>
                  <Badge variant={d.confidence >= NEEDS_REVIEW_BELOW ? "success" : "warning"}>
                    {pct(d.confidence)}
                  </Badge>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                  <Badge variant="outline">{d.assetClass}</Badge>
                  <Badge variant="success">{d.action}</Badge>
                  <span className="text-muted-foreground">{dateOf(d)}</span>
                </div>
                <div className="mt-1 tabular text-sm text-muted-foreground">
                  {d.quantity} × {d.price}
                </div>
              </button>
              {drafts.length > 1 && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("remove")}
                  onClick={() => handleRemove(d.uid)}
                >
                  <Trash2 className="size-4" />
                </Button>
              )}
            </div>
          </div>
        ))}
        {view.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t("review.empty")}
          </p>
        )}
      </div>

      {/* Footer */}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={runDiscard} disabled={busy}>
          {pending === "discard" && <Loader2 className="size-4 animate-spin" />}
          {t("discard")}
        </Button>
        <Button
          onClick={() => runConfirm("confirm")}
          disabled={busy || drafts.length === 0}
        >
          {pending === "confirm" && <Loader2 className="size-4 animate-spin" />}
          {t("confirm")}
        </Button>
      </div>

      {/* Edit dialog */}
      <Dialog
        open={editingUid !== null}
        onOpenChange={(open) => {
          if (!open) setEditingUid(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("review.edit.title")}</DialogTitle>
          </DialogHeader>
          {editingDraft && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("fields.name")}>
                <Input
                  value={editingDraft.name ?? ""}
                  onChange={(e) =>
                    onUpdate(editingDraft.uid, { name: e.target.value })
                  }
                />
              </Field>
              <Field label={t("fields.executedAt")}>
                <Input
                  type="date"
                  value={editingDraft.executedAt.slice(0, 10)}
                  onChange={(e) =>
                    onUpdate(editingDraft.uid, { executedAt: e.target.value })
                  }
                />
              </Field>
              <Field label={t("fields.quantity")}>
                <Input
                  value={editingDraft.quantity}
                  onChange={(e) =>
                    onUpdate(editingDraft.uid, { quantity: e.target.value })
                  }
                />
              </Field>
              <Field label={t("fields.price")}>
                <Input
                  value={editingDraft.price}
                  onChange={(e) =>
                    onUpdate(editingDraft.uid, { price: e.target.value })
                  }
                />
              </Field>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setEditingUid(null)}>
              <X className="size-4" />
              {t("review.edit.done")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Map dialog: complete an unmapped event into a confirmable draft */}
      <Dialog
        open={mapping !== null}
        onOpenChange={(open) => {
          if (!open) {
            setMapping(null);
            setMapForm(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("review.issues.mapTitle")}</DialogTitle>
          </DialogHeader>
          {mapForm && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("review.columns.action")}>
                <Select
                  value={mapForm.action}
                  onChange={(e) => setMapForm({ ...mapForm, action: e.target.value })}
                >
                  {MAP_ACTIONS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("fields.name")}>
                <Input
                  value={mapForm.name ?? ""}
                  onChange={(e) => setMapForm({ ...mapForm, name: e.target.value })}
                />
              </Field>
              <Field label="ISIN">
                <Input
                  value={mapForm.isin ?? ""}
                  onChange={(e) => setMapForm({ ...mapForm, isin: e.target.value })}
                />
              </Field>
              <Field label={t("fields.executedAt")}>
                <Input
                  type="date"
                  value={mapForm.executedAt.slice(0, 10)}
                  onChange={(e) => setMapForm({ ...mapForm, executedAt: e.target.value })}
                />
              </Field>
              <Field label={t("fields.quantity")}>
                <Input
                  value={mapForm.quantity}
                  onChange={(e) => setMapForm({ ...mapForm, quantity: e.target.value })}
                />
              </Field>
              <Field label={t("fields.price")}>
                <Input
                  value={mapForm.price}
                  onChange={(e) => setMapForm({ ...mapForm, price: e.target.value })}
                />
              </Field>
            </div>
          )}
          <DialogFooter>
            <Button onClick={saveMap}>{t("review.issues.mapSave")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

// A labelled row of multi-select toggle chips (OR within the dimension). Empty = all.
function ChipGroup({
  label,
  values,
  selected,
  onToggle,
}: {
  label: string;
  values: string[];
  selected: Set<string>;
  onToggle: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted-foreground">{label}:</span>
      {values.map((v) => (
        <Button
          key={v}
          type="button"
          size="sm"
          variant={selected.has(v) ? "default" : "outline"}
          aria-pressed={selected.has(v)}
          className="h-7 px-2 text-xs"
          onClick={() => onToggle(v)}
        >
          {v}
        </Button>
      ))}
    </div>
  );
}
