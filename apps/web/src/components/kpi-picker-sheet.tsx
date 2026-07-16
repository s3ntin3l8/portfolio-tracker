"use client";
import { useState } from "react";
import { Settings2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useApiClient } from "@/lib/api";

const ALL_KPI_KEYS = [
  "netWorth",
  "xirr",
  "dayChange",
  "totalPnL",
  "income",
  "cash",
  "positions",
] as const;
type KpiKey = (typeof ALL_KPI_KEYS)[number];

interface KpiPickerSheetProps {
  /** Currently saved KPI list, or null to show all. */
  currentKpis: string[] | null;
}

export function KpiPickerSheet({ currentKpis }: KpiPickerSheetProps) {
  const t = useTranslations("KpiPicker");
  const router = useRouter();
  const api = useApiClient();
  const [open, setOpen] = useState(false);
  const active = currentKpis ?? [...ALL_KPI_KEYS];
  const [selected, setSelected] = useState<Set<string>>(new Set(active));
  const [saving, setSaving] = useState(false);

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      const ordered = ALL_KPI_KEYS.filter((k) => selected.has(k));
      await api.putPreferences({ dashboardKpis: ordered });
      setOpen(false);
      router.refresh();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <Settings2 className="size-4" />
        <span className="sr-only">{t("title")}</span>
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{t("title")}</SheetTitle>
            <p className="text-sm text-muted-foreground">{t("description")}</p>
          </SheetHeader>
          <div className="py-4 space-y-3">
            {ALL_KPI_KEYS.map((key) => (
              <div key={key} className="flex items-center gap-2">
                <Switch id={key} checked={selected.has(key)} onCheckedChange={() => toggle(key)} />
                <Label htmlFor={key}>{t(key as KpiKey)}</Label>
              </div>
            ))}
          </div>
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t("cancel")}
            </Button>
            <Button onClick={save} disabled={saving}>
              {t("save")}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
