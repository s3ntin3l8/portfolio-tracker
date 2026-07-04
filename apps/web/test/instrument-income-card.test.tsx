import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { InstrumentIncomeCard } from "../src/components/instrument-income-card";

describe("InstrumentIncomeCard", () => {
  it("renders the lifetime figure, caption, and yield-on-cost mini-stat", () => {
    render(
      <InstrumentIncomeCard
        title="Income from this position"
        dividendsReceived="Rp 972.000"
        receivedCaption="received · lifetime"
        emptyMessage="No income recorded for this position yet."
        yieldOnCost="+4.20%"
        yieldTitle="Yield on cost"
        yieldCaption="vs current market yield"
      />,
    );
    expect(screen.getByText("Income from this position")).toBeInTheDocument();
    expect(screen.getByText("Rp 972.000")).toBeInTheDocument();
    expect(screen.getByText("received · lifetime")).toBeInTheDocument();
    expect(screen.getByText("Yield on cost")).toBeInTheDocument();
    expect(screen.getByText("vs current market yield")).toBeInTheDocument();
    expect(screen.getByText("+4.20%")).toBeInTheDocument();
  });

  it("omits the yield-on-cost row when it isn't computable", () => {
    render(
      <InstrumentIncomeCard
        title="Income from this position"
        dividendsReceived="Rp 972.000"
        receivedCaption="received · lifetime"
        emptyMessage="No income recorded for this position yet."
        yieldOnCost={null}
        yieldTitle="Yield on cost"
        yieldCaption="vs current market yield"
      />,
    );
    expect(screen.queryByText("Yield on cost")).toBeNull();
  });

  it("shows the empty message when there's no income at all", () => {
    render(
      <InstrumentIncomeCard
        title="Income from this position"
        dividendsReceived={null}
        receivedCaption="received · lifetime"
        emptyMessage="No income recorded for this position yet."
        yieldOnCost={null}
        yieldTitle="Yield on cost"
        yieldCaption="vs current market yield"
      />,
    );
    expect(screen.getByText("No income recorded for this position yet.")).toBeInTheDocument();
    expect(screen.queryByText("received · lifetime")).toBeNull();
  });
});
