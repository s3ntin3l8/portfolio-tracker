import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import type { CorporateAction } from "@portfolio/api-client";

const refresh = vi.fn();
const updateCorporateAction = vi.fn(
  async (id: string, input: Partial<CorporateAction>) =>
    ({ id, instrumentId: "i1", type: "split", ratio: "3", exDate: "2026-02-01", terms: null, ...input }) as never,
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
    expect(
      screen.getByText(messages.Instrument.noCorporateActions),
    ).toBeInTheDocument();
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
    await waitFor(() =>
      expect(deleteCorporateAction).toHaveBeenCalledWith("ca1"),
    );
    expect(refresh).toHaveBeenCalled();
  });
});
