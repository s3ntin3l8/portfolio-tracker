"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  CheckCircle2,
  Loader2,
  Upload,
  AlertCircle,
  ChevronDown,
} from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useRouter } from "@/i18n/navigation";
import { Label } from "@/components/ui/label";
import { PortfolioPicker } from "@/components/portfolio-picker";
import type {
  AccountMismatch,
  ImportIssue,
  LikelyDuplicate,
} from "@portfolio/api-client";
import { cn } from "@/lib/utils";
import { importSkipReason, type ImportSkipReason } from "@/lib/import-errors";
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
  tax?: string | null;
  total?: string | null;
  currency: string;
  executedAt: string;
  confidence: number;
  /** Stable source id (TR event id / AUSFÜHRUNG) — set by TR/DKB parsers. */
  externalId?: string | null;
  /** TR AUFTRAG (order-level grouping key). */
  orderRef?: string | null;
  /** Per-component tax breakdown from settlement PDFs (null for CSV/timeline drafts). */
  taxComponents?: Record<string, string> | null;
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
  /** Portfolio to pre-select in the confirm step (account match, else the sole portfolio). */
  suggestedPortfolioId?: string | null;
  /** Set when the file's account looks like it belongs to a different portfolio (#197). */
  accountMismatch?: AccountMismatch | null;
  /** A deterministic import with a matched portfolio was written straight into the
   *  transactions table as draft rows (no review step). `drafts` is then empty/absent. */
  materialized?: boolean;
  /** Number of draft transactions materialized (Phase 2). */
  materializedCount?: number;
}

/**
 * A draft augmented with a stable client-side id and its source import id.
 * Selection, inline editing and the filter view all key off `uid` so they stay
 * correct as drafts are removed (which reindexes the array) or hidden by a filter.
 * Neither `uid` nor `importId` ever leaves the client — both are stripped before
 * the drafts are sent to `confirmImport`.
 */
// `_serverIdx` records the position in the server's stored draft list at upload
// time — used to stably map preview-endpoint annotations (positional) back to
// the correct local draft even after the user removes some rows.
export type ReviewDraft = ImportDraft & { uid: string; importId: string; _serverIdx: number };

let uidCounter = 0;
export function withUid(draft: ImportDraft, importId: string, serverIdx: number): ReviewDraft {
  const uid =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `draft-${uidCounter++}`;
  return { ...draft, uid, importId, _serverIdx: serverIdx };
}

export function stripUid(draft: ReviewDraft): ImportDraft {
  const copy: ImportDraft & { uid?: string; importId?: string; _serverIdx?: number } = { ...draft };
  delete copy.uid;
  delete copy.importId;
  delete copy._serverIdx;
  return copy;
}

/** The slice of the API client the import flow needs (injectable for tests). */
export interface ImportClient {
  importScreenshot(
    file: File | Blob,
    force?: boolean,
  ): Promise<ImportResult>;
  importCsv(
    content: string,
    format?: CsvFormat,
    force?: boolean,
  ): Promise<ImportResult>;
  confirmImport(
    importId: string,
    drafts: ImportDraft[],
    contracts?: ImportContract[],
    portfolioId?: string,
    acknowledgeAccountMismatch?: boolean,
    acknowledgeDuplicates?: boolean,
  ): Promise<{ confirmed: number; excludedCashMovements?: number }>;
  materializeImport(
    importId: string,
    portfolioId: string,
    acknowledgeAccountMismatch?: boolean,
  ): Promise<{ materializedCount: number; excludedCashMovements: number }>;
}

/** One portfolio target for a backgrounded materialize (one per import group). */
export interface MaterializeUnit {
  importId: string;
  portfolioId: string;
}

/**
 * A plain-data snapshot of a confirmed import, handed to `ImportTasksProvider.run()` so
 * the write can finish in the background after the modal closes. Carries everything the
 * provider needs — nothing references `ImportFlow`'s component state after handoff.
 */
export interface ImportTask {
  kind: "materialize" | "confirm";
  /** Human label for the toast — a filename (single) or "N files" (multi). */
  label: string;
  /** Pre-set `true` only when launched from the parse-time account-mismatch banner. */
  acknowledge: boolean;
  /** Drafts submitted (the "Y" in "imported X of Y") — set for materialize, not contracts. */
  expectedCount?: number;
  // kind === "materialize" (the common securities path):
  units?: MaterializeUnit[];
  // kind === "confirm" (gold installment contracts):
  importId?: string;
  drafts?: ImportDraft[];
  contracts?: ImportContract[];
  portfolioId?: string;
}

type Step = "upload" | "parsing" | "review";
type CsvFormat = "auto" | "generic" | "dkb" | "ibkr" | "coinbase";

export interface ImportTargetPortfolio {
  id: string;
  name: string;
  brokerage: string | null;
  accountHolder: string | null;
}

const STEPS: Step[] = ["upload", "review"];

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
  materializeImport: async () => ({ materializedCount: 0, excludedCashMovements: 0 }),
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

/**
 * Detect CSV files by MIME type or extension. Browsers are inconsistent about
 * reporting `text/csv` (some report empty string or `application/vnd.ms-excel`),
 * so the filename extension is the authoritative fallback.
 */
function isCsvFile(file: File): boolean {
  return (
    file.type === "text/csv" ||
    file.type === "application/vnd.ms-excel" ||
    file.name.toLowerCase().endsWith(".csv")
  );
}

/** A file that was skipped during the multi-file parse pass. */
interface SkippedFile {
  file: string;
  reason: ImportSkipReason;
  /** Original File object — present only for alreadyConfirmed so the user can force-reimport it. */
  originalFile?: File;
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
  portfolios = [{ id: "demo", name: "Demo", brokerage: null, accountHolder: null }],
  defaultPortfolioId,
  initialFile,
  onSubmit,
  onClose,
}: {
  client?: ImportClient;
  portfolios?: ImportTargetPortfolio[];
  defaultPortfolioId?: string;
  // A screenshot handed in from the Web Share Target — parsed automatically on mount,
  // reusing the same path as the file picker.
  initialFile?: File | null;
  // Hand the confirmed import off to the shell-level provider that finishes the write in
  // the background; called just before `onClose`. No-op default keeps the demo path alive.
  onSubmit?: (task: ImportTask) => void;
  // Close the surrounding modal — invoked the moment an import is committed or completes.
  onClose?: () => void;
} = {}) {
  const t = useTranslations("Import");
  const router = useRouter();
  const [step, setStep] = useState<Step>("upload");
  // Per-group portfolio selection: importId → portfolioId. Populated in handleFiles,
  // updated by the per-group pickers on the review step.
  const [portfolioByImport, setPortfolioByImport] = useState<PortfolioByImportMap>(new Map());
  // importIds whose target was pre-selected from the file's detected account number — drives
  // the "pre-selected from the account number" note on the confirm-portfolio step.
  const [matchedImports, setMatchedImports] = useState<Set<string>>(new Set());
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
  // A single file the server rejected as an already-confirmed re-upload. Kept so the user
  // can consciously re-import it (e.g. they deleted some of the original transactions). (#229)
  const [reImportFile, setReImportFile] = useState<File | null>(null);
  // Account-mismatch warning (#197) — set from the upload hint or a confirm 409. Shown as
  // a banner in the review step; "Import anyway" re-confirms with the acknowledge flag.
  const [accountMismatch, setAccountMismatch] = useState<AccountMismatch | null>(null);
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

  /** A human label for the in-flight import toast: the filename, or "N files" for groups. */
  function taskLabel(): string {
    const names = Array.from(groups.values());
    if (names.length === 1) return names[0] ?? "";
    return t("toast.filesLabel", { count: names.length });
  }

  /**
   * Phase-2 success notice: the server already wrote these rows during the synchronous
   * parse (no review step), so there's nothing to background — just refresh route data
   * and drop a success toast with a "View" action.
   */
  function notifyMaterialized(count: number) {
    router.refresh();
    toast.success(t("toast.success", { count }), {
      action: {
        label: t("toast.viewTransactions"),
        onClick: () => router.push("/transactions"),
      },
    });
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

  async function handleFiles(files: File[], force = false) {
    setError(null);
    setReImportFile(null);
    setSkipped([]);
    setFileStatuses([]);
    setStep("parsing");

    // Default portfolio for all groups: first from the portfolios list.
    const defaultPid = defaultPortfolioId ?? portfolios[0]?.id ?? "";

    if (files.length === 1) {
      // ── Single-file path ──────────────────────────────────────────────────
      const file = files[0]!;
      try {
        const result = isCsvFile(file)
          ? await client.importCsv(await fileToText(file), "auto", force)
          : await client.importScreenshot(file, force);
        if (result.alreadyConfirmed) {
          setError(t("errors.alreadyConfirmed"));
          // Offer a manual override: the file was already imported, but the user may have
          // deleted some of those transactions and want them back (#229). A re-import with
          // `force` re-creates the drafts; survivors are re-flagged at confirm time.
          setReImportFile(file);
          setStep("upload");
          return;
        }
        // Phase 2: a deterministic import with a matched portfolio was written straight into
        // the transactions table as draft rows — skip review, close + toast.
        if (result.materialized) {
          notifyMaterialized(result.materializedCount ?? 0);
          onClose?.();
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
        setDrafts(result.drafts.map((d, i) => withUid(d, result.importId, i)));
        setContracts(resultContracts);
        setGroups(new Map([[result.importId, file.name]]));
        setIssueMap(new Map([[result.importId, result.errors]]));
        setPortfolioByImport(
          new Map([[result.importId, result.suggestedPortfolioId ?? defaultPid]]),
        );
        setMatchedImports(
          result.matchedPortfolioId ? new Set([result.importId]) : new Set(),
        );
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
    const newMatchedImports = new Set<string>();
    let materializedTotal = 0;

    setFileStatuses(files.map((f) => ({ filename: f.name, status: "pending" })));

    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      setFileStatuses((prev) =>
        prev.map((s, idx) => (idx === i ? { ...s, status: "parsing" } : s)),
      );
      try {
        const result = isCsvFile(file)
          ? await client.importCsv(await fileToText(file), "auto", force)
          : await client.importScreenshot(file, force);

        if (result.alreadyConfirmed) {
          // Store the original File so the per-file "Re-import anyway" button can force-reimport it.
          newSkipped.push({ file: file.name, reason: "alreadyConfirmed", originalFile: file });
          setFileStatuses((prev) =>
            prev.map((s, idx) => (idx === i ? { ...s, status: "failed" } : s)),
          );
          continue;
        }
        // Phase 2: this file's drafts went straight into the table (no review needed).
        if (result.materialized) {
          materializedTotal += result.materializedCount ?? 0;
          setFileStatuses((prev) =>
            prev.map((s, idx) => (idx === i ? { ...s, status: "done" } : s)),
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
        newPortfolioByImport.set(result.importId, result.suggestedPortfolioId ?? defaultPid);
        if (result.matchedPortfolioId) newMatchedImports.add(result.importId);
        for (let i = 0; i < result.drafts.length; i++) {
          mergedDrafts.push(withUid(result.drafts[i]!, result.importId, i));
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

    // If some files materialized straight into the table and nothing remains to review,
    // close + toast (Phase 2). If there are also drafts to review, fall through to the
    // review screen for those — the materialized rows already landed.
    if (mergedDrafts.length === 0 && contracts.length === 0 && materializedTotal > 0) {
      notifyMaterialized(materializedTotal);
      onClose?.();
      return;
    }

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
    setMatchedImports(newMatchedImports);
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

  function updateContract(index: number, patch: Partial<ImportContract>) {
    setContracts((cs) => cs.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }

  /**
   * Confirm gold installment contracts — the remaining confirm path (pure-securities uploads
   * go through the materialize step). Hands the write off to the background provider, then
   * closes the modal. Any flat drafts that arrived alongside the contracts in the same parse
   * are written too (a single document carrying both is rare but must not silently drop the
   * securities). The parse-time mismatch banner's "Import anyway" passes `acknowledge=true`.
   */
  function submitConfirm(acknowledge = false) {
    onSubmit?.({
      kind: "confirm",
      label: taskLabel(),
      acknowledge,
      importId,
      drafts: drafts.map(stripUid),
      contracts,
      portfolioId: portfolioByImport.get(importId),
    });
    onClose?.();
  }

  /**
   * Confirm-portfolio step (drafts, non-contract): validate every group has a target, then
   * hand the per-group writes off to the background provider and close the modal. The
   * provider materializes each import as `status='draft'` rows (cross-source duplicates
   * collapse server-side) and drives the status toast — including a 409 account-mismatch
   * "Import anyway" retry, since the modal is gone by the time the server responds.
   */
  function submitMaterialize(acknowledge = false) {
    setError(null);
    const units: MaterializeUnit[] = [];
    for (const iid of groups.keys()) {
      const pid = portfolioByImport.get(iid);
      if (!pid) {
        setError(t("errors.portfolioRequired"));
        return;
      }
      units.push({ importId: iid, portfolioId: pid });
    }
    onSubmit?.({
      kind: "materialize",
      label: taskLabel(),
      acknowledge,
      expectedCount: drafts.length,
      units,
    });
    onClose?.();
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
    setMatchedImports(new Set());
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
          className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <AlertCircle className="size-4 shrink-0" />
          <span>{error}</span>
          {reImportFile && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="ml-auto"
              onClick={() => {
                const f = reImportFile;
                setReImportFile(null);
                void handleFiles([f], true);
              }}
            >
              {t("reImportAnyway")}
            </Button>
          )}
        </div>
      )}

      {step === "upload" && (
        <div className="space-y-4">
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
              <Upload className="size-6 text-primary" />
            </span>
            {dragActive ? (
              <span className="font-medium text-primary">{t("dropzone.dropHere")}</span>
            ) : (
              <>
                <span className="font-medium">{t("dropzone.title")}</span>
                <span className="text-sm text-muted-foreground">{t("dropzone.hint")}</span>
                <span className="mt-1 inline-flex items-center gap-2 text-sm text-primary">
                  <Upload className="size-4" />
                  {t("dropzone.cta")}
                </span>
              </>
            )}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv,image/*,application/pdf"
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
                onClick={() =>
                  drafts.length > 0 && contracts.length === 0
                    ? submitMaterialize(true)
                    : submitConfirm(true)
                }
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
              <ul className="border-t border-border px-3 pb-2.5 pt-2 space-y-1.5">
                {skipped.map((s) => (
                  <li key={s.file} className="flex flex-wrap items-center gap-2">
                    <span className="flex-1">{t(`skipped.${s.reason}`, { file: s.file })}</span>
                    {s.reason === "alreadyConfirmed" && s.originalFile && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="shrink-0"
                        onClick={() => {
                          const f = s.originalFile!;
                          // Remove this entry from the skipped list before re-importing.
                          setSkipped((prev) => prev.filter((x) => x.file !== s.file));
                          void handleFiles([f], true);
                        }}
                      >
                        {t("reImportAnyway")}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {contracts.length > 0 && (
            <ContractReview
              contracts={contracts}
              onUpdate={updateContract}
              // The contract card drives confirm/discard. submitConfirm() also writes any flat
              // drafts that arrived in the same parse, so it owns the whole import.
              onConfirm={() => submitConfirm()}
              onDiscard={reset}
            />
          )}

          {drafts.length > 0 && contracts.length === 0 && (
            // ── Confirm-portfolio step: pick the target portfolio (pre-selected from the
            //    file's detected account), then materialize the staged drafts into the table.
            <div className="space-y-4">
              <h2 className="text-lg font-semibold">{t("confirmPortfolio.title")}</h2>
              {(reviewGroups ?? [{ importId, filename: groups.get(importId) ?? "" }]).map(
                ({ importId: iid, filename }) => {
                  const count = drafts.filter((d) => d.importId === iid).length;
                  const matched = matchedImports.has(iid);
                  const issues = issueMap.get(iid) ?? [];
                  return (
                    <div
                      key={iid}
                      className="space-y-3 rounded-lg border border-border bg-card/40 p-4"
                    >
                      {isMultiGroup && filename && (
                        <p className="text-sm font-medium">{filename}</p>
                      )}
                      <p className="text-sm text-muted-foreground">
                        {t("confirmPortfolio.summary", { count })}
                      </p>
                      {portfolios.length > 1 && (
                        <div className="space-y-1.5">
                          <Label>{t("targetPortfolio")}</Label>
                          <PortfolioPicker
                            portfolios={portfolios}
                            value={portfolioByImport.get(iid) ?? portfolios[0]?.id ?? ""}
                            onChange={(pid) =>
                              setPortfolioByImport((m) => new Map(m).set(iid, pid))
                            }
                            ariaLabel={t("targetPortfolio")}
                            triggerClassName="w-full"
                          />
                        </div>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {matched
                          ? t("confirmPortfolio.matched")
                          : portfolios.length === 1
                            ? t("confirmPortfolio.onlyPortfolio")
                            : t("confirmPortfolio.choose")}
                      </p>
                      {issues.length > 0 && (
                        <p className="text-xs text-warning">
                          {t("review.issues.attention", { count: issues.length })}
                        </p>
                      )}
                    </div>
                  );
                },
              )}
              <div className="flex items-center gap-2">
                <Button onClick={() => submitMaterialize()}>
                  {t("confirmPortfolio.confirm")}
                </Button>
                <Button variant="ghost" onClick={reset}>
                  {t("confirmPortfolio.discard")}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

    </div>
  );
}
