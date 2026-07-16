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
    const { container: md } = render(<Spinner size="md" />);
    expect(md.querySelector("svg")).toHaveClass("size-5");
    const { container: lg } = render(<Spinner size="lg" />);
    expect(lg.querySelector("svg")).toHaveClass("size-6");
    const { container: xl } = render(<Spinner size="xl" />);
    expect(xl.querySelector("svg")).toHaveClass("size-7");
  });

  it("merges a caller className", () => {
    const { container } = render(<Spinner className="text-destructive" />);
    expect(container.querySelector("svg")).toHaveClass("text-destructive");
  });
});
