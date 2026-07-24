import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { AccountHolder } from "@portfolio/api-client";
import messages from "../messages/en.json";

const push = vi.fn();
const refresh = vi.fn();
const createAccountHolder = vi.fn(async () => ({}) as never);
const updateAccountHolder = vi.fn(async () => ({}) as never);
const deleteAccountHolder = vi.fn(async () => undefined);

vi.mock("@/i18n/navigation", () => ({ useRouter: () => ({ push, refresh }) }));
vi.mock("@/lib/api", () => ({
  useApiClient: () => ({ createAccountHolder, updateAccountHolder, deleteAccountHolder }),
}));

import { HolderEditForm } from "../src/components/holder-edit-form";

const m = messages.AccountHolders;
const mf = messages.PortfolioForm;

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

function renderForm(props: Partial<React.ComponentProps<typeof HolderEditForm>> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <HolderEditForm mode="create" {...props} />
    </NextIntlClientProvider>,
  );
}

describe("HolderEditForm", () => {
  beforeEach(() => {
    push.mockClear();
    refresh.mockClear();
    createAccountHolder.mockClear();
    updateAccountHolder.mockClear();
    deleteAccountHolder.mockClear();
  });

  it("renders the DETAILS and tax profile cards", () => {
    renderForm();
    expect(screen.getByText(m.detailsSection)).toBeInTheDocument();
    expect(screen.getByText(m.taxProfileSection)).toBeInTheDocument();
  });

  it("creates a new child holder with a birth year, then navigates back to the list", async () => {
    renderForm();

    fireEvent.change(screen.getByLabelText(mf.holderName), { target: { value: "Luca" } });
    fireEvent.click(screen.getByRole("radio", { name: mf.holderTypeChild }));
    fireEvent.change(screen.getByLabelText(mf.birthYear), { target: { value: "2019" } });
    fireEvent.click(screen.getByRole("button", { name: m.add }));

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
    await waitFor(() => expect(push).toHaveBeenCalledWith("/settings/portfolios"));
  });

  it("edits an existing holder, prefilled from the `holder` prop", async () => {
    renderForm({ mode: "edit", holder: emma });
    expect(screen.getByDisplayValue("Emma")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(mf.holderName), { target: { value: "Emma R." } });
    fireEvent.click(screen.getByRole("button", { name: mf.save }));

    await waitFor(() =>
      expect(updateAccountHolder).toHaveBeenCalledWith(
        "h1",
        expect.objectContaining({ name: "Emma R." }),
      ),
    );
    await waitFor(() => expect(push).toHaveBeenCalledWith("/settings/portfolios"));
  });

  it("deletes a holder only after the two-step confirm", async () => {
    renderForm({ mode: "edit", holder: emma });

    fireEvent.click(screen.getByRole("button", { name: m.delete }));
    expect(deleteAccountHolder).not.toHaveBeenCalled();
    expect(screen.getByText(m.deleteWarning)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: m.confirmDelete }));
    await waitFor(() => expect(deleteAccountHolder).toHaveBeenCalledWith("h1"));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/settings/portfolios"));
  });

  it("does not show a delete action in create mode", () => {
    renderForm();
    expect(screen.queryByRole("button", { name: m.delete })).not.toBeInTheDocument();
  });
});
