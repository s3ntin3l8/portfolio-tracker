import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import {
  CreatePortfolioForm,
  type CreatePortfolioClient,
} from "../src/components/create-portfolio-form";
import messages from "../messages/en.json";

function renderForm(client: CreatePortfolioClient, onSuccess = vi.fn()) {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <CreatePortfolioForm client={client} onSuccess={onSuccess} />
    </NextIntlClientProvider>,
  );
  return onSuccess;
}

describe("CreatePortfolioForm", () => {
  it("creates a portfolio with the entered name and currency", async () => {
    const client: CreatePortfolioClient = {
      createPortfolio: vi.fn(async () => ({
        id: "p1",
        userId: "u1",
        name: "Stockbit",
        baseCurrency: "IDR",
      })),
    };
    const onSuccess = renderForm(client);

    fireEvent.change(screen.getByLabelText(messages.Manage.portfolio.name), {
      target: { value: "Stockbit" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: messages.Manage.portfolio.create }),
    );

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(client.createPortfolio).toHaveBeenCalledWith({
      name: "Stockbit",
      baseCurrency: "IDR",
    });
  });

  it("shows an error when creation fails", async () => {
    const client: CreatePortfolioClient = {
      createPortfolio: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    renderForm(client);

    fireEvent.change(screen.getByLabelText(messages.Manage.portfolio.name), {
      target: { value: "X" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: messages.Manage.portfolio.create }),
    );

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        messages.Manage.portfolio.error,
      ),
    );
  });
});
