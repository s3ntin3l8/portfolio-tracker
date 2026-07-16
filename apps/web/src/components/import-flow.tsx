"use client";

import { cn } from "@/lib/utils";
import { useImportFlow, type UseImportFlowProps } from "@/components/import-flow/use-import-flow";
import {
  UploadStep,
  ParsingStep,
  ReportStep,
  ReviewStep,
} from "@/components/import-flow/step-views";
import { STEPS } from "@/components/import-flow/types";

export type { ImportIssue } from "@portfolio/api-client";
export type {
  ImportDraft,
  ImportContractScheduleRow,
  ImportContract,
  ImportResult,
  ReviewDraft,
  ImportClient,
  MaterializeUnit,
  ImportTask,
  ImportTargetPortfolio,
} from "@/components/import-flow/types";
export { withUid, stripUid } from "@/components/import-flow/types";

export function ImportFlow(props: UseImportFlowProps = {}) {
  const {
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
    reImportFile,
    accountMismatch,
    mismatchImportId,
    submitting,
    reportMeta,
    setReportMeta,
    setReportFile,
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
  } = useImportFlow(props);

  return (
    <div className={cn("mx-auto space-y-6", step === "review" ? "max-w-6xl" : "max-w-xl")}>
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
            <span className={cn(i <= activeIndex ? "text-foreground" : "text-muted-foreground")}>
              {t(`steps.${s}`)}
            </span>
            {i < STEPS.length - 1 && <span className="mx-1 h-px flex-1 bg-border" />}
          </li>
        ))}
      </ol>

      {step === "upload" && (
        <UploadStep
          dragActive={dragActive}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          fileRef={fileRef}
          onPick={onPick}
          error={error}
          reImportFile={reImportFile}
          onReImport={(file) => handleFiles([file], true)}
        />
      )}

      {step === "parsing" && <ParsingStep fileStatuses={fileStatuses} />}

      {step === "report" && (
        <ReportStep
          reportMeta={reportMeta}
          portfolios={
            props.portfolios ?? [{ id: "demo", name: "Demo", brokerage: null, accountHolder: null }]
          }
          reportPortfolioId={reportPortfolioId}
          onReportPortfolioChange={setReportPortfolioId}
          savingReport={savingReport}
          onSave={handleSaveReport}
          onCancel={() => {
            setReportFile(null);
            setReportMeta(null);
            setStep("upload");
          }}
        />
      )}

      {step === "review" && (
        <ReviewStep
          accountMismatch={accountMismatch}
          mismatchImportId={mismatchImportId}
          submitting={submitting}
          onMaterializeImportAnyway={() => submitMaterialize(true)}
          onConfirmImportAnyway={() => submitConfirm(true)}
          groups={groups}
          skipped={skipped}
          onSkippedChange={setSkipped}
          onReImportFile={handleFiles}
          savedReports={savedReports}
          contracts={contracts}
          onUpdateContract={updateContract}
          onContractSubmitConfirm={() => submitConfirm()}
          onReset={reset}
          drafts={drafts}
          importId={importId}
          portfolioByImport={portfolioByImport}
          matchedImports={matchedImports}
          issueMap={issueMap}
          onPortfolioChange={(iid, pid) => setPortfolioByImport((m) => new Map(m).set(iid, pid))}
          isMultiGroup={isMultiGroup}
          reviewGroups={reviewGroups}
          portfolios={
            props.portfolios ?? [{ id: "demo", name: "Demo", brokerage: null, accountHolder: null }]
          }
          onMaterialize={submitMaterialize}
        />
      )}
    </div>
  );
}
