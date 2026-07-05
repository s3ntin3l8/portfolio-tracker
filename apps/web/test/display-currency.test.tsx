import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

const refresh = vi.fn();
const updateMe = vi.fn(async () => ({}));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ refresh }),
}));
vi.mock("@/lib/api", () => ({
  useApiClient: () => ({ updateMe }),
}));

import { DisplayCurrency } from "../src/components/display-currency";

function renderCurrency(current = "IDR") {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <DisplayCurrency current={current} />
    </NextIntlClientProvider>,
  );
}

describe("DisplayCurrency", () => {
  beforeEach(() => {
    refresh.mockClear();
    updateMe.mockClear();
  });

  it("marks the current currency as pressed", () => {
    renderCurrency("EUR");
    expect(screen.getByRole("button", { name: "EUR" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "USD" })).toHaveAttribute("aria-pressed", "false");
  });

  it("persists a new currency immediately and refreshes", async () => {
    renderCurrency("IDR");
    fireEvent.click(screen.getByRole("button", { name: "USD" }));
    await waitFor(() => expect(updateMe).toHaveBeenCalledWith({ displayCurrency: "USD" }));
    expect(refresh).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "USD" })).toHaveAttribute("aria-pressed", "true");
  });

  it("does nothing when the current currency is clicked again", () => {
    renderCurrency("IDR");
    fireEvent.click(screen.getByRole("button", { name: "IDR" }));
    expect(updateMe).not.toHaveBeenCalled();
  });
});
