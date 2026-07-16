"use client";

import { useTranslations } from "next-intl";
import { Upload, AlertCircle, CheckCircle2, ChevronDown, FileText } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { PortfolioPicker } from "@/components/portfolio-picker";
import { cn } from "@/lib/utils";
import { ContractReview } from "@/components/contract-review";
import { ImportFilesTable } from "@/components/import-files-table";
import type {
  FileStatus,
  SkippedFile,
  ImportContract,
  ImportTargetPortfolio,
  ReviewDraft,
  ReviewGroup,
  IssueMap,
  PortfolioByImportMap,
} from "./types";
import type { AccountMismatch } from "@portfolio/api-client";

export interface UploadStepProps {
  dragActive: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  fileRef: React.RefObject<HTMLInputElement | null>;
  onPick: (e: React.ChangeEvent<HTMLInputElement>) => void;
  error: string | null;
  reImportFile: File | null;
  onReImport: (file: File) => void;
}

export function UploadStep({
  dragActive,
  onDragOver,
  onDragLeave,
  onDrop,
  fileRef,
  onPick,
  error,
  reImportFile,
  onReImport,
}: UploadStepProps) {
  const t = useTranslations("Import");

  return (
    <div className="space-y-4">
      <button
        type="button"
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={() => fileRef.current?.click()}
        className={cn(
          "flex w-full cursor-pointer flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card/40 px-6 py-12 text-center transition-colors",
          dragActive ? "border-primary bg-primary/5" : "hover:border-primary/50 hover:bg-card",
        )}
      >
        <span className="flex size-12 items-center justify-center rounded-2xl bg-secondary">
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
              onClick={() => onReImport(reImportFile)}
            >
              {t("reImportAnyway")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export interface ParsingStepProps {
  fileStatuses: FileStatus[];
}

export function ParsingStep({ fileStatuses }: ParsingStepProps) {
  const t = useTranslations("Import");

  return (
    <Card>
      <CardContent className="py-8">
        {fileStatuses.length > 1 ? (
          <ul className="space-y-2">
            {fileStatuses.map((fs) => (
              <li key={fs.filename} className="flex items-center gap-3 text-sm">
                {fs.status === "parsing" && <Spinner size="sm" className="shrink-0 text-primary" />}
                {fs.status === "done" && <CheckCircle2 className="size-4 shrink-0 text-success" />}
                {fs.status === "failed" && (
                  <AlertCircle className="size-4 shrink-0 text-destructive" />
                )}
                {fs.status === "pending" && (
                  <span className="size-4 shrink-0 rounded-full border border-border" />
                )}
                <span
                  className={cn(
                    "min-w-0 truncate",
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
            <Spinner size="lg" className="text-primary" />
            <p className="text-sm text-muted-foreground">{t("parsing")}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export interface ReportStepProps {
  reportMeta: { category: string; taxYear: number | null; title: string } | null;
  portfolios: ImportTargetPortfolio[];
  reportPortfolioId: string;
  onReportPortfolioChange: (id: string) => void;
  savingReport: boolean;
  onSave: () => void;
  onCancel: () => void;
}

export function ReportStep({
  reportMeta,
  portfolios,
  reportPortfolioId,
  onReportPortfolioChange,
  savingReport,
  onSave,
  onCancel,
}: ReportStepProps) {
  const t = useTranslations("Import");

  if (!reportMeta) return null;

  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-4 py-8 text-center">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-secondary">
          <FileText className="size-6 text-primary" />
        </span>
        <div>
          <p className="font-medium">{t("report.detected", { title: reportMeta.title })}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t("report.hint")}</p>
        </div>
        {portfolios.length > 1 && (
          <div className="w-full max-w-xs space-y-1.5 text-left">
            <Label>{t("report.portfolioPicker")}</Label>
            <PortfolioPicker
              portfolios={portfolios}
              value={reportPortfolioId}
              onChange={onReportPortfolioChange}
              ariaLabel={t("report.portfolioPicker")}
              triggerClassName="w-full"
            />
          </div>
        )}
        <div className="flex gap-2">
          <Button type="button" variant="outline" disabled={savingReport} onClick={onCancel}>
            {t("report.cancel")}
          </Button>
          <Button type="button" disabled={savingReport || !reportPortfolioId} onClick={onSave}>
            {savingReport ? <Spinner size="sm" /> : null}
            {t("report.save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export interface ReviewStepProps {
  accountMismatch: AccountMismatch | null;
  mismatchImportId: string;
  submitting: boolean;
  onMaterializeImportAnyway: () => void;
  onConfirmImportAnyway: () => void;
  groups: Map<string, string>;
  skipped: SkippedFile[];
  onSkippedChange: (s: SkippedFile[] | ((prev: SkippedFile[]) => SkippedFile[])) => void;
  onReImportFile: (files: File[], force?: boolean) => void;
  savedReports: { file: string; title: string }[];
  contracts: ImportContract[];
  onUpdateContract: (index: number, patch: Partial<ImportContract>) => void;
  onContractSubmitConfirm: () => void;
  onReset: () => void;
  drafts: ReviewDraft[];
  importId: string;
  portfolioByImport: PortfolioByImportMap;
  matchedImports: Set<string>;
  issueMap: IssueMap;
  onPortfolioChange: (iid: string, pid: string) => void;
  isMultiGroup: boolean;
  reviewGroups: ReviewGroup[] | undefined;
  portfolios: ImportTargetPortfolio[];
  onMaterialize: (acknowledge?: boolean) => void;
}

export function ReviewStep({
  accountMismatch,
  mismatchImportId,
  submitting,
  onMaterializeImportAnyway,
  onConfirmImportAnyway,
  groups,
  skipped,
  onSkippedChange,
  onReImportFile,
  savedReports,
  contracts,
  onUpdateContract,
  onContractSubmitConfirm,
  onReset,
  drafts,
  importId,
  portfolioByImport,
  matchedImports,
  issueMap,
  onPortfolioChange,
  isMultiGroup,
  reviewGroups,
  portfolios,
  onMaterialize,
}: ReviewStepProps) {
  const t = useTranslations("Import");

  return (
    <div className="space-y-6">
      {accountMismatch && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm text-warning"
        >
          <AlertCircle className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            {groups.size > 1 && groups.get(mismatchImportId) && (
              <span className="block truncate font-medium">{groups.get(mismatchImportId)}</span>
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
                ? onMaterializeImportAnyway()
                : onConfirmImportAnyway()
            }
          >
            {t("accountMismatch.importAnyway")}
          </Button>
        </div>
      )}

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
                      onSkippedChange((prev) => prev.filter((x) => x.file !== s.file));
                      onReImportFile([f], true);
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

      {savedReports.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-success/30 bg-success/10 px-3 py-2.5 text-sm text-success">
          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
          <ul className="flex-1 space-y-1">
            {savedReports.map((r) => (
              <li key={r.file}>{t("report.savedFile", { title: r.title })}</li>
            ))}
          </ul>
        </div>
      )}

      {contracts.length > 0 && (
        <ContractReview
          contracts={contracts}
          onUpdate={onUpdateContract}
          onConfirm={onContractSubmitConfirm}
          onDiscard={onReset}
        />
      )}

      {drafts.length > 0 && contracts.length === 0 && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">{t("confirmPortfolio.title")}</h2>
          {isMultiGroup ? (
            <ImportFilesTable
              groups={reviewGroups!}
              portfolios={portfolios}
              portfolioByImport={portfolioByImport}
              matchedImports={matchedImports}
              countByImport={(iid) => drafts.filter((d) => d.importId === iid).length}
              issueCountByImport={(iid) => (issueMap.get(iid) ?? []).length}
              onPortfolioChange={onPortfolioChange}
            />
          ) : (
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
                        onChange={(pid) => onPortfolioChange(iid, pid)}
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
            <Button onClick={() => onMaterialize()} disabled={submitting}>
              {submitting && <Spinner size="sm" />}
              {t("confirmPortfolio.confirm")}
            </Button>
            <Button variant="ghost" onClick={onReset} disabled={submitting}>
              {t("confirmPortfolio.discard")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
