import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RouteTransition } from "../src/components/route-transition";

describe("RouteTransition", () => {
  it("wraps children in a fade-in blend container", () => {
    render(
      <RouteTransition>
        <p>page content</p>
      </RouteTransition>,
    );

    const content = screen.getByText("page content");
    expect(content.parentElement).toHaveClass("animate-fade-in");
  });
});
