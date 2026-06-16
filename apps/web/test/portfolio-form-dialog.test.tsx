import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

const refresh = vi.fn();
const createPortfolio = vi.fn(async () => ({}) as never);
const updatePortfolio = vi.fn(async () => ({}) as never);
const deletePortfolio = vi.fn(async () => undefined);

vi.mock("@/i18n/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/api", () => ({
  useApiClient: () => ({ createPortfolio, updatePortfolio, deletePortfolio }),
}));

import { PortfolioFormDialog } from "../src/components/portfolio-form-dialog";
import { Button } from "../src/components/ui/button";

const m = messages.PortfolioForm;

function renderCreate() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PortfolioFormDialog mode="create" trigger={<Button>{m.new}</Button>} />
    </NextIntlClientProvider>,
  );
}

function renderEdit(
  portfolio = {
    id: "p1",
    name: "Main",
    baseCurrency: "IDR",
    portfolioType: "standard" as const,
    birthYear: null,
  },
) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PortfolioFormDialog
        mode="edit"
        portfolio={portfolio}
        trigger={<Button>{m.edit}</Button>}
      />
    </NextIntlClientProvider>,
  );
}

describe("PortfolioFormDialog", () => {
  beforeEach(() => {
    refresh.mockClear();
    createPortfolio.mockClear();
    updatePortfolio.mockClear();
    deletePortfolio.mockClear();
    document.cookie = "pf=; max-age=0; path=/";
  });

  it("creates a standard portfolio with the entered name and currency", async () => {
    renderCreate();
    fireEvent.click(screen.getByRole("button", { name: m.new }));

    fireEvent.change(screen.getByLabelText(m.name), { target: { value: "Stockbit" } });
    fireEvent.click(screen.getByRole("button", { name: m.create }));

    await waitFor(() => expect(createPortfolio).toHaveBeenCalled());
    expect(createPortfolio).toHaveBeenCalledWith({
      name: "Stockbit",
      baseCurrency: "IDR",
      portfolioType: "standard",
      birthYear: null,
    });
    expect(refresh).toHaveBeenCalled();
  });

  it("hides the birth-year field until the type is set to child", async () => {
    renderCreate();
    fireEvent.click(screen.getByRole("button", { name: m.new }));

    expect(screen.queryByLabelText(m.birthYear)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(m.type), { target: { value: "child" } });
    expect(screen.getByLabelText(m.birthYear)).toBeInTheDocument();
  });

  it("creates a child portfolio carrying its birth year", async () => {
    renderCreate();
    fireEvent.click(screen.getByRole("button", { name: m.new }));

    fireEvent.change(screen.getByLabelText(m.name), { target: { value: "Kid" } });
    fireEvent.change(screen.getByLabelText(m.type), { target: { value: "child" } });
    fireEvent.change(screen.getByLabelText(m.birthYear), { target: { value: "2017" } });
    fireEvent.click(screen.getByRole("button", { name: m.create }));

    await waitFor(() => expect(createPortfolio).toHaveBeenCalled());
    expect(createPortfolio).toHaveBeenCalledWith({
      name: "Kid",
      baseCurrency: "IDR",
      portfolioType: "child",
      birthYear: 2017,
    });
  });

  it("edits an existing portfolio via PATCH", async () => {
    renderEdit();
    fireEvent.click(screen.getByRole("button", { name: m.edit }));

    fireEvent.change(screen.getByLabelText(m.name), { target: { value: "Growth" } });
    fireEvent.click(screen.getByRole("button", { name: m.save }));

    await waitFor(() => expect(updatePortfolio).toHaveBeenCalled());
    expect(updatePortfolio).toHaveBeenCalledWith("p1", {
      name: "Growth",
      baseCurrency: "IDR",
      portfolioType: "standard",
      birthYear: null,
    });
    expect(refresh).toHaveBeenCalled();
  });

  it("deletes only after the two-step confirm", async () => {
    renderEdit();
    fireEvent.click(screen.getByRole("button", { name: m.edit }));

    fireEvent.click(screen.getByRole("button", { name: m.delete }));
    expect(deletePortfolio).not.toHaveBeenCalled();
    expect(screen.getByText(m.deleteWarning)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: m.confirmDelete }));
    await waitFor(() => expect(deletePortfolio).toHaveBeenCalledWith("p1"));
    expect(refresh).toHaveBeenCalled();
  });
});
