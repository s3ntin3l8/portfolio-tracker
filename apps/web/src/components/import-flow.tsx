"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ScanLine, CheckCircle2, Loader2, Upload } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Step = "upload" | "parsing" | "review" | "done";

const SAMPLE_DRAFT = {
  assetClass: "gold",
  action: "buy",
  name: "Antam Gold (Tabungan Emas)",
  quantity: "5",
  unit: "grams",
  price: "1150000",
  currency: "IDR",
  executedAt: "2026-02-08",
  confidence: 0.94,
};

const STEPS: Step[] = ["upload", "review", "done"];

export function ImportFlow() {
  const t = useTranslations("Import");
  const [step, setStep] = useState<Step>("upload");
  const [draft, setDraft] = useState(SAMPLE_DRAFT);

  function startParse() {
    setStep("parsing");
    setTimeout(() => setStep("review"), 1100);
  }

  const activeIndex = step === "parsing" ? 0 : STEPS.indexOf(step);

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
            {i < STEPS.length - 1 && (
              <span className="mx-1 h-px flex-1 bg-border" />
            )}
          </li>
        ))}
      </ol>

      {step === "upload" && (
        <button
          type="button"
          onClick={startParse}
          className="flex w-full cursor-pointer flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card/40 px-6 py-12 text-center transition-colors hover:border-primary/50 hover:bg-card"
        >
          <span className="flex size-12 items-center justify-center rounded-full bg-secondary">
            <ScanLine className="size-6 text-primary" />
          </span>
          <span className="font-medium">{t("dropzone.title")}</span>
          <span className="text-sm text-muted-foreground">
            {t("dropzone.hint")}
          </span>
          <span className="mt-1 inline-flex items-center gap-2 text-sm text-primary">
            <Upload className="size-4" />
            {t("dropzone.cta")}
          </span>
        </button>
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
        <Card>
          <CardContent className="space-y-4 p-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Badge variant="outline">{draft.assetClass}</Badge>
                <Badge variant="success">{draft.action}</Badge>
              </div>
              <Badge variant={draft.confidence >= 0.9 ? "success" : "warning"}>
                {t("confidence", { pct: Math.round(draft.confidence * 100) })}
              </Badge>
            </div>

            <p className="text-sm text-muted-foreground">{t("reviewHint")}</p>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("fields.name")}>
                <Input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </Field>
              <Field label={t("fields.executedAt")}>
                <Input
                  type="date"
                  value={draft.executedAt}
                  onChange={(e) =>
                    setDraft({ ...draft, executedAt: e.target.value })
                  }
                />
              </Field>
              <Field label={t("fields.quantity")}>
                <Input
                  value={draft.quantity}
                  onChange={(e) =>
                    setDraft({ ...draft, quantity: e.target.value })
                  }
                />
              </Field>
              <Field label={t("fields.price")}>
                <Input
                  value={draft.price}
                  onChange={(e) => setDraft({ ...draft, price: e.target.value })}
                />
              </Field>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setStep("upload")}>
                {t("discard")}
              </Button>
              <Button onClick={() => setStep("done")}>{t("confirm")}</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === "done" && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <CheckCircle2 className="size-8 text-success" />
            <p className="font-medium">{t("done.title")}</p>
            <p className="text-sm text-muted-foreground">{t("done.hint")}</p>
            <Button
              variant="outline"
              className="mt-2"
              onClick={() => setStep("upload")}
            >
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
