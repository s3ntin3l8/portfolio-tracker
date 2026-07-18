import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { RouteTransition } from "../src/components/route-transition";

describe("RouteTransition", () => {
  it("wraps children in a fade-in blend container", () => {
    const scrollContainerRef = createRef<HTMLDivElement>();
    render(
      <RouteTransition scrollContainerRef={scrollContainerRef}>
        <p>page content</p>
      </RouteTransition>,
    );

    const content = screen.getByText("page content");
    expect(content.parentElement).toHaveClass("animate-fade-in");
  });

  it("resets the scroll container to the top on render (#584)", () => {
    const scrollContainerRef = createRef<HTMLDivElement>();
    const div = document.createElement("div");
    div.scrollTo = () => {};
    const scrollToSpy = vi.spyOn(div, "scrollTo");
    scrollContainerRef.current = div;

    render(
      <RouteTransition scrollContainerRef={scrollContainerRef}>
        <p>page content</p>
      </RouteTransition>,
    );

    expect(scrollToSpy).toHaveBeenCalledWith(0, 0);
  });
});
