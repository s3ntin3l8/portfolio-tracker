import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { DatePicker } from "../src/components/ui/date-picker";
import messages from "../messages/en.json";

function renderPicker(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("DatePicker", () => {
  it("renders an empty placeholder when value is empty", () => {
    renderPicker(<DatePicker value="" onChange={() => {}} aria-label="Date" />);
    expect(
      screen.getByRole("button", { name: /pick a date/i }),
    ).toBeInTheDocument();
  });

  it("renders the formatted value when set", () => {
    renderPicker(
      <DatePicker value="2026-02-03" onChange={() => {}} aria-label="Date" />,
    );
    // en-US medium → "Feb 3, 2026"
    expect(
      screen.getByRole("button", { name: /feb 3, 2026/i }),
    ).toBeInTheDocument();
  });

  it("hides the native input visually but keeps it in the DOM with the same id", () => {
    renderPicker(
      <DatePicker
        id="d"
        value="2026-02-03"
        onChange={() => {}}
        aria-label="Date"
      />,
    );
    const input = screen.getByLabelText("Date");
    expect(input).toHaveAttribute("type", "date");
    expect(input).toHaveAttribute("id", "d");
    expect(input).toHaveValue("2026-02-03");
    expect(input).toHaveClass("sr-only");
  });

  it("calls onChange when the hidden input changes", () => {
    const onChange = vi.fn();
    renderPicker(<DatePicker value="" onChange={onChange} aria-label="Date" />);
    const input = screen.getByLabelText("Date") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "2026-03-15" } });
    expect(onChange).toHaveBeenCalled();
  });

  it("clicking the trigger calls showPicker when available", () => {
    const showPicker = vi.fn();
    const { container } = renderPicker(
      <DatePicker value="2026-02-03" onChange={() => {}} aria-label="Date" />,
    );
    const input = container.querySelector(
      'input[type="date"]',
    ) as HTMLInputElement;
    input.showPicker = showPicker;
    fireEvent.click(screen.getByRole("button"));
    expect(showPicker).toHaveBeenCalled();
  });

  it("falls back to focus when showPicker is unavailable", () => {
    const { container } = renderPicker(
      <DatePicker value="2026-02-03" onChange={() => {}} aria-label="Date" />,
    );
    const input = container.querySelector(
      'input[type="date"]',
    ) as HTMLInputElement;
    const focus = vi.spyOn(input, "focus");
    fireEvent.click(screen.getByRole("button"));
    expect(focus).toHaveBeenCalled();
  });

  it("forwards disabled, required, min, max to the hidden input", () => {
    renderPicker(
      <DatePicker
        value="2026-02-03"
        onChange={() => {}}
        aria-label="Date"
        disabled
        required
        min="2020-01-01"
        max="2030-12-31"
      />,
    );
    const input = screen.getByLabelText("Date");
    expect(input).toBeDisabled();
    expect(input).toBeRequired();
    expect(input).toHaveAttribute("min", "2020-01-01");
    expect(input).toHaveAttribute("max", "2030-12-31");
  });

  it("merges caller className into the trigger", () => {
    const { container } = renderPicker(
      <DatePicker
        value=""
        onChange={() => {}}
        aria-label="Date"
        className="w-40"
      />,
    );
    expect(container.querySelector("button")).toHaveClass("w-40");
  });
});
