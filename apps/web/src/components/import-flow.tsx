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
import {
  classifyImportError,
  importErrorDetail,
  type ImportSkipReason,
} from "@/lib/import-errors";
import { mapPool, IMPORT_CONCURRENCY } from "@/lib/promise-pool";
import { ContractReview } from "@/components/contract-review";
import { ImportFilesTable } from "@/components/import-files-table";

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

/** A correlation id shared by every file in one multi-file upload step, so the import
 *  history can group and bulk-act on the batch as a unit. Undefined when randomUUID is
 *  unavailable (the server simply stores null → ungrouped). */
function newBatchId(): string | undefined {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : undefined;
}

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
    batchId?: string,
  ): Promise<ImportResult>;
  importCsv(
    content: string,
    format?: CsvFormat,
    force?: boolean,
    batchId?: string,
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
  /** Read-only pre-flight: which of these (importId, portfolioId) units conflict on account? */
  checkAccounts(
    units: MaterializeUnit[],
  ): Promise<{ mismatches: ({ importId: string } & AccountMismatch)[] }>;
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
  checkAccounts: async () => ({ mismatches: [] }),
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
  /** Provider name for rateLimited / providerAuth / providerDown reasons (e.g. "claude"). */
  provider?: string;
  /** Original File object — present only for alreadyConfirmed so the user can force-reimport it. */
  originalFile?: File;
}

/**
 * Outcome of parsing one file in the multi-file pass. Returned by the bounded pool and assembled
 * back into groups/drafts in *input order* afterwards (the pool runs files concurrently, so they
 * complete out of order — order is reconstructed so the confirm table is deterministic).
 */
type ParseOutcome =
  | { status: "ok"; importId: string; filename: string; result: ImportResult }
  | { status: "materialized"; count: number }
  | { status: "skipped"; skip: SkippedFile };

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
  // The "primary" import id: the single-file/screenshot import, or the first group in a
  // multi-file batch. Drives the gold-contract confirm (`submitConfirm`).
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
  // The import the live mismatch verdict belongs to — lets the banner name the file in a
  // multi-group upload (where one of several files is the one that doesn't match).
  const [mismatchImportId, setMismatchImportId] = useState<string>("");
  // True while the confirm-time account-mismatch pre-flight is in flight — disables the
  // Confirm button so the async round-trip can't be double-submitted.
  const [submitting, setSubmitting] = useState(false);
  // Per-file status list (shown when parsing multiple files).
  const [fileStatuses, setFileStatuses] = useState<FileStatus[]>([]);
  // Drag-and-drop hover state for the dropzone.
  const [dragActive, setDragActive] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const activeIndex = step === "parsing" ? 0 : STEPS.indexOf(step);

  function errorMessage(err: unknown): string {
    const info = classifyImportError(err);
    // On the opaque `generic` fallthrough, surface the real HTTP status + code so the user
    // isn't left with a bare "something went wrong" (covers 500 / network / unmapped failures).
    const detail = info.reason === "generic" ? importErrorDetail(info) : null;
    return detail
      ? t("errors.genericDetailed", { detail })
      : t(`errors.${info.reason}`, { provider: info.provider ?? "" });
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
    setFileStatuses(files.map((f) => ({ filename: f.name, status: "pending" })));

    const setStatus = (i: number, status: FileStatus["status"]) =>
      setFileStatuses((prev) => prev.map((s, idx) => (idx === i ? { ...s, status } : s)));

    // One batch id for the whole upload step → every file's import row shares it, so the
    // history can group and bulk-delete the batch as a unit.
    const batchId = newBatchId();

    // Parse one file → a tagged outcome. Catches its own errors so a single bad file never
    // rejects the pool; the per-file `fileStatuses` entry is updated live as it runs.
    async function parseOne(file: File, i: number): Promise<ParseOutcome> {
      setStatus(i, "parsing");
      try {
        const result = isCsvFile(file)
          ? await client.importCsv(await fileToText(file), "auto", force, batchId)
          : await client.importScreenshot(file, force, batchId);
        if (result.alreadyConfirmed) {
          setStatus(i, "failed");
          // Keep the original File so the per-file "Re-import anyway" button can force-reimport it.
          return {
            status: "skipped",
            skip: { file: file.name, reason: "alreadyConfirmed", originalFile: file },
          };
        }
        // Phase 2: this file's drafts went straight into the table (no review needed).
        if (result.materialized) {
          setStatus(i, "done");
          return { status: "materialized", count: result.materializedCount ?? 0 };
        }
        if (result.drafts.length === 0 && (result.contracts ?? []).length === 0) {
          setStatus(i, "failed");
          return { status: "skipped", skip: { file: file.name, reason: "noDrafts" } };
        }
        setStatus(i, "done");
        return { status: "ok", importId: result.importId, filename: file.name, result };
      } catch (err) {
        // Classify so multi-file failures show distinct per-file reasons instead of all
        // collapsing to the same "couldn't be read" message.
        const info = classifyImportError(err);
        setStatus(i, "failed");
        return {
          status: "skipped",
          skip: { file: file.name, reason: info.reason, provider: info.provider },
        };
      }
    }

    // Parse a few files at a time (bounded) — results come back in input order.
    const outcomes = await mapPool(files, IMPORT_CONCURRENCY, parseOne);

    // Assemble groups/drafts in input order so the confirm table is deterministic.
    const mergedDrafts: ReviewDraft[] = [];
    const newGroups: GroupMap = new Map();
    const newIssueMap: IssueMap = new Map();
    const newSkipped: SkippedFile[] = [];
    const newPortfolioByImport: PortfolioByImportMap = new Map();
    const newMatchedImports = new Set<string>();
    let materializedTotal = 0;
    let pickedContractImportId = "";
    let pickedContracts: ImportContract[] = [];

    for (const o of outcomes) {
      if (o.status === "materialized") {
        materializedTotal += o.count;
        continue;
      }
      if (o.status === "skipped") {
        newSkipped.push(o.skip);
        continue;
      }
      const { importId: iid, filename, result } = o;
      newGroups.set(iid, filename);
      newIssueMap.set(iid, result.errors);
      newPortfolioByImport.set(iid, result.suggestedPortfolioId ?? defaultPid);
      if (result.matchedPortfolioId) newMatchedImports.add(iid);
      for (let j = 0; j < result.drafts.length; j++) {
        mergedDrafts.push(withUid(result.drafts[j]!, iid, j));
      }
      // Contracts: the first file (in input order) to return contracts "owns" them.
      // In practice CSV files don't produce contracts, but guard defensively.
      if ((result.contracts ?? []).length > 0 && !pickedContractImportId) {
        pickedContractImportId = iid;
        pickedContracts = result.contracts ?? [];
      }
    }

    setSkipped(newSkipped);

    // If some files materialized straight into the table and nothing remains to review,
    // close + toast (Phase 2). If there are also drafts to review, fall through to the
    // review screen for those — the materialized rows already landed.
    if (mergedDrafts.length === 0 && pickedContracts.length === 0 && materializedTotal > 0) {
      notifyMaterialized(materializedTotal);
      onClose?.();
      return;
    }

    if (mergedDrafts.length === 0 && pickedContracts.length === 0) {
      // Everything failed / was skipped — show a combined notice and stay on upload.
      if (newSkipped.length === 1) {
        const s = newSkipped[0]!;
        // Show the specific reason for the one file; multi-file mixed failures → generic.
        setError(t(`errors.${s.reason}`, { provider: s.provider ?? "" }));
      } else {
        setError(t("errors.generic"));
      }
      setStep("upload");
      return;
    }

    if (pickedContracts.length > 0) {
      setContracts(pickedContracts);
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
   * Confirm-time account-mismatch pre-flight (#197): ask the server whether the file's detected
   * account conflicts with the portfolio the user *actually* selected, for the units about to be
   * written. Returns the first conflicting verdict (with its importId) so the caller can keep the
   * modal open and surface the warning in place — instead of letting the background write 409 and
   * surface it as a post-close toast. A failed check returns null: never block the import on the
   * pre-flight, since the real write guard still re-checks and drives its own error toast.
   */
  async function preflightAccounts(
    units: MaterializeUnit[],
  ): Promise<({ importId: string } & AccountMismatch) | null> {
    try {
      const { mismatches } = await client.checkAccounts(units);
      return mismatches[0] ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Confirm gold installment contracts — the remaining confirm path (pure-securities uploads
   * go through the materialize step). Pre-flights the account-mismatch check, then hands the
   * write off to the background provider and closes the modal. Any flat drafts that arrived
   * alongside the contracts in the same parse are written too (a single document carrying both
   * is rare but must not silently drop the securities). The banner's "Import anyway" passes
   * `acknowledge=true`, which skips the pre-flight.
   */
  async function submitConfirm(acknowledge = false) {
    const portfolioId = portfolioByImport.get(importId);
    if (!acknowledge && portfolioId) {
      setSubmitting(true);
      const mismatch = await preflightAccounts([{ importId, portfolioId }]);
      setSubmitting(false);
      if (mismatch) {
        setAccountMismatch(mismatch);
        setMismatchImportId(mismatch.importId);
        return;
      }
    }
    onSubmit?.({
      kind: "confirm",
      label: taskLabel(),
      acknowledge,
      importId,
      drafts: drafts.map(stripUid),
      contracts,
      portfolioId,
    });
    onClose?.();
  }

  /**
   * Confirm-portfolio step (drafts, non-contract): validate every group has a target, pre-flight
   * the account-mismatch check against the *selected* portfolios, then hand the per-group writes
   * off to the background provider and close the modal. A mismatch keeps the modal open and shows
   * the warning banner; "Import anyway" re-runs with `acknowledge=true`. The provider still owns
   * the actual write (cross-source duplicates collapse server-side) and its status toast — and
   * keeps the 409 account-mismatch fallback for the race where a portfolio changes after the
   * pre-flight.
   */
  async function submitMaterialize(acknowledge = false) {
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
    if (!acknowledge) {
      setSubmitting(true);
      const mismatch = await preflightAccounts(units);
      setSubmitting(false);
      if (mismatch) {
        setAccountMismatch(mismatch);
        setMismatchImportId(mismatch.importId);
        return;
      }
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
    setGroups(new Map());
    setIssueMap(new Map());
    setSkipped([]);
    setPortfolioByImport(new Map());
    setMatchedImports(new Set());
    setFileStatuses([]);
    setError(null);
    setAccountMismatch(null);
    setMismatchImportId("");
    setSubmitting(false);
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
                {/* Name the file in a multi-group upload so the user knows which one mismatched. */}
                {groups.size > 1 && groups.get(mismatchImportId) && (
                  <span className="font-medium">{groups.get(mismatchImportId)}: </span>
                )}
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
                disabled={submitting}
                onClick={() =>
                  drafts.length > 0 && contracts.length === 0
                    ? void submitMaterialize(true)
                    : void submitConfirm(true)
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
                    <span className="flex-1">
                      {t(`skipped.${s.reason}`, { file: s.file, provider: s.provider ?? "" })}
                    </span>
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
              {isMultiGroup ? (
                // Many files → one compact row each, with checkbox bulk-assign.
                <ImportFilesTable
                  groups={reviewGroups!}
                  portfolios={portfolios}
                  portfolioByImport={portfolioByImport}
                  matchedImports={matchedImports}
                  countByImport={(iid) => drafts.filter((d) => d.importId === iid).length}
                  issueCountByImport={(iid) => (issueMap.get(iid) ?? []).length}
                  onPortfolioChange={(iid, pid) =>
                    setPortfolioByImport((m) => new Map(m).set(iid, pid))
                  }
                />
              ) : (
                // Single file → the familiar single card.
                (() => {
                  const iid = importId;
                  const count = drafts.filter((d) => d.importId === iid).length;
                  const matched = matchedImports.has(iid);
                  const issues = issueMap.get(iid) ?? [];
                  return (
                    <div className="space-y-3 rounded-lg border border-border bg-card/40 p-4">
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
                })()
              )}
              <div className="flex items-center gap-2">
                <Button onClick={() => void submitMaterialize()} disabled={submitting}>
                  {submitting && <Loader2 className="size-4 animate-spin" />}
                  {t("confirmPortfolio.confirm")}
                </Button>
                <Button variant="ghost" onClick={reset} disabled={submitting}>
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
