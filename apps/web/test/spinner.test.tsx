import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Spinner } from "../src/components/ui/spinner";

describe("Spinner", () => {
  it("renders a spinning icon at the default (md) size", () => {
    const { container } = render(<Spinner />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveClass("animate-spin", "size-5");
  });

  it("supports size variants", () => {
    const { container } = render(<Spinner size="lg" />);
    expect(container.querySelector("svg")).toHaveClass("size-7");
  });

  it("merges a caller className", () => {
    const { container } = render(<Spinner className="text-destructive" />);
    expect(container.querySelector("svg")).toHaveClass("text-destructive");
  });
});
