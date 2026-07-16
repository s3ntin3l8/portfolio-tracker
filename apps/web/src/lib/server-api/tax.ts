import type { TaxSummaryHolder, PortfolioTaxSummary } from "@portfolio/api-client";
import type { IdYearInput } from "@portfolio/core";
import {
  getServerApi,
  listPortfoliosCached,
  listAccountHoldersCached,
  getSelectedPortfolioId,
  resolveHolderScope,
  ID_ALL_PORTFOLIOS_ID,
  type TaxDisposalRow,
  type TaxDisposalLot,
  type TaxDividendRow,
  type TaxCurrencyTotal,
  type TaxYearRow,
  type TaxYearDetail,
} from "./_shared.js";

export async function loadNetworthTax(
  year?: number,
  taxRegime: "DE" | "ID" = "DE",
): Promise<TaxSummaryHolder[]> {
  const api = await getServerApi();
  if (!api) return [];
  try {
    const portfolios = await listPortfoliosCached();
    if (portfolios.length === 0) return [];

    const wanted = await getSelectedPortfolioId();
    const selected = portfolios.find((p) => p.id === wanted);
    const targetYear = year ?? new Date().getUTCFullYear();

    if (taxRegime === "ID") {
      const zeroAllowance = {
        year: targetYear,
        allowanceAnnual: "0",
        realizedGainsAdjusted: "0",
        incomeYtd: "0",
        vorabpauschaleAccrued: "0",
        vorabpauschaleCredited: "0",
        stockPot: { netGainLoss: "0", carryForwardApplied: "0", used: "0" },
        generalPot: { netGainLoss: "0", carryForwardApplied: "0", used: "0" },
        usedYtd: "0",
        taxableExcess: "0",
        remaining: "0",
        taxRate: "0",
        taxSavingAvailable: "0",
        currency: selected?.baseCurrency ?? "IDR",
        forecastIncomeRestOfYear: "0",
        projectedUsedFullYear: "0",
        projectedRemaining: "0",
        projectedTaxSavingAvailable: "0",
      };
      const zeroDistribution = {
        holderAllowanceCap: "0",
        totalAllocated: "0",
        remainingToDistribute: "0",
        overAllocated: false,
      };

      if (selected) {
        return [
          {
            holder: {
              id: selected.accountHolderId ?? selected.id,
              name: selected.accountHolder ?? selected.name,
              taxAllowanceAnnual: selected.taxAllowanceAnnual,
              capitalGainsTaxRate: null,
              churchTax: null,
              taxResidence: null,
            },
            year: targetYear,
            currency: zeroAllowance.currency,
            allowanceUsage: zeroAllowance,
            harvestSuggestions: [],
            carryForwardApplied: false,
            distribution: zeroDistribution,
            tfRatesByInstrument: {},
          },
        ];
      }

      const holderId = await resolveHolderScope(portfolios);
      let holderName = "";
      if (holderId) {
        const holders = await listAccountHoldersCached();
        holderName = holders.find((h) => h.id === holderId)?.name ?? "";
      }

      return [
        {
          holder: {
            id: holderId ?? ID_ALL_PORTFOLIOS_ID,
            name: holderName,
            taxAllowanceAnnual: null,
            capitalGainsTaxRate: null,
            churchTax: null,
            taxResidence: null,
          },
          year: targetYear,
          currency: zeroAllowance.currency,
          allowanceUsage: zeroAllowance,
          harvestSuggestions: [],
          carryForwardApplied: false,
          distribution: zeroDistribution,
          tfRatesByInstrument: {},
        },
      ];
    }

    if (selected) {
      let result: PortfolioTaxSummary;
      try {
        result = await api.getPortfolioTax(selected.id, year);
      } catch (err: unknown) {
        if (
          err &&
          typeof err === "object" &&
          "status" in err &&
          (err as { status: number }).status === 422
        ) {
          return [];
        }
        throw err;
      }
      const holderEntry: TaxSummaryHolder = {
        holder: {
          id: selected.accountHolderId ?? selected.id,
          name: selected.accountHolder ?? selected.name,
          taxAllowanceAnnual: selected.taxAllowanceAnnual,
          capitalGainsTaxRate: null,
          churchTax: null,
          taxResidence: null,
        },
        year: result.year,
        currency: result.currency,
        allowanceUsage: result.allowanceUsage,
        harvestSuggestions: result.harvestSuggestions,
        carryForwardApplied: result.carryForwardApplied,
        distribution: result.holderDistribution,
        tfRatesByInstrument: result.tfRatesByInstrument,
      };
      return [holderEntry];
    }

    const holderId = await resolveHolderScope(portfolios);
    return await api.getNetworthTax(year, holderId);
  } catch {
    return [];
  }
}

export async function loadTaxYearDetail(
  holders: TaxSummaryHolder[],
  year?: number,
): Promise<Map<string, TaxYearDetail>> {
  const result = new Map<string, TaxYearDetail>();
  if (holders.length === 0) return result;
  const api = await getServerApi();
  if (!api) return result;
  const targetYear = year ?? new Date().getUTCFullYear();

  let portfolios: import("@portfolio/api-client").Portfolio[];
  let selected: import("@portfolio/api-client").Portfolio | undefined;
  try {
    portfolios = await listPortfoliosCached();
    const wanted = await getSelectedPortfolioId();
    selected = portfolios.find((p) => p.id === wanted);
  } catch {
    return result;
  }

  await Promise.all(
    holders.map(async (entry) => {
      const holderId = entry.holder.id;
      const pfs = selected
        ? [selected]
        : holderId === ID_ALL_PORTFOLIOS_ID
          ? portfolios
          : portfolios.filter((p) => p.accountHolderId === holderId);
      if (pfs.length === 0) return;

      try {
        const [tradeLog, incomeLists] = await Promise.all([
          selected
            ? api.getTrades(selected.id, "fifo")
            : api.getNetWorthTrades("fifo", undefined, holderId),
          Promise.all(pfs.map((p) => api.listIncomeByYear(p.id, targetYear))),
        ]);

        const disposalGroups = new Map<
          string,
          {
            symbol: string;
            when: string;
            instrumentId: string;
            proceeds: number;
            gain: number;
            quantity: number;
            cost: number;
            tfRate: number;
            lots: TaxDisposalLot[];
          }
        >();
        for (const t of tradeLog.trades) {
          for (const l of t.legs) {
            if (l.taxYear !== targetYear) continue;
            const key = `${t.instrumentId}:${l.sellDate}`;
            const qty = Number(l.quantity);
            const cost = Number(l.cost);
            const proceeds = Number(l.proceeds);
            const group = disposalGroups.get(key) ?? {
              symbol: t.instrument?.symbol ?? t.instrumentId.slice(0, 8),
              when: l.sellDate,
              instrumentId: t.instrumentId,
              proceeds: 0,
              gain: 0,
              quantity: 0,
              cost: 0,
              tfRate: Number(entry.tfRatesByInstrument?.[t.instrumentId] ?? "0"),
              lots: [],
            };
            group.proceeds += proceeds;
            group.gain += Number(l.gain);
            group.quantity += qty;
            group.cost += cost;
            group.lots.push({
              acqDate: l.acqDate,
              quantity: l.quantity,
              buyPrice: qty > 0 ? (cost / qty).toString() : "0",
              sellPrice: qty > 0 ? (proceeds / qty).toString() : "0",
              proceeds: l.proceeds,
              gain: l.gain,
              holdingDays: l.holdingDays,
              longTerm: l.longTerm,
            });
            disposalGroups.set(key, group);
          }
        }
        const legs: TaxDisposalRow[] = [...disposalGroups.values()].map((g) => ({
          symbol: g.symbol,
          when: g.when,
          instrumentId: g.instrumentId,
          proceeds: g.proceeds.toFixed(2),
          gain: g.gain.toFixed(2),
          tfRate: g.tfRate.toString(),
          gainAdjusted: (g.gain * (1 - g.tfRate)).toFixed(2),
          quantity: g.quantity.toString(),
          avgBuyPrice: g.quantity > 0 ? (g.cost / g.quantity).toString() : "0",
          sellPrice: g.quantity > 0 ? (g.proceeds / g.quantity).toString() : "0",
          lots: g.lots.sort((a, b) => a.acqDate.localeCompare(b.acqDate)),
        }));
        const totalProceeds = legs.reduce((s, l) => s + Number(l.proceeds), 0);
        const totalGain = legs.reduce((s, l) => s + Number(l.gain), 0);

        const incomeTxns = incomeLists
          .flat()
          .filter(
            (t) =>
              (t.type === "dividend" || t.type === "coupon" || t.type === "interest") &&
              t.status !== "archived" &&
              t.status !== "draft" &&
              new Date(t.executedAt).getUTCFullYear() === targetYear,
          );
        const byInstrument = new Map<
          string,
          { symbol: string; currency: string; net: number; tax: number }
        >();
        for (const t of incomeTxns) {
          const qty = Number(t.quantity);
          const net = (qty > 0 ? qty * Number(t.price) : Number(t.price)) - Number(t.fees ?? 0);
          const key = `${t.instrumentId ?? t.description ?? t.type}:${t.currency}`;
          const symbol = t.instrument?.symbol ?? t.description ?? t.type;
          const bucket = byInstrument.get(key) ?? { symbol, currency: t.currency, net: 0, tax: 0 };
          bucket.net += net;
          bucket.tax += Number(t.tax ?? 0);
          byInstrument.set(key, bucket);
        }
        const dividendRows: TaxDividendRow[] = [...byInstrument.values()].map((b) => ({
          symbol: b.symbol,
          currency: b.currency,
          gross: (b.net + b.tax).toFixed(2),
          tax: b.tax.toFixed(2),
          net: b.net.toFixed(2),
        }));
        const totalsByCurrencyMap = new Map<string, { gross: number; tax: number; net: number }>();
        for (const r of dividendRows) {
          const t = totalsByCurrencyMap.get(r.currency) ?? { gross: 0, tax: 0, net: 0 };
          t.gross += Number(r.gross);
          t.tax += Number(r.tax);
          t.net += Number(r.net);
          totalsByCurrencyMap.set(r.currency, t);
        }
        const dividendTotalsByCurrency: TaxCurrencyTotal[] = [...totalsByCurrencyMap.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([currency, t]) => ({
            currency,
            gross: t.gross.toFixed(2),
            tax: t.tax.toFixed(2),
            net: t.net.toFixed(2),
          }));

        const taxRate = Number(entry.allowanceUsage.taxRate);
        const allowanceAnnual = Number(entry.allowanceUsage.allowanceAnnual);
        const years = new Set<number>([
          ...tradeLog.realizedByYear.map((r) => r.year),
          ...tradeLog.dividendsByYear.map((d) => d.year),
        ]);
        const byYear: TaxYearRow[] = [...years]
          .sort((a, b) => b - a)
          .map((y) => {
            if (y === entry.year) {
              const u = entry.allowanceUsage;
              const taxable = Number(u.taxableExcess);
              return {
                year: y,
                realized: u.realizedGainsAdjusted,
                dividends: u.incomeYtd,
                tax: (taxable * taxRate).toFixed(2),
                fsaUsed: u.usedYtd,
              };
            }

            const realized = tradeLog.realizedByYear.find((r) => r.year === y)?.amount ?? "0";
            const divEntry = tradeLog.dividendsByYear.find((d) => d.year === y);
            const dividendsGross = divEntry ? Number(divEntry.amount) + Number(divEntry.tax) : 0;
            const taxable = Math.max(0, Number(realized) + dividendsGross - allowanceAnnual);
            const fsaUsed = Math.min(
              allowanceAnnual,
              Math.max(0, Number(realized) + dividendsGross),
            );
            return {
              year: y,
              realized,
              dividends: dividendsGross.toFixed(2),
              tax: (taxable * taxRate).toFixed(2),
              fsaUsed: fsaUsed.toFixed(2),
            };
          });

        const proceedsByYearMap = new Map<number, number>();
        for (const t of tradeLog.trades) {
          for (const l of t.legs) {
            proceedsByYearMap.set(
              l.taxYear,
              (proceedsByYearMap.get(l.taxYear) ?? 0) + Number(l.proceeds),
            );
          }
        }
        const idYears = new Set<number>([
          ...proceedsByYearMap.keys(),
          ...tradeLog.dividendsByYear.map((d) => d.year),
          ...tradeLog.realizedByYear.map((r) => r.year),
        ]);
        const idByYear: IdYearInput[] = [...idYears].map((y) => {
          const divEntry = tradeLog.dividendsByYear.find((d) => d.year === y);
          const dividendGross = divEntry ? Number(divEntry.amount) + Number(divEntry.tax) : 0;
          const realized = tradeLog.realizedByYear.find((r) => r.year === y)?.amount ?? "0";
          return {
            year: y,
            proceeds: (proceedsByYearMap.get(y) ?? 0).toFixed(2),
            dividendGross: dividendGross.toFixed(2),
            realized,
          };
        });

        result.set(holderId, {
          currency: tradeLog.displayCurrency,
          disposals: legs,
          totalProceeds: totalProceeds.toFixed(2),
          totalGain: totalGain.toFixed(2),
          dividendRows,
          dividendTotalsByCurrency,
          byYear,
          idByYear,
        });
      } catch {
        // Best-effort per holder
      }
    }),
  );

  return result;
}
