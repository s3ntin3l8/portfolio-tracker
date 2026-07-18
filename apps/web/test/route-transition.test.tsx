import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { createRef } from "react";

let mockPathname = "/";

vi.mock("@/i18n/navigation", () => ({
  usePathname: () => mockPathname,
}));

import { RouteTransition } from "../src/components/route-transition";

describe("RouteTransition", () => {
  beforeEach(() => {
    mockPathname = "/";
  });

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

  it("resets the scroll container to the top on mount (#584)", () => {
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

  it("resets the scroll container to the top again when the route changes (#584)", () => {
    const scrollContainerRef = createRef<HTMLDivElement>();
    const div = document.createElement("div");
    div.scrollTo = () => {};
    const scrollToSpy = vi.spyOn(div, "scrollTo");
    scrollContainerRef.current = div;

    const { rerender } = render(
      <RouteTransition scrollContainerRef={scrollContainerRef}>
        <p>holdings content</p>
      </RouteTransition>,
    );
    scrollToSpy.mockClear();

    mockPathname = "/instruments/123";
    rerender(
      <RouteTransition scrollContainerRef={scrollContainerRef}>
        <p>instrument content</p>
      </RouteTransition>,
    );

    expect(scrollToSpy).toHaveBeenCalledWith(0, 0);
  });
});
