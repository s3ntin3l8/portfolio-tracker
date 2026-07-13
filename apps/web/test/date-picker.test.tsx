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

function getInput(container: HTMLElement) {
  const input = container.querySelector('input[type="date"]');
  if (!input) throw new Error("DatePicker did not render a hidden <input type=date>");
  return input as HTMLInputElement;
}

describe("DatePicker", () => {
  it("falls back to the placeholder accessible name when no label is provided", () => {
    renderPicker(<DatePicker value="" onChange={() => {}} />);
    expect(
      screen.getByRole("button", { name: /pick a date/i }),
    ).toBeInTheDocument();
  });

  it("uses just the field label as the button name when value is empty and label is provided", () => {
    renderPicker(<DatePicker value="" onChange={() => {}} label="Date" />);
    // The button's accessible name is the field label; the "Pick a date"
    // placeholder remains as visible text but is NOT the accessible name.
    expect(
      screen.getByRole("button", { name: "Date" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Pick a date")).toBeInTheDocument();
  });

  it("renders the formatted value when set", () => {
    renderPicker(
      <DatePicker value="2026-02-03" onChange={() => {}} label="Date" />,
    );
    // en-US medium → "Feb 3, 2026"
    expect(
      screen.getByRole("button", { name: /feb 3, 2026/i }),
    ).toBeInTheDocument();
  });

  it("includes the field label in the button's accessible name", () => {
    renderPicker(
      <DatePicker value="2026-02-03" onChange={() => {}} label="Ex-date" />,
    );
    // label + ", " + formatted value
    expect(
      screen.getByRole("button", { name: /^Ex-date, Feb 3, 2026$/i }),
    ).toBeInTheDocument();
  });

  it("uses just the label as the button name when no value is set", () => {
    renderPicker(<DatePicker value="" onChange={() => {}} label="Ex-date" />);
    expect(
      screen.getByRole("button", { name: "Ex-date" }),
    ).toBeInTheDocument();
  });

  it("keeps the hidden input in the DOM with the same id, out of the tab order, and NOT aria-hidden", () => {
    const { container } = renderPicker(
      <DatePicker
        id="d"
        value="2026-02-03"
        onChange={() => {}}
        label="Date"
      />,
    );
    const input = getInput(container);
    expect(input).toHaveAttribute("type", "date");
    expect(input).toHaveAttribute("id", "d");
    expect(input).toHaveValue("2026-02-03");
    expect(input).toHaveClass("sr-only");
    expect(input).toHaveAttribute("tabindex", "-1");
    expect(input).not.toHaveAttribute("aria-hidden");
  });

  it("calls onChange when the hidden input changes", () => {
    const onChange = vi.fn();
    const { container } = renderPicker(
      <DatePicker value="" onChange={onChange} label="Date" />,
    );
    const input = getInput(container);
    fireEvent.change(input, { target: { value: "2026-03-15" } });
    expect(onChange).toHaveBeenCalled();
  });

  it("clicking the trigger calls showPicker when available", () => {
    const showPicker = vi.fn();
    const { container } = renderPicker(
      <DatePicker value="2026-02-03" onChange={() => {}} label="Date" />,
    );
    const input = getInput(container);
    input.showPicker = showPicker;
    fireEvent.click(screen.getByRole("button"));
    expect(showPicker).toHaveBeenCalled();
  });

  it("falls back to focus when showPicker is unavailable", () => {
    const { container } = renderPicker(
      <DatePicker value="2026-02-03" onChange={() => {}} label="Date" />,
    );
    const input = getInput(container);
    const focus = vi.spyOn(input, "focus");
    fireEvent.click(screen.getByRole("button"));
    expect(focus).toHaveBeenCalled();
  });

  it("forwards disabled, required, min, max to the hidden input", () => {
    const { container } = renderPicker(
      <DatePicker
        value="2026-02-03"
        onChange={() => {}}
        label="Date"
        disabled
        required
        min="2020-01-01"
        max="2030-12-31"
      />,
    );
    const input = getInput(container);
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
        label="Date"
        className="w-40"
      />,
    );
    expect(container.querySelector("button")).toHaveClass("w-40");
  });
});
