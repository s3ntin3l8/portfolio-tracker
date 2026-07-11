import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import messages from "../messages/en.json";
import {
  EstimatedTaxHero,
  DividendsTable,
  ByYearTable,
  AllowanceSummaryBoxes,
  DistributionCard,
  HarvestRow,
  HarvestSummaryNote,
  IdDividendsTable,
  IdByYearTable,
  type TaxTranslator,
} from "../src/components/tax/tax-cards";
import type { HarvestSuggestion, TaxDistribution } from "@portfolio/api-client";

// These components take `t` as a directly-injected prop (the page's established
// pattern — see apps/web/src/app/[locale]/(app)/tax/page.tsx), not via `useTranslations`,
// so no NextIntlClientProvider is needed. This stub reads the real `Tax` namespace from
// en.json with basic `{key}` interpolation, so assertions exercise real copy.
function makeT(): TaxTranslator {
  const tax = messages.Tax as unknown as Record<string, unknown>;
  return (key, values) => {
    let val: unknown = tax;
    for (const part of key.split(".")) {
      val = (val as Record<string, unknown> | undefined)?.[part];
    }
    if (typeof val !== "string") return key;
    if (!values) return val;
    return val.replace(/\{(\w+)\}/g, (_, k: string) =>
      values[k] !== undefined ? String(values[k]) : `{${k}}`,
    );
  };
}

const money = (n: string | number) => `Rp ${Number(n).toLocaleString("en")}`;
const t = makeT();

describe("EstimatedTaxHero", () => {
  it("renders the label, value, and description", () => {
    render(
      <EstimatedTaxHero
        label="Estimated tax · 2026"
        value="Rp 140,580"
        description="Abgeltungsteuer 25% on Rp 562,320"
      />,
    );
    expect(screen.getByText("Estimated tax · 2026")).toBeInTheDocument();
    expect(screen.getByText("Rp 140,580")).toBeInTheDocument();
    expect(screen.getByText("Abgeltungsteuer 25% on Rp 562,320")).toBeInTheDocument();
  });
});

describe("DividendsTable", () => {
  it("renders gross/tax/net per source, in the source's own currency, plus a total row", () => {
    render(
      <DividendsTable
        rows={[{ symbol: "SAP", currency: "EUR", gross: "168", tax: "35", net: "133" }]}
        totalsByCurrency={[{ currency: "EUR", gross: "168", tax: "35", net: "133" }]}
        locale="en"
        t={t}
      />,
    );
    expect(screen.getByText("SAP")).toBeInTheDocument();
    expect(screen.getAllByText("€168.00").length).toBeGreaterThan(0);
    expect(screen.getAllByText("€35.00").length).toBeGreaterThan(0);
    expect(screen.getAllByText("€133.00").length).toBeGreaterThan(0);
  });

  it("joins multi-currency totals instead of summing across currencies", () => {
    render(
      <DividendsTable
        rows={[
          { symbol: "SAP", currency: "EUR", gross: "168", tax: "35", net: "133" },
          { symbol: "NVDA", currency: "USD", gross: "100", tax: "20", net: "80" },
        ]}
        totalsByCurrency={[
          { currency: "EUR", gross: "168", tax: "35", net: "133" },
          { currency: "USD", gross: "100", tax: "20", net: "80" },
        ]}
        locale="en"
        t={t}
      />,
    );
    // Each row renders in its OWN currency, not a shared/converted one.
    expect(screen.getByText("€168.00")).toBeInTheDocument();
    expect(screen.getByText("$100.00")).toBeInTheDocument();
    // The total row joins per-currency amounts rather than summing raw numbers.
    expect(screen.getByText("€168.00 · $100.00")).toBeInTheDocument();
  });

  it("renders the empty state when there's no dividend income", () => {
    render(<DividendsTable rows={[]} totalsByCurrency={[]} locale="en" t={t} />);
    expect(screen.getByText(/No dividend\/interest income/)).toBeInTheDocument();
  });
});

describe("ByYearTable", () => {
  it("renders newest-first rows with realized/dividends/FSA used/tax columns", () => {
    render(
      <ByYearTable
        rows={[
          { year: 2026, realized: "240", dividends: "168", fsaUsed: "408.00", tax: "0.00" },
          { year: 2025, realized: "100", dividends: "227", fsaUsed: "327.00", tax: "0.00" },
        ]}
        money={money}
        t={t}
      />,
    );
    const years = screen.getAllByText(/^(2026|2025)$/).map((el) => el.textContent);
    expect(years).toEqual(["2026", "2025"]);
    expect(screen.getByText("FSA used")).toBeInTheDocument();
    expect(screen.getByText("Rp 408")).toBeInTheDocument();
    expect(screen.getByText("Rp 327")).toBeInTheDocument();
  });

  it("renders nothing when there are no years", () => {
    const { container } = render(<ByYearTable rows={[]} money={money} t={t} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("AllowanceSummaryBoxes", () => {
  it("shows the allowance-left progress, its tax-saving-available figure, and taxable-gains", () => {
    render(
      <AllowanceSummaryBoxes
        usedPct={41}
        allowanceAnnual="1000"
        usedYtd="408"
        remaining="592"
        taxSavingAvailable="148"
        taxable="0"
        estimatedTax="0"
        money={money}
        t={t}
      />,
    );
    expect(screen.getByText("Allowance left")).toBeInTheDocument();
    expect(screen.getByText("Rp 592")).toBeInTheDocument();
    expect(screen.getByText("Taxable gains YTD")).toBeInTheDocument();
    expect(screen.getByText(/Rp 408 of Rp 1,000 used/)).toBeInTheDocument();
    // The "Tax saving available" figure — carried over from the old 3-up StatCard row so
    // it isn't lost by the 2-box relayout.
    expect(screen.getByText(/Tax saving available: Rp 148/)).toBeInTheDocument();
  });
});

describe("DistributionCard", () => {
  const distribution: TaxDistribution = {
    holderAllowanceCap: "1000",
    totalAllocated: "1000",
    remainingToDistribute: "0",
    overAllocated: false,
  };

  it("renders the cap/allocated/remaining figures", () => {
    render(<DistributionCard distribution={distribution} money={money} t={t} />);
    expect(screen.getByText("FSA distribution across depots")).toBeInTheDocument();
    expect(screen.getAllByText("Rp 1,000").length).toBeGreaterThan(0);
  });

  it("flags over-allocation with a warning banner", () => {
    render(
      <DistributionCard
        distribution={{ ...distribution, totalAllocated: "1200", overAllocated: true }}
        money={money}
        t={t}
      />,
    );
    expect(screen.getByText(/exceeds the personal cap/)).toBeInTheDocument();
  });
});

describe("HarvestRow", () => {
  const suggestion: HarvestSuggestion = {
    instrumentId: "i-nio",
    unrealizedGross: "-184",
    tfRate: "0.3",
    unrealizedAdjusted: "-128.8",
    harvestableGross: "184",
    taxSaving: "49",
    instrument: { symbol: "NIO", name: "NIO Inc.", assetClass: "equity", market: "US" },
  };

  it("renders the harvest button linking to the prefilled sell draft", () => {
    render(<HarvestRow s={suggestion} money={money} t={t} />);
    expect(screen.getByText("NIO Inc.")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Harvest" });
    expect(link).toHaveAttribute("href", "/transactions/new?harvestInstrument=i-nio");
  });

  it("shows the Teilfreistellung note when a TF rate applies", () => {
    render(<HarvestRow s={suggestion} money={money} t={t} />);
    // The TF note is now folded into the row's single meta line.
    expect(screen.getByText(/TF 30% applied/)).toBeInTheDocument();
  });
});

describe("HarvestSummaryNote", () => {
  const amd: HarvestSuggestion = {
    instrumentId: "i1",
    unrealizedGross: "3360.35",
    tfRate: "0",
    unrealizedAdjusted: "3360.35",
    harvestableGross: "148.46",
    taxSaving: "37.12",
    instrument: { symbol: "AMD", name: "AMD Inc.", assetClass: "equity", market: "US" },
  };
  const msft: HarvestSuggestion = {
    instrumentId: "i2",
    unrealizedGross: "-96",
    tfRate: "0",
    unrealizedAdjusted: "-96",
    harvestableGross: "96",
    taxSaving: "25",
    instrument: { symbol: "MSFT", name: "Microsoft Corp.", assetClass: "equity", market: "US" },
  };
  const googl: HarvestSuggestion = {
    instrumentId: "i3",
    unrealizedGross: "50",
    tfRate: "0",
    unrealizedAdjusted: "50",
    harvestableGross: "50",
    taxSaving: "12",
    instrument: { symbol: "GOOGL", name: "Alphabet Inc.", assetClass: "equity", market: "US" },
  };

  it("names only the position(s) actually in the plan — not every listed suggestion (the reported bug)", () => {
    // 3 suggestions listed, but the plan only needed AMD — reproduces the live scenario
    // that prompted this fix: the old copy said "Harvest all 3" even though 2 of them
    // (MSFT, GOOGL) were never touched.
    render(
      <HarvestSummaryNote
        suggestions={[amd, msft, googl]}
        combined={{
          positionsUsed: 1,
          combinedHarvestableGross: "148.46",
          combinedTaxSaving: "37.12",
          plan: [{ instrumentId: "i1", grossTake: "148.46", adjustedTake: "148.46" }],
        }}
        money={money}
        t={t}
      />,
    );
    expect(screen.getByText(/Sell part of AMD/)).toBeInTheDocument();
    expect(screen.getByText(/Rp 148/)).toBeInTheDocument();
    expect(screen.getByText(/Rp 37/)).toBeInTheDocument();
    // The other two positions are named as untouched, not folded into the plan.
    expect(screen.getByText(/other 2 positions/)).toBeInTheDocument();
    expect(screen.queryByText(/MSFT/)).toBeNull();
    expect(screen.queryByText(/GOOGL/)).toBeNull();
    expect(screen.queryByText(/Harvest all/)).toBeNull();
  });

  it("uses the 'harvest all' phrasing when every listed suggestion is actually in the plan", () => {
    render(
      <HarvestSummaryNote
        suggestions={[amd, msft]}
        combined={{
          positionsUsed: 2,
          combinedHarvestableGross: "280",
          combinedTaxSaving: "74",
          plan: [
            { instrumentId: "i1", grossTake: "184", adjustedTake: "184" },
            { instrumentId: "i2", grossTake: "96", adjustedTake: "96" },
          ],
        }}
        money={money}
        t={t}
      />,
    );
    expect(screen.getByText(/Harvest all 2 positions \(AMD, MSFT\)/)).toBeInTheDocument();
    expect(screen.getByText(/Rp 280/)).toBeInTheDocument();
    expect(screen.getByText(/Rp 74/)).toBeInTheDocument();
    expect(screen.queryByText(/Sell part of/)).toBeNull();
  });

  it("renders nothing when there's nothing harvestable", () => {
    const { container } = render(
      <HarvestSummaryNote
        suggestions={[
          {
            instrumentId: "i1",
            unrealizedGross: "0",
            tfRate: "0",
            unrealizedAdjusted: "0",
            harvestableGross: "0",
            taxSaving: "0",
            instrument: null,
          },
        ]}
        combined={{ positionsUsed: 0, combinedHarvestableGross: "0", combinedTaxSaving: "0", plan: [] }}
        money={money}
        t={t}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

// ---------------------------------------------------------------------------
// Indonesian final-tax components
// ---------------------------------------------------------------------------
// IdSalesTable now lives in ./disposal-table.tsx alongside its German counterpart
// DisposalTable — see disposal-table.test.tsx for both.

describe("IdDividendsTable", () => {
  it("renders gross/tax(10%)/net per source plus a total row", () => {
    render(
      <IdDividendsTable
        rows={[
          { symbol: "BBCA", currency: "IDR", gross: "420000", tax: "42000.00", net: "378000.00" },
        ]}
        totalDividendGross="420000"
        totalDividendTax="42000.00"
        totalDividendNet="378000.00"
        money={money}
        t={t}
      />,
    );
    expect(screen.getByText("BBCA")).toBeInTheDocument();
    expect(screen.getAllByText("Rp 420,000").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Rp 42,000").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Rp 378,000").length).toBeGreaterThan(0);
    expect(screen.getByText("Dividends & coupons · 10% final")).toBeInTheDocument();
  });

  it("renders the empty state when there's no dividend/coupon income", () => {
    render(
      <IdDividendsTable
        rows={[]}
        totalDividendGross="0"
        totalDividendTax="0"
        totalDividendNet="0"
        money={money}
        t={t}
      />,
    );
    expect(screen.getByText(/No dividend\/coupon income/)).toBeInTheDocument();
  });
});

describe("IdByYearTable", () => {
  it("renders every year's Est. tax column, not just the current year", () => {
    render(
      <IdByYearTable
        rows={[
          { year: 2026, realized: "324000", dividends: "1284000", tax: "128724.00" },
          { year: 2025, realized: "1940000", dividends: "2110000", tax: "212940.00" },
        ]}
        money={money}
        t={t}
      />,
    );
    const years = screen.getAllByText(/^(2026|2025)$/).map((el) => el.textContent);
    expect(years).toEqual(["2026", "2025"]);
    expect(screen.getByText("Rp 128,724")).toBeInTheDocument();
    expect(screen.getByText("Rp 212,940")).toBeInTheDocument();
  });

  it("renders nothing when there are no years", () => {
    const { container } = render(<IdByYearTable rows={[]} money={money} t={t} />);
    expect(container).toBeEmptyDOMElement();
  });
});
