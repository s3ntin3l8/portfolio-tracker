import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import messages from "../messages/en.json";
import {
  EstimatedTaxHero,
  DisposalTable,
  DividendsTable,
  ByYearTable,
  AllowanceSummaryBoxes,
  DistributionCard,
  HarvestRow,
  HarvestSummaryNote,
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

describe("DisposalTable", () => {
  it("renders one row per disposal plus a total row", () => {
    render(
      <DisposalTable
        rows={[
          { symbol: "NVDA", when: "2026-03-12", proceeds: "1240", gain: "430" },
          { symbol: "SAP", when: "2026-06-19", proceeds: "980", gain: "270" },
        ]}
        totalProceeds="2220"
        totalGain="700"
        money={money}
        t={t}
      />,
    );
    expect(screen.getByText("NVDA")).toBeInTheDocument();
    expect(screen.getByText("2026-03-12")).toBeInTheDocument();
    expect(screen.getByText("Rp 1,240")).toBeInTheDocument();
    expect(screen.getByText("SAP")).toBeInTheDocument();
    expect(screen.getByText("Total")).toBeInTheDocument();
    expect(screen.getByText("Rp 2,220")).toBeInTheDocument();
    expect(screen.getByText("Rp 700")).toBeInTheDocument();
    // Flags that this table is gross/pre-Teilfreistellung, unlike the Tf-adjusted hero card.
    expect(screen.getByText(/before Teilfreistellung/)).toBeInTheDocument();
  });

  it("renders the empty state when there are no disposals", () => {
    render(<DisposalTable rows={[]} totalProceeds="0" totalGain="0" money={money} t={t} />);
    expect(screen.getByText(/No disposals/)).toBeInTheDocument();
    expect(screen.queryByText("Total")).not.toBeInTheDocument();
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
  it("renders newest-first rows with realized/dividends/tax columns", () => {
    render(
      <ByYearTable
        rows={[
          { year: 2026, realized: "240", dividends: "168", tax: "0.00" },
          { year: 2025, realized: "100", dividends: "227", tax: "0.00" },
        ]}
        money={money}
        t={t}
      />,
    );
    const years = screen.getAllByText(/^(2026|2025)$/).map((el) => el.textContent);
    expect(years).toEqual(["2026", "2025"]);
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
    expect(screen.getByText("NIO")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Harvest" });
    expect(link).toHaveAttribute("href", "/transactions/new?harvestInstrument=i-nio");
  });

  it("shows the Teilfreistellung note when a TF rate applies", () => {
    render(<HarvestRow s={suggestion} money={money} t={t} />);
    expect(screen.getByText("TF 30% applied")).toBeInTheDocument();
  });
});

describe("HarvestSummaryNote", () => {
  it("aggregates every suggestion into one sentence", () => {
    const suggestions: HarvestSuggestion[] = [
      {
        instrumentId: "i1",
        unrealizedGross: "-184",
        tfRate: "0",
        unrealizedAdjusted: "-184",
        harvestableGross: "184",
        taxSaving: "49",
        instrument: null,
      },
      {
        instrumentId: "i2",
        unrealizedGross: "-96",
        tfRate: "0",
        unrealizedAdjusted: "-96",
        harvestableGross: "96",
        taxSaving: "25",
        instrument: null,
      },
    ];
    render(<HarvestSummaryNote suggestions={suggestions} money={money} t={t} />);
    expect(screen.getByText(/Harvest all 2/)).toBeInTheDocument();
    expect(screen.getByText(/Rp 280/)).toBeInTheDocument();
    expect(screen.getByText(/Rp 74/)).toBeInTheDocument();
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
        money={money}
        t={t}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
