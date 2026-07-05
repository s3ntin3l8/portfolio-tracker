import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { AccountHolder } from "@portfolio/api-client";
import messages from "../messages/en.json";

const refresh = vi.fn();
const createAccountHolder = vi.fn(async () => ({}) as never);
const updateAccountHolder = vi.fn(async () => ({}) as never);
const deleteAccountHolder = vi.fn(async () => undefined);

vi.mock("@/i18n/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/api", () => ({
  useApiClient: () => ({ createAccountHolder, updateAccountHolder, deleteAccountHolder }),
}));

import { AccountHoldersManager } from "../src/components/account-holders-manager";

const m = messages.AccountHolders;
const mf = messages.PortfolioForm;

function renderManager(holders: AccountHolder[] = []) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AccountHoldersManager holders={holders} />
    </NextIntlClientProvider>,
  );
}

const emma: AccountHolder = {
  id: "h1",
  userId: "u1",
  name: "Emma",
  type: "child",
  birthYear: 2017,
  taxAllowanceAnnual: null,
  capitalGainsTaxRate: null,
  churchTax: null,
  taxResidence: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("AccountHoldersManager", () => {
  beforeEach(() => {
    refresh.mockClear();
    createAccountHolder.mockClear();
    updateAccountHolder.mockClear();
    deleteAccountHolder.mockClear();
  });

  it("shows the empty state when there are no holders", () => {
    renderManager();
    expect(screen.getByText(m.empty)).toBeInTheDocument();
  });

  it("lists existing holders with their type and birth year", () => {
    renderManager([emma]);
    expect(screen.getByText("Emma")).toBeInTheDocument();
    expect(screen.getByText(`${mf.holderTypeChild} · 2017`)).toBeInTheDocument();
  });

  it("creates a new child holder with a birth year", async () => {
    renderManager();
    fireEvent.click(screen.getByRole("button", { name: m.add }));

    fireEvent.change(screen.getByLabelText(mf.holderName), { target: { value: "Luca" } });
    fireEvent.click(screen.getByRole("radio", { name: mf.holderTypeChild }));
    fireEvent.change(screen.getByLabelText(mf.birthYear), { target: { value: "2019" } });
    // The dialog's submit button is the only one labelled with the add text.
    fireEvent.click(screen.getAllByRole("button", { name: m.add }).at(-1)!);

    await waitFor(() =>
      expect(createAccountHolder).toHaveBeenCalledWith({
        name: "Luca",
        type: "child",
        birthYear: 2019,
        taxAllowanceAnnual: null,
        capitalGainsTaxRate: null,
        churchTax: false,
        taxResidence: null,
      }),
    );
    expect(refresh).toHaveBeenCalled();
  });

  it("edits a holder via the ⋯ menu", async () => {
    renderManager([emma]);
    // Radix opens its menu on keyboard/pointer, not a synthetic click.
    fireEvent.keyDown(screen.getByRole("button", { name: "More options" }), { key: "Enter" });
    fireEvent.click(screen.getByRole("menuitem", { name: m.edit }));

    // The edit form opens prefilled; change the name and save.
    fireEvent.change(screen.getByLabelText(mf.holderName), { target: { value: "Emma R." } });
    fireEvent.click(screen.getByRole("button", { name: mf.save }));

    await waitFor(() =>
      expect(updateAccountHolder).toHaveBeenCalledWith(
        "h1",
        expect.objectContaining({ name: "Emma R." }),
      ),
    );
    expect(refresh).toHaveBeenCalled();
  });

  it("removes a holder from the edit modal after the two-step confirm", async () => {
    renderManager([emma]);
    fireEvent.keyDown(screen.getByRole("button", { name: "More options" }), { key: "Enter" });
    fireEvent.click(screen.getByRole("menuitem", { name: m.edit }));

    // The edit sheet carries its own "Delete holder" action (mirrors the portfolio sheet).
    fireEvent.click(screen.getByRole("button", { name: m.delete }));
    expect(deleteAccountHolder).not.toHaveBeenCalled();
    expect(screen.getByText(m.deleteWarning)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: m.confirmDelete }));
    await waitFor(() => expect(deleteAccountHolder).toHaveBeenCalledWith("h1"));
    expect(refresh).toHaveBeenCalled();
  });

  it("deletes a holder only after confirming in the modal", async () => {
    renderManager([emma]);
    fireEvent.keyDown(screen.getByRole("button", { name: "More options" }), { key: "Enter" });
    fireEvent.click(screen.getByRole("menuitem", { name: m.delete }));

    // The confirm modal is shown; nothing is deleted until the user confirms.
    expect(deleteAccountHolder).not.toHaveBeenCalled();
    expect(screen.getByText(m.deleteWarning)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: m.confirmDelete }));
    await waitFor(() => expect(deleteAccountHolder).toHaveBeenCalledWith("h1"));
    expect(refresh).toHaveBeenCalled();
  });
});
