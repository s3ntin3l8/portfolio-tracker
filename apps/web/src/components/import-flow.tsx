"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  ScanLine,
  CheckCircle2,
  Loader2,
  Upload,
  FileText,
  AlertCircle,
  ChevronDown,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { AccountMismatch, ImportIssue, LikelyDuplicate } from "@portfolio/api-client";
import { accountMismatchFromError } from "@portfolio/api-client";
import { cn } from "@/lib/utils";
import { importSkipReason, type ImportSkipReason } from "@/lib/import-errors";
import { ImportReview } from "@/components/import-review";
import { ContractReview } from "@/components/contract-review";

export type { ImportIssue } from "@portfolio/api-client";

// A draft transaction as it comes back from the API (executedAt is an ISO string).
export interface ImportDraft {
  assetClass: string;
  action: string;
  ticker?: string | null;
  isin?: string | null;
  wkn?: string | null;
  name?: string | null;
  quantity: string;
  unit: string;
  price: string;
  fees?: string | null;
  total?: string | null;
  currency: string;
  executedAt: string;
  confidence: number;
  /** Stable source id (TR event id) — set when a draft is mapped from an issue. */
  externalId?: string | null;
  /** Set when this draft economically matches a transaction already imported (#196);
   *  the review screen badges it and excludes it from the default "Confirm". */
  likelyDuplicate?: LikelyDuplicate | null;
}

// A financed gold contract as it comes back from the API (dates are ISO strings).
export interface ImportContractScheduleRow {
  n: number;
  dueDate: string;
  pokok: string;
  sewaModal: string;
  angsuran: string;
  sisaPokok: string;
}

export interface ImportContract {
  provider?: string | null;
  contractNo?: string | null;
  currency: string;
  grams: string;
  goldName?: string | null;
  purchasePrice: string;
  downPayment: string;
  adminFee: string;
  discount: string;
  principal: string;
  marginTotal: string;
  tenorMonths: number;
  monthlyInstallment: string;
  startDate: string;
  costBasisMode: "purchase_price" | "total_paid";
  schedule: ImportContractScheduleRow[];
  confidence: number;
}

export interface ImportResult {
  importId: string;
  drafts: ImportDraft[];
  contracts?: ImportContract[];
  errors: ImportIssue[];
  /** Server detected this exact file was already uploaded; existing draft returned. */
  alreadyExists?: boolean;
  /** Server detected this exact file was already uploaded and confirmed. */
  alreadyConfirmed?: boolean;
  /** Portfolio whose accountNumber matched the detected account number in the document, if any. */
  matchedPortfolioId?: string | null;
  /** Set when the file's account looks like it belongs to a different portfolio (#197). */
  accountMismatch?: AccountMismatch | null;
}

/**
 * A draft augmented with a stable client-side id and its source import id.
 * Selection, inline editing and the filter view all key off `uid` so they stay
 * correct as drafts are removed (which reindexes the array) or hidden by a filter.
 * Neither `uid` nor `importId` ever leaves the client — both are stripped before
 * the drafts are sent to `confirmImport`.
 */
export type ReviewDraft = ImportDraft & { uid: string; importId: string };

let uidCounter = 0;
export function withUid(draft: ImportDraft, importId: string): ReviewDraft {
  const uid =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `draft-${uidCounter++}`;
  return { ...draft, uid, importId };
}

export function stripUid(draft: ReviewDraft): ImportDraft {
  const copy: ImportDraft & { uid?: string; importId?: string } = { ...draft };
  delete copy.uid;
  delete copy.importId;
  return copy;
}

/** The slice of the API client the import flow needs (injectable for tests). */
export interface ImportClient {
  importScreenshot(
    file: File | Blob,
  ): Promise<ImportResult>;
  importCsv(
    content: string,
    format?: CsvFormat,
  ): Promise<ImportResult>;
  confirmImport(
    importId: string,
    drafts: ImportDraft[],
    contracts?: ImportContract[],
    portfolioId?: string,
    acknowledgeAccountMismatch?: boolean,
  ): Promise<{ confirmed: number }>;
}

type Step = "upload" | "parsing" | "review" | "done";
type Mode = "screenshot" | "csv";
type CsvFormat = "auto" | "generic" | "dkb" | "ibkr" | "coinbase";

export interface ImportTargetPortfolio {
  id: string;
  name: string;
}

const STEPS: Step[] = ["upload", "review", "done"];

const SAMPLE_DRAFT: ImportDraft = {
  assetClass: "gold",
  action: "buy",
  name: "Antam Gold (Tabungan Emas)",
  quantity: "5",
  unit: "grams",
  price: "1150000",
  fees: "0",
  currency: "IDR",
  executedAt: "2026-02-08",
  confidence: 0.94,
};

// Used when no real (authenticated) client is wired yet — keeps the page a live demo.
const demoClient: ImportClient = {
  importScreenshot: async () => ({
    importId: "demo",
    drafts: [SAMPLE_DRAFT],
    contracts: [],
    errors: [],
  }),
  importCsv: async () => ({
    importId: "demo",
    drafts: [SAMPLE_DRAFT],
    contracts: [],
    errors: [],
  }),
  confirmImport: async (_id, drafts, contracts) => ({
    confirmed: drafts.length + (contracts?.length ?? 0),
  }),
};

/** Type map for per-import-group portfolio selection (importId → portfolioId). */
type PortfolioByImportMap = Map<string, string>;

function fileToText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("file_read_error"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(file);
  });
}

/** A file that was skipped during the multi-file parse pass. */
interface SkippedFile {
  file: string;
  reason: ImportSkipReason;
}

/** Per-file parse status (shown during multi-file parsing). */
interface FileStatus {
  filename: string;
  status: "pending" | "parsing" | "done" | "failed";
}

/** Per-import parse issues keyed by importId. */
type IssueMap = Map<string, ImportIssue[]>;

/** Map from importId → filename heading for multi-file groups. */
type GroupMap = Map<string, string>;

export function ImportFlow({
  client = demoClient,
  portfolios = [{ id: "demo", name: "Demo" }],
  defaultPortfolioId,
  initialFile,
}: {
  client?: ImportClient;
  portfolios?: ImportTargetPortfolio[];
  defaultPortfolioId?: string;
  // A screenshot handed in from the Web Share Target — parsed automatically on mount,
  // reusing the same path as the file picker.
  initialFile?: File | null;
} = {}) {
  const t = useTranslations("Import");
  const [step, setStep] = useState<Step>("upload");
  const [mode, setMode] = useState<Mode>("screenshot");
  const [csvFormat, setCsvFormat] = useState<CsvFormat>("auto");
  // Per-group portfolio selection: importId → portfolioId. Populated in handleFiles,
  // updated by the per-group pickers on the review step.
  const [portfolioByImport, setPortfolioByImport] = useState<PortfolioByImportMap>(new Map());
  const [drafts, setDrafts] = useState<ReviewDraft[]>([]);
  const [contracts, setContracts] = useState<ImportContract[]>([]);
  // For the single-file/screenshot path: the one import id.
  // For multi-file CSV: the id of the import that carries contracts (if any).
  const [contractImportId, setContractImportId] = useState<string>("");
  // importId kept for backwards-compat in single-file path (points at contractImportId).
  const [importId, setImportId] = useState<string>("");
  // Multi-file groups: importId → filename.
  const [groups, setGroups] = useState<GroupMap>(new Map());
  // Per-group parse issues.
  const [issueMap, setIssueMap] = useState<IssueMap>(new Map());
  // Files skipped during the parse pass.
  const [skipped, setSkipped] = useState<SkippedFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Account-mismatch warning (#197) — set from the upload hint or a confirm 409. Shown as
  // a banner in the review step; "Import anyway" re-confirms with the acknowledge flag.
  const [accountMismatch, setAccountMismatch] = useState<AccountMismatch | null>(null);
  const [confirmedCount, setConfirmedCount] = useState(0);
  // Per-file status list (shown when parsing multiple files).
  const [fileStatuses, setFileStatuses] = useState<FileStatus[]>([]);
  // Drag-and-drop hover state for the dropzone.
  const [dragActive, setDragActive] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const activeIndex = step === "parsing" ? 0 : STEPS.indexOf(step);

  function errorMessage(err: unknown): string {
    const reason = importSkipReason(err);
    return t(`errors.${reason}`);
  }

  /**
   * Parse one or more files sequentially. For a single file the behaviour is
   * identical to the old `handleFile` path (same error messages, same state
   * transitions). For multiple CSV files we collect all results, skip bad ones
   * with a notice, and only abort to upload if everything failed.
   */
  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
    setDragActive(true);
  }

  function onDragLeave() {
    setDragActive(false);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragActive(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) void handleFiles(files);
  }

  async function handleFiles(files: File[]) {
    setError(null);
    setSkipped([]);
    setFileStatuses([]);
    setStep("parsing");

    // Default portfolio for all groups: first from the portfolios list.
    const defaultPid = defaultPortfolioId ?? portfolios[0]?.id ?? "";

    if (files.length === 1) {
      // ── Single-file path ──────────────────────────────────────────────────
      const file = files[0]!;
      try {
        const result =
          mode === "csv"
            ? await client.importCsv(await fileToText(file), csvFormat)
            : await client.importScreenshot(file);
        if (result.alreadyConfirmed) {
          setError(t("errors.alreadyConfirmed"));
          setStep("upload");
          return;
        }
        const resultContracts = result.contracts ?? [];
        if (result.drafts.length === 0 && resultContracts.length === 0) {
          setError(t("errors.noDrafts"));
          setStep("upload");
          return;
        }
        setImportId(result.importId);
        setContractImportId(result.importId);
        setDrafts(result.drafts.map((d) => withUid(d, result.importId)));
        setContracts(resultContracts);
        setGroups(new Map([[result.importId, file.name]]));
        setIssueMap(new Map([[result.importId, result.errors]]));
        setPortfolioByImport(new Map([[result.importId, result.matchedPortfolioId ?? defaultPid]]));
        setAccountMismatch(result.accountMismatch ?? null);
        setStep("review");
      } catch (err) {
        setError(errorMessage(err));
        setStep("upload");
      }
      return;
    }

    // ── Multi-file path ───────────────────────────────────────────────────
    const mergedDrafts: ReviewDraft[] = [];
    const newGroups: GroupMap = new Map();
    const newIssueMap: IssueMap = new Map();
    const newSkipped: SkippedFile[] = [];
    const newPortfolioByImport: PortfolioByImportMap = new Map();

    setFileStatuses(files.map((f) => ({ filename: f.name, status: "pending" })));

    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      setFileStatuses((prev) =>
        prev.map((s, idx) => (idx === i ? { ...s, status: "parsing" } : s)),
      );
      try {
        const result =
          mode === "csv"
            ? await client.importCsv(await fileToText(file), csvFormat)
            : await client.importScreenshot(file);

        if (result.alreadyConfirmed) {
          newSkipped.push({ file: file.name, reason: "alreadyConfirmed" });
          setFileStatuses((prev) =>
            prev.map((s, idx) => (idx === i ? { ...s, status: "failed" } : s)),
          );
          continue;
        }
        if (result.drafts.length === 0 && (result.contracts ?? []).length === 0) {
          newSkipped.push({ file: file.name, reason: "noDrafts" });
          setFileStatuses((prev) =>
            prev.map((s, idx) => (idx === i ? { ...s, status: "failed" } : s)),
          );
          continue;
        }
        setFileStatuses((prev) =>
          prev.map((s, idx) => (idx === i ? { ...s, status: "done" } : s)),
        );
        newGroups.set(result.importId, file.name);
        newIssueMap.set(result.importId, result.errors);
        newPortfolioByImport.set(result.importId, result.matchedPortfolioId ?? defaultPid);
        for (const d of result.drafts) {
          mergedDrafts.push(withUid(d, result.importId));
        }
        // Contracts: only the first file to return contracts "owns" them.
        // In practice CSV files don't produce contracts, but guard defensively.
        if ((result.contracts ?? []).length > 0 && !contractImportId) {
          setContractImportId(result.importId);
          setContracts(result.contracts ?? []);
        }
      } catch (err) {
        // Classify the error so multi-file failures show distinct per-file reasons
        // instead of all collapsing to the same "couldn't be read" message (was a bug).
        newSkipped.push({ file: file.name, reason: importSkipReason(err) });
        setFileStatuses((prev) =>
          prev.map((s, idx) => (idx === i ? { ...s, status: "failed" } : s)),
        );
      }
    }

    setSkipped(newSkipped);

    if (mergedDrafts.length === 0 && contracts.length === 0) {
      // Everything failed / was skipped — show a combined notice and stay on upload.
      if (newSkipped.length === 1) {
        const s = newSkipped[0]!;
        // Show the specific reason for the one file; multi-file mixed failures → generic.
        setError(t(`errors.${s.reason}`));
      } else {
        setError(t("errors.generic"));
      }
      setStep("upload");
      return;
    }

    setDrafts(mergedDrafts);
    setGroups(newGroups);
    setIssueMap(newIssueMap);
    setPortfolioByImport(newPortfolioByImport);
    // Use the first group's importId as the "primary" import id for back-compat.
    const firstId = newGroups.keys().next().value ?? "";
    setImportId(firstId);
    setStep("review");
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow re-selecting the same file(s)
    if (files.length > 0) void handleFiles(files);
  }

  // Auto-parse a screenshot shared into the app (Web Share Target). The guard ref keeps
  // it to a single run even though `handleFiles` is recreated each render.
  const sharedHandled = useRef(false);
  useEffect(() => {
    if (initialFile && !sharedHandled.current) {
      sharedHandled.current = true;
      void handleFiles([initialFile]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFile]);

  function updateDraft(uid: string, patch: Partial<ImportDraft>) {
    setDrafts((ds) => ds.map((d) => (d.uid === uid ? { ...d, ...patch } : d)));
  }

  function removeDraft(uid: string) {
    setDrafts((ds) => ds.filter((d) => d.uid !== uid));
  }

  function removeMany(uids: string[]) {
    const set = new Set(uids);
    setDrafts((ds) => ds.filter((d) => !set.has(d.uid)));
  }

  function updateContract(index: number, patch: Partial<ImportContract>) {
    setContracts((cs) => cs.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }

  /**
   * Confirm all drafts (or a passed subset) plus any gold contracts.
   *
   * Single-group: one `confirmImport` call (identical to the old path).
   * Multi-group: fan-out — one call per import id, contracts attached to their
   * owning import. Confirmed counts are summed.
   */
  async function confirm(uids?: string[], acknowledgeMismatch = false) {
    setError(null);
    setStep("parsing");
    try {
      // "Confirm all" (no uids) excludes drafts flagged as likely duplicates (#196) — the
      // user overrides by selecting them and using "Confirm selected" (an explicit subset).
      const subset =
        uids && uids.length
          ? drafts.filter((d) => uids.includes(d.uid))
          : drafts.filter((d) => !d.likelyDuplicate);

      if (groups.size <= 1) {
        // ── Single-import fast path ──────────────────────────────────────
        const { confirmed } = await client.confirmImport(
          importId,
          subset.map(stripUid),
          contracts,
          portfolioByImport.get(importId),
          acknowledgeMismatch,
        );
        setConfirmedCount(confirmed);
      } else {
        // ── Multi-import fan-out ─────────────────────────────────────────
        // Group the to-confirm drafts by their importId.
        const byImport = new Map<string, ReviewDraft[]>();
        for (const d of subset) {
          const list = byImport.get(d.importId) ?? [];
          list.push(d);
          byImport.set(d.importId, list);
        }
        // Ensure every group is represented (even if all its drafts were removed).
        for (const iid of groups.keys()) {
          if (!byImport.has(iid)) byImport.set(iid, []);
        }
        // Fire all confirms concurrently, passing the per-group portfolio selection.
        const results = await Promise.all(
          Array.from(byImport.entries()).map(([iid, ds]) =>
            client.confirmImport(
              iid,
              ds.map(stripUid),
              iid === contractImportId ? contracts : [],
              portfolioByImport.get(iid),
              acknowledgeMismatch,
            ),
          ),
        );
        setConfirmedCount(results.reduce((s, r) => s + r.confirmed, 0));
      }
      setAccountMismatch(null);
      setStep("done");
    } catch (err) {
      // A confirm into a portfolio whose account doesn't match (#197) comes back as a 409
      // with the verdict — surface the banner + "Import anyway" instead of a generic error.
      const mismatch = accountMismatchFromError(err);
      if (mismatch) {
        setAccountMismatch(mismatch);
      } else {
        setError(errorMessage(err));
      }
      setStep("review");
    }
  }

  function reset() {
    setDrafts([]);
    setContracts([]);
    setImportId("");
    setContractImportId("");
    setGroups(new Map());
    setIssueMap(new Map());
    setSkipped([]);
    setPortfolioByImport(new Map());
    setFileStatuses([]);
    setError(null);
    setAccountMismatch(null);
    setStep("upload");
  }

  // ── Derived: groups array for the unified ImportReview groups prop ──────────
  const isMultiGroup = groups.size > 1;
  const reviewGroups = isMultiGroup
    ? Array.from(groups.entries()).map(([iid, filename]) => ({ importId: iid, filename }))
    : undefined;

  return (
    <div
      className={cn(
        "mx-auto space-y-6",
        // The review step is a data table — give it the full page width; the other
        // steps stay comfortably narrow.
        step === "review" ? "max-w-6xl" : "max-w-xl",
      )}
    >
      {/* Stepper */}
      <ol className="flex items-center gap-2 text-sm">
        {STEPS.map((s, i) => (
          <li key={s} className="flex flex-1 items-center gap-2">
            <span
              className={cn(
                "flex size-6 items-center justify-center rounded-full text-xs font-medium",
                i <= activeIndex
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {i + 1}
            </span>
            <span
              className={cn(
                i <= activeIndex ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {t(`steps.${s}`)}
            </span>
            {i < STEPS.length - 1 && <span className="mx-1 h-px flex-1 bg-border" />}
          </li>
        ))}
      </ol>

      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <AlertCircle className="size-4 shrink-0" />
          {error}
        </div>
      )}

      {step === "upload" && (
        <div className="space-y-4">
          {/* Mode tabs */}
          <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
            <TabsList>
              <TabsTrigger value="screenshot">
                <ScanLine className="size-4" />
                {t("tabs.screenshot")}
              </TabsTrigger>
              <TabsTrigger value="csv">
                <FileText className="size-4" />
                {t("tabs.csv")}
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {/* CSV source format — auto-detected by default; override for edge cases */}
          {mode === "csv" && (
            <div className="flex items-center gap-2">
              <Label htmlFor="csv-format" className="text-sm text-muted-foreground">
                {t("csvFormat.label")}
              </Label>
              <Select
                id="csv-format"
                aria-label={t("csvFormat.label")}
                value={csvFormat}
                onChange={(e) => setCsvFormat(e.target.value as CsvFormat)}
                className="h-8 w-auto"
              >
                {(["auto", "generic", "dkb", "ibkr", "coinbase"] as const).map((fmt) => (
                  <option key={fmt} value={fmt}>
                    {t(`csvFormat.${fmt}`)}
                  </option>
                ))}
              </Select>
            </div>
          )}

          {/* Dropzone: real drag-and-drop + click-to-pick fallback */}
          <button
            type="button"
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onClick={() => fileRef.current?.click()}
            className={cn(
              "flex w-full cursor-pointer flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card/40 px-6 py-12 text-center transition-colors",
              dragActive
                ? "border-primary bg-primary/5"
                : "hover:border-primary/50 hover:bg-card",
            )}
          >
            <span className="flex size-12 items-center justify-center rounded-full bg-secondary">
              {mode === "csv" ? (
                <FileText className="size-6 text-primary" />
              ) : (
                <ScanLine className="size-6 text-primary" />
              )}
            </span>
            {dragActive ? (
              <span className="font-medium text-primary">{t("dropzone.dropHere")}</span>
            ) : (
              <>
                <span className="font-medium">{t("dropzone.title")}</span>
                <span className="text-sm text-muted-foreground">{t("dropzone.hint")}</span>
                <span className="mt-1 inline-flex items-center gap-2 text-sm text-primary">
                  <Upload className="size-4" />
                  {mode === "csv" ? t("dropzone.csvCta") : t("dropzone.cta")}
                </span>
              </>
            )}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept={mode === "csv" ? ".csv,text/csv" : "image/*,application/pdf"}
            multiple
            className="sr-only"
            aria-label={t("dropzone.cta")}
            onChange={onPick}
          />
        </div>
      )}

      {step === "parsing" && (
        <Card>
          <CardContent className="py-8">
            {fileStatuses.length > 1 ? (
              <ul className="space-y-2">
                {fileStatuses.map((fs) => (
                  <li key={fs.filename} className="flex items-center gap-3 text-sm">
                    {fs.status === "parsing" && (
                      <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
                    )}
                    {fs.status === "done" && (
                      <CheckCircle2 className="size-4 shrink-0 text-success" />
                    )}
                    {fs.status === "failed" && (
                      <AlertCircle className="size-4 shrink-0 text-destructive" />
                    )}
                    {fs.status === "pending" && (
                      <span className="size-4 shrink-0 rounded-full border border-border" />
                    )}
                    <span
                      className={cn(
                        "truncate",
                        fs.status === "failed" && "text-muted-foreground line-through",
                        fs.status === "pending" && "text-muted-foreground",
                      )}
                    >
                      {fs.filename}
                    </span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {t(`fileStatus.${fs.status}`)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="flex flex-col items-center gap-3">
                <Loader2 className="size-6 animate-spin text-primary" />
                <p className="text-sm text-muted-foreground">{t("parsing")}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {step === "review" && (
        <div className="space-y-6">
          {/* Account-mismatch warning (#197): the file looks like it belongs elsewhere. */}
          {accountMismatch && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm text-warning"
            >
              <AlertCircle className="size-4 shrink-0" />
              <span className="flex-1">
                {accountMismatch.kind === "other_portfolio"
                  ? t("accountMismatch.otherPortfolio", {
                      portfolio: accountMismatch.matchedName ?? "",
                      account: accountMismatch.detected,
                    })
                  : t("accountMismatch.noMatch", { account: accountMismatch.detected })}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void confirm(undefined, true)}
              >
                {t("accountMismatch.importAnyway")}
              </Button>
            </div>
          )}

          {/* Collapsible skip-notice banner — collapsed by default so it doesn't dominate */}
          {skipped.length > 0 && (
            <details className="rounded-md border border-border bg-muted/40 text-sm text-muted-foreground">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
                <AlertCircle className="size-3.5 shrink-0" />
                <span className="flex-1">{t("errorBanner.summary", { count: skipped.length })}</span>
                <ChevronDown className="size-3.5 shrink-0 transition-transform [[open]_&]:rotate-180" />
              </summary>
              <ul className="border-t border-border px-3 pb-2.5 pt-2 space-y-1">
                {skipped.map((s) => (
                  <li key={s.file}>{t(`skipped.${s.reason}`, { file: s.file })}</li>
                ))}
              </ul>
            </details>
          )}

          {contracts.length > 0 && (
            <ContractReview
              contracts={contracts}
              onUpdate={updateContract}
              // When there are also flat drafts, the draft table owns the confirm
              // button; otherwise the contract card drives confirm/discard.
              onConfirm={drafts.length === 0 ? () => confirm() : undefined}
              onDiscard={drafts.length === 0 ? reset : undefined}
            />
          )}

          {drafts.length > 0 && !isMultiGroup && (
            // ── Single-group: portfolio picker above + unified ImportReview footer ──
            <>
              {portfolios.length > 1 && (
                <div className="space-y-1.5">
                  <Label htmlFor="import-portfolio">{t("targetPortfolio")}</Label>
                  <Select
                    id="import-portfolio"
                    value={portfolioByImport.get(importId) ?? portfolios[0]?.id ?? ""}
                    onChange={(e) =>
                      setPortfolioByImport(new Map([[importId, e.target.value]]))
                    }
                  >
                    {portfolios.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
              <ImportReview
                drafts={drafts}
                onUpdate={updateDraft}
                onRemove={removeDraft}
                onRemoveMany={removeMany}
                onConfirm={confirm}
                onDiscard={reset}
                issues={issueMap.get(importId) ?? []}
              />
            </>
          )}

          {drafts.length > 0 && isMultiGroup && (
            // ── Multi-group: single unified ImportReview with group-header rows ──
            <ImportReview
              drafts={drafts}
              onUpdate={updateDraft}
              onRemove={removeDraft}
              onRemoveMany={removeMany}
              onConfirm={confirm}
              onDiscard={reset}
              groups={reviewGroups}
              portfolios={portfolios.length > 1 ? portfolios : undefined}
              portfolioByImport={portfolioByImport}
              onPortfolioChange={(iid, pid) =>
                setPortfolioByImport((m) => new Map(m).set(iid, pid))
              }
              issuesByImport={issueMap}
            />
          )}
        </div>
      )}

      {step === "done" && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <CheckCircle2 className="size-8 text-success" />
            <p className="font-medium">{t("done.title")}</p>
            <p className="text-sm text-muted-foreground">
              {t("done.hint", { count: confirmedCount })}
            </p>
            <Button variant="outline" className="mt-2" onClick={reset}>
              {t("done.again")}
            </Button>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/import">{t("done.history")}</Link>
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
