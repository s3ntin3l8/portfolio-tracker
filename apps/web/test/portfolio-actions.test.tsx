import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

const refresh = vi.fn();
const updatePortfolio = vi.fn(async () => ({}) as never);
const deletePortfolio = vi.fn(async () => undefined);

vi.mock("@/i18n/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/lib/api", () => ({
  useApiClient: () => ({ updatePortfolio, deletePortfolio }),
}));

import { PortfolioActions } from "../src/components/portfolio-actions";

const m = messages.PortfolioActions;

function renderActions() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PortfolioActions portfolioId="p1" name="Main" />
    </NextIntlClientProvider>,
  );
}

describe("PortfolioActions", () => {
  beforeEach(() => {
    refresh.mockClear();
    updatePortfolio.mockClear();
    deletePortfolio.mockClear();
    document.cookie = "pf=; max-age=0; path=/";
  });

  it("renames the portfolio", async () => {
    renderActions();
    fireEvent.click(screen.getByRole("button", { name: m.rename }));
    fireEvent.change(screen.getByLabelText(m.rename), {
      target: { value: "Growth" },
    });
    fireEvent.click(screen.getByRole("button", { name: m.save }));

    await waitFor(() => expect(updatePortfolio).toHaveBeenCalled());
    expect(updatePortfolio).toHaveBeenCalledWith("p1", { name: "Growth" });
    expect(refresh).toHaveBeenCalled();
  });

  it("deletes only after the two-step confirm", async () => {
    renderActions();
    fireEvent.click(screen.getByRole("button", { name: m.delete }));
    expect(deletePortfolio).not.toHaveBeenCalled();
    // The cascade warning is surfaced before the destructive confirm.
    expect(screen.getByText(m.deleteWarning)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: m.confirmDelete }));
    await waitFor(() => expect(deletePortfolio).toHaveBeenCalledWith("p1"));
    expect(refresh).toHaveBeenCalled();
  });

  it("resets the switcher cookie when deleting the selected portfolio", async () => {
    document.cookie = "pf=p1; path=/";
    renderActions();
    fireEvent.click(screen.getByRole("button", { name: m.delete }));
    fireEvent.click(screen.getByRole("button", { name: m.confirmDelete }));
    await waitFor(() => expect(deletePortfolio).toHaveBeenCalled());
    expect(document.cookie).not.toContain("pf=p1");
  });
});
