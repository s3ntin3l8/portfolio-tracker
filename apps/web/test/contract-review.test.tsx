import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { ContractReview } from "../src/components/contract-review";
import type { ImportContract } from "../src/components/import-flow/types";
import messages from "../messages/en.json";

const CONTRACT: ImportContract = {
  provider: "GALERI24",
  contractNo: "C-123",
  currency: "IDR",
  grams: "50",
  goldName: "LM 50 Gram",
  purchasePrice: "80243000",
  downPayment: "12036450",
  adminFee: "50000",
  discount: "1250000",
  principal: "68206550",
  marginTotal: "8858832",
  tenorMonths: 12,
  monthlyInstallment: "6422116",
  startDate: "2025-02-13",
  costBasisMode: "purchase_price",
  schedule: Array.from({ length: 12 }, (_, i) => ({
    n: i + 1,
    dueDate: "2025-03-13",
    pokok: "5683880",
    sewaModal: "738236",
    angsuran: "6422116",
    sisaPokok: "0",
  })),
  confidence: 0.95,
};

function renderReview(props: Partial<React.ComponentProps<typeof ContractReview>> = {}) {
  const onUpdate = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ContractReview contracts={[CONTRACT]} onUpdate={onUpdate} {...props} />
    </NextIntlClientProvider>,
  );
  return { onUpdate };
}

describe("ContractReview", () => {
  it("renders the contract economics and the editable gram weight", () => {
    renderReview();
    expect(screen.getByText(messages.Import.contract.title)).toBeInTheDocument();
    expect(screen.getByText(/GALERI24/)).toBeInTheDocument();
    expect(screen.getByLabelText(messages.Import.contract.grams)).toHaveValue("50");
    // Purchase price is formatted as IDR currency (match digits, not the symbol/space).
    expect(screen.getByText(/80,243,000/)).toBeInTheDocument();
    // 12-installment schedule summary.
    expect(screen.getByText("12 installments")).toBeInTheDocument();
  });

  it("edits the gram weight via onUpdate", () => {
    const { onUpdate } = renderReview();
    fireEvent.change(screen.getByLabelText(messages.Import.contract.grams), {
      target: { value: "100" },
    });
    expect(onUpdate).toHaveBeenCalledWith(0, { grams: "100" });
  });

  it("confirms when it owns the action", () => {
    const onConfirm = vi.fn();
    renderReview({ onConfirm, onDiscard: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: messages.Import.contract.confirm }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it("discards when it owns the action", () => {
    const onDiscard = vi.fn();
    renderReview({ onConfirm: vi.fn(), onDiscard });
    fireEvent.click(screen.getByRole("button", { name: messages.Import.contract.discard }));
    expect(onDiscard).toHaveBeenCalled();
  });

  it("hides the confirm button when another step owns it", () => {
    renderReview();
    expect(
      screen.queryByRole("button", { name: messages.Import.contract.confirm }),
    ).not.toBeInTheDocument();
  });
});
