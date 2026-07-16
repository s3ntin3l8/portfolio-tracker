import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import type { CorporateAction } from "@portfolio/api-client";

const refresh = vi.fn();
const updateCorporateAction = vi.fn(
  async (id: string, input: Partial<CorporateAction>) =>
    ({
      id,
      instrumentId: "i1",
      type: "split",
      ratio: "3",
      exDate: "2026-02-01",
      terms: null,
      ...input,
    }) as never,
);
const deleteCorporateAction = vi.fn(async () => undefined);

vi.mock("@/i18n/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/api", () => ({
  useApiClient: () => ({ updateCorporateAction, deleteCorporateAction }),
}));

import { CorporateActionsManager } from "../src/components/corporate-actions-manager";

const m = messages.CorpAction;

const items: CorporateAction[] = [
  {
    id: "ca1",
    instrumentId: "i1",
    type: "split",
    ratio: "2",
    exDate: "2026-02-01",
    terms: null,
  },
];

const multiItems: CorporateAction[] = [
  {
    id: "ca1",
    instrumentId: "i1",
    type: "split",
    ratio: "2",
    exDate: "2026-03-01",
    terms: null,
  },
  {
    id: "ca2",
    instrumentId: "i1",
    type: "bonus",
    ratio: "10",
    exDate: "2026-01-01",
    terms: null,
  },
];

function renderManager(initial = items) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <CorporateActionsManager items={initial} />
    </NextIntlClientProvider>,
  );
}

describe("CorporateActionsManager", () => {
  beforeEach(() => {
    refresh.mockClear();
    updateCorporateAction.mockClear();
    deleteCorporateAction.mockClear();
  });

  it("shows the empty message when there are no actions", () => {
    renderManager([]);
    expect(screen.getByText(messages.Instrument.noCorporateActions)).toBeInTheDocument();
  });

  it("edits a corporate action's ratio", async () => {
    renderManager();
    fireEvent.click(screen.getByRole("button", { name: m.edit }));
    fireEvent.change(screen.getByLabelText(m.ratio), {
      target: { value: "3" },
    });
    fireEvent.click(screen.getByRole("button", { name: m.save }));

    await waitFor(() => expect(updateCorporateAction).toHaveBeenCalled());
    expect(updateCorporateAction).toHaveBeenCalledWith(
      "ca1",
      expect.objectContaining({ ratio: "3", type: "split" }),
    );
    expect(refresh).toHaveBeenCalled();
  });

  it("deletes only after the two-step confirm", async () => {
    renderManager();
    fireEvent.click(screen.getByRole("button", { name: m.delete }));
    expect(deleteCorporateAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: m.delete }));
    await waitFor(() => expect(deleteCorporateAction).toHaveBeenCalledWith("ca1"));
    expect(refresh).toHaveBeenCalled();
  });

  it("renders a table with sortable headers when there are items", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <CorporateActionsManager items={multiItems} />
      </NextIntlClientProvider>,
    );
    // Should render Type, Ratio, Ex-date headers as sort buttons
    expect(screen.getByRole("button", { name: /type/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ratio/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ex.date/i })).toBeInTheDocument();
  });

  it("sorts corporate actions by ex-date ascending when clicked", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <CorporateActionsManager items={multiItems} />
      </NextIntlClientProvider>,
    );
    // Default order: ca1 (split, Mar), ca2 (bonus, Jan)
    const rowsBefore = screen.getAllByRole("row").slice(1);
    // The first row has the first item — split
    expect(rowsBefore[0]).toHaveTextContent("2");

    fireEvent.click(screen.getByRole("button", { name: /ex.date/i }));
    const rowsAfter = screen.getAllByRole("row").slice(1);
    // After asc sort by exDate: ca2 (Jan) first, then ca1 (Mar)
    expect(rowsAfter[0]).toHaveTextContent("10");
    expect(rowsAfter[1]).toHaveTextContent("2");
  });

  it("sorts corporate actions by ratio numerically", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <CorporateActionsManager items={multiItems} />
      </NextIntlClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /ratio/i }));
    const rows = screen.getAllByRole("row").slice(1);
    // asc: ratio 2 (split) first, then 10 (bonus)
    expect(rows[0]).toHaveTextContent("2");
    expect(rows[1]).toHaveTextContent("10");
  });
});
