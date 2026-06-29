import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { ImportFilesTable } from "../src/components/import-files-table";
import messages from "../messages/en.json";

const PORTFOLIOS = [
  { id: "p1", name: "Main", brokerage: null, accountHolder: null },
  { id: "p2", name: "DKB", brokerage: "DKB", accountHolder: null },
];

const GROUPS = [
  { importId: "imp-a", filename: "broker-a.csv" },
  { importId: "imp-b", filename: "broker-b.csv" },
];

function renderTable(overrides: Partial<Parameters<typeof ImportFilesTable>[0]> = {}) {
  const onPortfolioChange = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ImportFilesTable
        groups={GROUPS}
        portfolios={PORTFOLIOS}
        portfolioByImport={new Map([["imp-a", "p1"], ["imp-b", "p1"]])}
        matchedImports={new Set(["imp-a"])}
        countByImport={(iid) => (iid === "imp-a" ? 3 : 5)}
        issueCountByImport={() => 0}
        onPortfolioChange={onPortfolioChange}
        {...overrides}
      />
    </NextIntlClientProvider>,
  );
  return { onPortfolioChange };
}

describe("ImportFilesTable", () => {
  it("renders one row per file with filename and count", () => {
    renderTable();
    expect(screen.getByText("broker-a.csv")).toBeInTheDocument();
    expect(screen.getByText("broker-b.csv")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  it("shows the auto-detected badge only for matched imports", () => {
    renderTable();
    // imp-a is matched; imp-b is not — exactly one badge.
    const badges = screen.getAllByText(messages.Import.confirmPortfolio.autoDetected);
    expect(badges).toHaveLength(1);
  });

  it("a per-row picker change calls onPortfolioChange for that import only", () => {
    const { onPortfolioChange } = renderTable();
    // Each row has an "Import into" picker; open the first and choose DKB.
    const pickers = screen.getAllByRole("button", {
      name: messages.Import.confirmPortfolio.importInto,
    });
    fireEvent.keyDown(pickers[0], { key: "Enter" });
    fireEvent.click(screen.getByRole("menuitem", { name: /DKB/ }));
    expect(onPortfolioChange).toHaveBeenCalledWith("imp-a", "p2");
    expect(onPortfolioChange).toHaveBeenCalledTimes(1);
  });

  it("select-all + bulk assign applies the choice to every selected import", () => {
    const { onPortfolioChange } = renderTable();
    fireEvent.click(
      screen.getByRole("checkbox", { name: messages.Import.confirmPortfolio.selectAll }),
    );
    // The bulk toolbar appears with an assign picker.
    const assign = screen.getByRole("button", {
      name: messages.Import.confirmPortfolio.assignSelected,
    });
    fireEvent.keyDown(assign, { key: "Enter" });
    // The open menu belongs to the bulk picker; pick DKB.
    const menu = screen.getByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /DKB/ }));
    expect(onPortfolioChange).toHaveBeenCalledWith("imp-a", "p2");
    expect(onPortfolioChange).toHaveBeenCalledWith("imp-b", "p2");
  });

  it("hides the picker column and bulk toolbar when there is only one portfolio", () => {
    renderTable({ portfolios: [PORTFOLIOS[0]] });
    expect(
      screen.queryByRole("button", { name: messages.Import.confirmPortfolio.importInto }),
    ).not.toBeInTheDocument();
    // Selecting a row reveals no bulk-assign control (nothing to choose).
    fireEvent.click(
      screen.getByRole("checkbox", { name: messages.Import.confirmPortfolio.selectAll }),
    );
    expect(
      screen.queryByRole("button", { name: messages.Import.confirmPortfolio.assignSelected }),
    ).not.toBeInTheDocument();
  });
});
