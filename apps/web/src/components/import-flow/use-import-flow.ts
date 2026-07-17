"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { toast } from "sonner";
import { classifyImportError } from "@/lib/import-errors";
import { mapPool, IMPORT_CONCURRENCY } from "@/lib/promise-pool";
import { errorMessage, taskLabel, notifyMaterialized } from "./use-import-flow/helpers";
import { type AccountMismatch, type DocumentCategory } from "@portfolio/api-client";
import {
  type ImportContract,
  type ReviewDraft,
  type ImportClient,
  type MaterializeUnit,
  type ImportTask,
  type ImportTargetPortfolio,
  type Step,
  type PortfolioByImportMap,
  type SkippedFile,
  type ParseOutcome,
  type FileStatus,
  type IssueMap,
  type GroupMap,
  type ReviewGroup,
  STEPS,
  demoClient,
  fileToText,
  isCsvFile,
  newBatchId,
  withUid,
  stripUid,
} from "./types";

export interface UseImportFlowProps {
  client?: ImportClient;
  portfolios?: ImportTargetPortfolio[];
  defaultPortfolioId?: string;
  initialFile?: File | null;
  onSubmit?: (task: ImportTask) => void;
  onClose?: () => void;
}

export interface UseImportFlowReturn {
  step: Step;
  setStep: (step: Step) => void;
  portfolioByImport: PortfolioByImportMap;
  setPortfolioByImport: (
    m: PortfolioByImportMap | ((prev: PortfolioByImportMap) => PortfolioByImportMap),
  ) => void;
  matchedImports: Set<string>;
  drafts: ReviewDraft[];
  contracts: ImportContract[];
  importId: string;
  groups: GroupMap;
  issueMap: IssueMap;
  skipped: SkippedFile[];
  error: string | null;
  reImportFile: File | null;
  accountMismatch: AccountMismatch | null;
  mismatchImportId: string;
  submitting: boolean;
  reportFile: File | null;
  reportMeta: { category: DocumentCategory; taxYear: number | null; title: string } | null;
  reportPortfolioId: string;
  savingReport: boolean;
  savedReports: { file: string; title: string }[];
  fileStatuses: FileStatus[];
  dragActive: boolean;
  fileRef: React.RefObject<HTMLInputElement | null>;
  activeIndex: number;
  isMultiGroup: boolean;
  reviewGroups: ReviewGroup[] | undefined;
  handleFiles: (files: File[], force?: boolean) => Promise<void>;
  onPick: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleSaveReport: () => Promise<void>;
  updateContract: (index: number, patch: Partial<ImportContract>) => void;
  submitConfirm: (acknowledge?: boolean) => Promise<void>;
  submitMaterialize: (acknowledge?: boolean) => Promise<void>;
  reset: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  setSkipped: (s: SkippedFile[] | ((prev: SkippedFile[]) => SkippedFile[])) => void;
  setReImportFile: (f: File | null) => void;
  setError: (e: string | null) => void;
  setReportFile: (f: File | null) => void;
  setReportMeta: (
    m: { category: DocumentCategory; taxYear: number | null; title: string } | null,
  ) => void;
  setReportPortfolioId: (id: string) => void;
  t: ReturnType<typeof useTranslations>;
}

export function useImportFlow({
  client = demoClient,
  portfolios = [{ id: "demo", name: "Demo", brokerage: null, accountHolder: null }],
  defaultPortfolioId,
  initialFile,
  onSubmit,
  onClose,
}: UseImportFlowProps = {}): UseImportFlowReturn {
  const t = useTranslations("Import");
  const router = useRouter();
  const [step, setStep] = useState<Step>("upload");
  const [portfolioByImport, setPortfolioByImport] = useState<PortfolioByImportMap>(new Map());
  const [matchedImports, setMatchedImports] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<ReviewDraft[]>([]);
  const [contracts, setContracts] = useState<ImportContract[]>([]);
  const [importId, setImportId] = useState<string>("");
  const [groups, setGroups] = useState<GroupMap>(new Map());
  const [issueMap, setIssueMap] = useState<IssueMap>(new Map());
  const [skipped, setSkipped] = useState<SkippedFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reImportFile, setReImportFile] = useState<File | null>(null);
  const [accountMismatch, setAccountMismatch] = useState<AccountMismatch | null>(null);
  const [mismatchImportId, setMismatchImportId] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [reportFile, setReportFile] = useState<File | null>(null);
  const [reportMeta, setReportMeta] = useState<{
    category: DocumentCategory;
    taxYear: number | null;
    title: string;
  } | null>(null);
  const [reportPortfolioId, setReportPortfolioId] = useState("");
  const [savingReport, setSavingReport] = useState(false);
  const [savedReports, setSavedReports] = useState<{ file: string; title: string }[]>([]);
  const [fileStatuses, setFileStatuses] = useState<FileStatus[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const activeIndex = step === "parsing" || step === "report" ? 0 : STEPS.indexOf(step);

  function notifyMaterializedFn(count: number) {
    notifyMaterialized(count, router, t);
  }

  async function handleSaveReport() {
    if (!reportFile || !reportMeta || !reportPortfolioId) return;
    setSavingReport(true);
    try {
      await client.uploadDocument(reportFile, {
        category: reportMeta.category,
        taxYear: reportMeta.taxYear ?? undefined,
        portfolioId: reportPortfolioId,
      });
      router.refresh();
      toast.success(t("report.saved"), {
        action: {
          label: t("report.viewInbox"),
          onClick: () => router.push("/reports/documents"),
        },
      });
      onClose?.();
    } catch (err) {
      setError(errorMessage(err, t));
    } finally {
      setSavingReport(false);
    }
  }

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
    setSavedReports([]);
    setFileStatuses([]);
    setStep("parsing");

    const defaultPid = defaultPortfolioId ?? portfolios[0]?.id ?? "";

    if (files.length === 1) {
      const file = files[0]!;
      try {
        const result = isCsvFile(file)
          ? await client.importCsv(await fileToText(file), file.name, "auto", force)
          : await client.importScreenshot(file, force);
        if (result.isReport) {
          setReportFile(file);
          setReportMeta({
            category: result.reportCategory ?? "tax_report",
            taxYear: result.reportTaxYear ?? null,
            title: result.reportTitle ?? file.name,
          });
          setReportPortfolioId(defaultPid);
          setStep("report");
          return;
        }
        if (result.alreadyConfirmed) {
          setError(t("errors.alreadyConfirmed"));
          setReImportFile(file);
          setStep("upload");
          return;
        }
        if (result.materialized) {
          notifyMaterializedFn(result.materializedCount ?? 0);
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
        setMatchedImports(result.matchedPortfolioId ? new Set([result.importId]) : new Set());
        setAccountMismatch(result.accountMismatch ?? null);
        setStep("review");
      } catch (err) {
        setError(errorMessage(err, t));
        setStep("upload");
      }
      return;
    }

    setFileStatuses(files.map((f) => ({ filename: f.name, status: "pending" })));

    const setStatus = (i: number, status: FileStatus["status"]) =>
      setFileStatuses((prev) => prev.map((s, idx) => (idx === i ? { ...s, status } : s)));

    const batchId = newBatchId();

    async function parseOne(file: File, i: number): Promise<ParseOutcome> {
      setStatus(i, "parsing");
      try {
        const result = isCsvFile(file)
          ? await client.importCsv(await fileToText(file), file.name, "auto", force, batchId)
          : await client.importScreenshot(file, force, batchId);
        if (result.isReport) {
          try {
            await client.uploadDocument(file, {
              category: result.reportCategory ?? "tax_report",
              taxYear: result.reportTaxYear ?? undefined,
              portfolioId: defaultPid,
            });
            setStatus(i, "done");
            return { status: "report", file: file.name, title: result.reportTitle ?? file.name };
          } catch {
            setStatus(i, "failed");
            return { status: "skipped", skip: { file: file.name, reason: "reportSaveFailed" } };
          }
        }
        if (result.alreadyConfirmed) {
          setStatus(i, "failed");
          return {
            status: "skipped",
            skip: { file: file.name, reason: "alreadyConfirmed", originalFile: file },
          };
        }
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
        const info = classifyImportError(err);
        setStatus(i, "failed");
        return {
          status: "skipped",
          skip: { file: file.name, reason: info.reason, provider: info.provider },
        };
      }
    }

    const outcomes = await mapPool(files, IMPORT_CONCURRENCY, parseOne);

    const mergedDrafts: ReviewDraft[] = [];
    const newGroups: GroupMap = new Map();
    const newIssueMap: IssueMap = new Map();
    const newSkipped: SkippedFile[] = [];
    const newSavedReports: { file: string; title: string }[] = [];
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
      if (o.status === "report") {
        newSavedReports.push({ file: o.file, title: o.title });
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
      if ((result.contracts ?? []).length > 0 && !pickedContractImportId) {
        pickedContractImportId = iid;
        pickedContracts = result.contracts ?? [];
      }
    }

    setSkipped(newSkipped);
    setSavedReports(newSavedReports);

    if (
      mergedDrafts.length === 0 &&
      pickedContracts.length === 0 &&
      (materializedTotal > 0 || newSavedReports.length > 0)
    ) {
      if (materializedTotal > 0) notifyMaterializedFn(materializedTotal);
      if (newSavedReports.length > 0) {
        router.refresh();
        toast.success(t("report.savedMulti", { count: newSavedReports.length }));
      }
      onClose?.();
      return;
    }

    if (mergedDrafts.length === 0 && pickedContracts.length === 0) {
      if (newSkipped.length === 1) {
        const s = newSkipped[0]!;
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
    const firstId = newGroups.keys().next().value ?? "";
    setImportId(firstId);
    setStep("review");
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length > 0) void handleFiles(files);
  }

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
      label: taskLabel(groups, t),
      acknowledge,
      importId,
      drafts: drafts.map(stripUid),
      contracts,
      portfolioId,
    });
    onClose?.();
  }

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
      label: taskLabel(groups, t),
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

  const isMultiGroup = groups.size > 1;
  const reviewGroups: ReviewGroup[] | undefined = isMultiGroup
    ? Array.from(groups.entries()).map(([iid, filename]) => ({ importId: iid, filename }))
    : undefined;

  return {
    step,
    setStep,
    portfolioByImport,
    setPortfolioByImport,
    matchedImports,
    drafts,
    contracts,
    importId,
    groups,
    issueMap,
    skipped,
    setSkipped,
    error,
    setError,
    reImportFile,
    setReImportFile,
    accountMismatch,
    mismatchImportId,
    submitting,
    reportFile,
    setReportFile,
    reportMeta,
    setReportMeta,
    reportPortfolioId,
    setReportPortfolioId,
    savingReport,
    savedReports,
    fileStatuses,
    dragActive,
    fileRef,
    activeIndex,
    isMultiGroup,
    reviewGroups,
    handleFiles,
    onPick,
    handleSaveReport,
    updateContract,
    submitConfirm,
    submitMaterialize,
    reset,
    onDragOver,
    onDragLeave,
    onDrop,
    t,
  };
}
