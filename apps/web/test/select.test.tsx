import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Select } from "../src/components/ui/select";

describe("Select", () => {
  it("renders its options and forwards props", () => {
    render(
      <Select aria-label="currency" defaultValue="USD">
        <option value="IDR">IDR</option>
        <option value="USD">USD</option>
      </Select>,
    );

    const select = screen.getByRole("combobox", { name: "currency" });
    expect(select).toBeInTheDocument();
    expect((select as HTMLSelectElement).value).toBe("USD");
    expect(screen.getByRole("option", { name: "IDR" })).toBeInTheDocument();
  });

  it("applies the base classes and merges a custom className", () => {
    render(
      <Select aria-label="picker" className="custom-class">
        <option value="a">A</option>
      </Select>,
    );

    const select = screen.getByRole("combobox", { name: "picker" });
    // Explicit bg/text colors are the dark-mode fix; option colors keep the popup readable.
    expect(select).toHaveClass("bg-background");
    expect(select).toHaveClass("text-foreground");
    expect(select).toHaveClass("[&>option]:bg-popover");
    expect(select).toHaveClass("custom-class");
  });
});
