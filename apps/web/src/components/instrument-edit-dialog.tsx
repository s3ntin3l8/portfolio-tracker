"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import type { Instrument } from "@portfolio/api-client";
import { ApiError } from "@portfolio/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";
import { toast } from "sonner";

const ASSET_CLASSES = [
  "equity",
  "gold",
  "bond",
  "mutual_fund",
  "etf",
  "crypto",
  "derivative",
] as const;

export function InstrumentEditDialog({
  instrument,
  children,
}: {
  instrument: Instrument;
  children: React.ReactNode;
}) {
  const t = useTranslations("Instrument");
  const tc = useTranslations("AssetClass");
  const api = useApiClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const [isin, setIsin] = useState(instrument.isin ?? "");
  const [wkn, setWkn] = useState(instrument.wkn ?? "");
  const [symbol, setSymbol] = useState(instrument.symbol);
  const [name, setName] = useState(instrument.name);
  const [assetClass, setAssetClass] = useState(instrument.assetClass);
  const [market, setMarket] = useState(instrument.market);

  function reset() {
    setIsin(instrument.isin ?? "");
    setWkn(instrument.wkn ?? "");
    setSymbol(instrument.symbol);
    setName(instrument.name);
    setAssetClass(instrument.assetClass);
    setMarket(instrument.market);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await api.updateInstrument(instrument.id, {
        isin: isin || null,
        wkn: wkn || null,
        symbol,
        name,
        assetClass,
        market,
      });
      router.refresh();
      toast.success(t("editSaved"));
      setOpen(false);
    } catch (err) {
      const body = err instanceof ApiError ? err.body : "";
      if (body.includes("conflict")) {
        toast.error(t("editConflict"));
      } else {
        toast.error(t("editError"));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (next) reset();
        setOpen(next);
      }}
    >
      <SheetTrigger asChild>{children}</SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{t("editTitle")}</SheetTitle>
        </SheetHeader>
        <form onSubmit={submit} className="space-y-4 p-6 pt-4">
          <div className="space-y-1.5">
            <Label htmlFor="edit-isin">{t("isin")}</Label>
            <Input id="edit-isin" value={isin} onChange={(e) => setIsin(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-wkn">{t("wkn")}</Label>
            <Input id="edit-wkn" value={wkn} onChange={(e) => setWkn(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-symbol">{t("symbol")}</Label>
            <Input
              id="edit-symbol"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-name">{t("name")}</Label>
            <Input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-asset-class">{t("assetClass")}</Label>
            <Select
              id="edit-asset-class"
              value={assetClass}
              onChange={(e) => setAssetClass(e.target.value)}
            >
              {ASSET_CLASSES.map((ac) => (
                <option key={ac} value={ac}>
                  {tc(ac)}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-market">{t("market")}</Label>
            <Input
              id="edit-market"
              value={market}
              onChange={(e) => setMarket(e.target.value)}
              required
            />
          </div>
          <div className="border-t border-border pt-4">
            <Button type="submit" disabled={busy} className="w-full">
              {busy && <Loader2 className="size-4 animate-spin" />}
              {busy ? t("saving") : t("save")}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
