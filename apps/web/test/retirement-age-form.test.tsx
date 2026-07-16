import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

const putPreferences = vi.fn(async (body: unknown) => body);

vi.mock("@/lib/api", () => ({
  useApiClient: () => ({ putPreferences }),
}));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { RetirementAgeForm } from "../src/components/settings-sections/retirement-age-form";

function renderForm(age: number | null) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <RetirementAgeForm age={age} />
    </NextIntlClientProvider>,
  );
}

describe("RetirementAgeForm", () => {
  it("renders the current age value when provided", () => {
    renderForm(67);
    expect(screen.getByDisplayValue("67")).toBeInTheDocument();
  });

  it("renders empty input when age is null", () => {
    renderForm(null);
    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    expect(input.value).toBe("");
  });

  it("disables save when value is unchanged", () => {
    renderForm(67);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("enables save when value changes", () => {
    renderForm(67);
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "65" } });
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("calls putPreferences on save", async () => {
    renderForm(67);
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "65" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(putPreferences).toHaveBeenCalledWith({ retirementAge: 65 }));
  });

  it("clears the retirement age when input is emptied", async () => {
    renderForm(67);
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(putPreferences).toHaveBeenCalledWith({ retirementAge: null }));
  });
});
