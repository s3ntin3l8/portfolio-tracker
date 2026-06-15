"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  ScanLine,
  CheckCircle2,
  Loader2,
  Upload,
  FileText,
  AlertCircle,
  Trash2,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";

// A draft transaction as it comes back from the API (executedAt is an ISO string).
export interface ImportDraft {
  assetClass: string;
  action: string;
  ticker?: string | null;
  isin?: string | null;
  name?: string | null;
  quantity: string;
  unit: string;
  price: string;
  fees?: string | null;
  total?: string | null;
  currency: string;
  executedAt: string;
  confidence: number;
}

export interface ImportResult {
  importId: string;
  drafts: ImportDraft[];
  errors: { line: number; message: string }[];
}

/** The slice of the API client the import flow needs (injectable for tests). */
export interface ImportClient {
  importScreenshot(
    portfolioId: string,
    image: string,
    mimeType?: string,
  ): Promise<ImportResult>;
  importCsv(
    portfolioId: string,
    content: string,
    format?: CsvFormat,
  ): Promise<ImportResult>;
  confirmImport(
    importId: string,
    drafts: ImportDraft[],
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
    errors: [],
  }),
  importCsv: async () => ({ importId: "demo", drafts: [SAMPLE_DRAFT], errors: [] }),
  confirmImport: async (_id, drafts) => ({ confirmed: drafts.length }),
};

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("file_read_error"));
    reader.onload = () => {
      const result = String(reader.result);
      // Strip the `data:<mime>;base64,` prefix.
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

function fileToText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("file_read_error"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(file);
  });
}

export function ImportFlow({
  client = demoClient,
  portfolios = [{ id: "demo", name: "Demo" }],
  defaultPortfolioId,
}: {
  client?: ImportClient;
  portfolios?: ImportTargetPortfolio[];
  defaultPortfolioId?: string;
} = {}) {
  const t = useTranslations("Import");
  const [step, setStep] = useState<Step>("upload");
  const [mode, setMode] = useState<Mode>("screenshot");
  const [csvFormat, setCsvFormat] = useState<CsvFormat>("auto");
  const [portfolioId, setPortfolioId] = useState<string>(
    defaultPortfolioId ?? portfolios[0]?.id ?? "demo",
  );
  const [drafts, setDrafts] = useState<ImportDraft[]>([]);
  const [importId, setImportId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [confirmedCount, setConfirmedCount] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const activeIndex = step === "parsing" ? 0 : STEPS.indexOf(step);

  function errorMessage(err: unknown): string {
    const status = (err as { status?: number })?.status;
    if (status === 503) return t("errors.notConfigured");
    if (status === 502) return t("errors.parseFailed");
    if ((err as Error)?.message === "file_read_error") return t("errors.fileRead");
    return t("errors.generic");
  }

  async function handleFile(file: File) {
    setError(null);
    setStep("parsing");
    try {
      const result =
        mode === "csv"
          ? await client.importCsv(portfolioId, await fileToText(file), csvFormat)
          : await client.importScreenshot(
              portfolioId,
              await fileToBase64(file),
              file.type || "image/png",
            );
      if (result.drafts.length === 0) {
        setError(t("errors.noDrafts"));
        setStep("upload");
        return;
      }
      setImportId(result.importId);
      setDrafts(result.drafts);
      setStep("review");
    } catch (err) {
      setError(errorMessage(err));
      setStep("upload");
    }
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (file) void handleFile(file);
  }

  function updateDraft(i: number, patch: Partial<ImportDraft>) {
    setDrafts((ds) => ds.map((d, idx) => (idx === i ? { ...d, ...patch } : d)));
  }

  function removeDraft(i: number) {
    setDrafts((ds) => ds.filter((_, idx) => idx !== i));
  }

  async function confirm() {
    setError(null);
    setStep("parsing");
    try {
      const { confirmed } = await client.confirmImport(importId, drafts);
      setConfirmedCount(confirmed);
      setStep("done");
    } catch (err) {
      setError(errorMessage(err));
      setStep("review");
    }
  }

  function reset() {
    setDrafts([]);
    setImportId("");
    setError(null);
    setStep("upload");
  }

  return (
    <div className="mx-auto max-w-xl space-y-6">
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
          {/* Target portfolio — which portfolio the confirmed transactions land in */}
          {portfolios.length > 1 && (
            <div className="space-y-1.5">
              <Label htmlFor="import-portfolio">{t("targetPortfolio")}</Label>
              <Select
                id="import-portfolio"
                value={portfolioId}
                onChange={(e) => setPortfolioId(e.target.value)}
              >
                {portfolios.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </div>
          )}

          {/* Mode tabs */}
          <div className="inline-flex rounded-lg border border-border p-1 text-sm">
            <button
              type="button"
              onClick={() => setMode("screenshot")}
              className={cn(
                "flex items-center gap-2 rounded-md px-3 py-1.5 font-medium transition-colors",
                mode === "screenshot"
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground",
              )}
            >
              <ScanLine className="size-4" />
              {t("tabs.screenshot")}
            </button>
            <button
              type="button"
              onClick={() => setMode("csv")}
              className={cn(
                "flex items-center gap-2 rounded-md px-3 py-1.5 font-medium transition-colors",
                mode === "csv"
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground",
              )}
            >
              <FileText className="size-4" />
              {t("tabs.csv")}
            </button>
          </div>

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

          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex w-full cursor-pointer flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card/40 px-6 py-12 text-center transition-colors hover:border-primary/50 hover:bg-card"
          >
            <span className="flex size-12 items-center justify-center rounded-full bg-secondary">
              {mode === "csv" ? (
                <FileText className="size-6 text-primary" />
              ) : (
                <ScanLine className="size-6 text-primary" />
              )}
            </span>
            <span className="font-medium">{t("dropzone.title")}</span>
            <span className="text-sm text-muted-foreground">{t("dropzone.hint")}</span>
            <span className="mt-1 inline-flex items-center gap-2 text-sm text-primary">
              <Upload className="size-4" />
              {mode === "csv" ? t("dropzone.csvCta") : t("dropzone.cta")}
            </span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept={mode === "csv" ? ".csv,text/csv" : "image/*"}
            className="sr-only"
            aria-label={t("dropzone.cta")}
            onChange={onPick}
          />
        </div>
      )}

      {step === "parsing" && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12">
            <Loader2 className="size-6 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">{t("parsing")}</p>
          </CardContent>
        </Card>
      )}

      {step === "review" && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t("draftCount", { count: drafts.length })} — {t("reviewHint")}
          </p>

          {drafts.map((draft, i) => (
            <Card key={i}>
              <CardContent className="space-y-4 p-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{draft.assetClass}</Badge>
                    <Badge variant="success">{draft.action}</Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={draft.confidence >= 0.9 ? "success" : "warning"}>
                      {t("confidence", { pct: Math.round(draft.confidence * 100) })}
                    </Badge>
                    {drafts.length > 1 && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t("remove")}
                        onClick={() => removeDraft(i)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t("fields.name")}>
                    <Input
                      value={draft.name ?? ""}
                      onChange={(e) => updateDraft(i, { name: e.target.value })}
                    />
                  </Field>
                  <Field label={t("fields.executedAt")}>
                    <Input
                      type="date"
                      value={draft.executedAt.slice(0, 10)}
                      onChange={(e) => updateDraft(i, { executedAt: e.target.value })}
                    />
                  </Field>
                  <Field label={t("fields.quantity")}>
                    <Input
                      value={draft.quantity}
                      onChange={(e) => updateDraft(i, { quantity: e.target.value })}
                    />
                  </Field>
                  <Field label={t("fields.price")}>
                    <Input
                      value={draft.price}
                      onChange={(e) => updateDraft(i, { price: e.target.value })}
                    />
                  </Field>
                </div>
              </CardContent>
            </Card>
          ))}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={reset}>
              {t("discard")}
            </Button>
            <Button onClick={confirm} disabled={drafts.length === 0}>
              {t("confirm")}
            </Button>
          </div>
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
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
