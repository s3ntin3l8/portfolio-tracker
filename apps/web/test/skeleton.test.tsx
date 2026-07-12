import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Skeleton } from "../src/components/ui/skeleton";

describe("Skeleton", () => {
  it("renders a muted placeholder with a shimmer sweep overlay", () => {
    const { container } = render(<Skeleton className="h-8 w-48" data-testid="block" />);
    const block = container.firstElementChild as HTMLElement;

    expect(block).toHaveClass("bg-muted");
    expect(block).toHaveClass("h-8", "w-48");

    const overlay = block.querySelector("[aria-hidden]");
    expect(overlay).not.toBeNull();
    expect(overlay).toHaveClass("animate-shimmer");
  });
});
