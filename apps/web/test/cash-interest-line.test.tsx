import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { CashInterestLine } from "../src/components/income/cash-interest-line";

describe("CashInterestLine", () => {
  it("renders the label and all three formatted amounts", () => {
    render(
      <CashInterestLine
        label="Cash interest"
        ytdLabel="This year"
        ttmLabel="TTM"
        lifetimeLabel="Lifetime"
        ytd="€33.04"
        ttm="€33.04"
        lifetime="€120.50"
      />,
    );

    expect(screen.getByText("Cash interest")).toBeInTheDocument();
    expect(screen.getAllByText("€33.04")).toHaveLength(2); // ytd and ttm are equal here
    expect(screen.getByText("€120.50")).toBeInTheDocument();
    expect(screen.getByText(/This year/)).toBeInTheDocument();
    expect(screen.getByText(/TTM/)).toBeInTheDocument();
    expect(screen.getByText(/Lifetime/)).toBeInTheDocument();
  });
});
