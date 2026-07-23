import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EventsTabSwitch } from "../src/components/add-transaction-menu/events-tab-switch";

const LABELS = { corporateAction: "Corp. action", merger: "Merger" };

// Regression test: the desktop rail's "Instrument event" destination previously hid
// `NewEntryTabs`' own tab switcher (`hideTabList`) to make room for this control, but
// nothing rendered in its place — there was no way to switch between Corp. action and
// Merger once inside that destination (add-transaction-menu.tsx).
describe("EventsTabSwitch", () => {
  it("renders both tabs with the active one pressed", () => {
    render(<EventsTabSwitch value="corporate-action" onChange={vi.fn()} labels={LABELS} />);
    expect(screen.getByRole("button", { name: "Corp. action" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Merger" })).toHaveAttribute("aria-pressed", "false");
  });

  it("calls onChange with the clicked tab's key", () => {
    const onChange = vi.fn();
    render(<EventsTabSwitch value="corporate-action" onChange={onChange} labels={LABELS} />);

    fireEvent.click(screen.getByRole("button", { name: "Merger" }));
    expect(onChange).toHaveBeenCalledWith("merger");
  });
});
