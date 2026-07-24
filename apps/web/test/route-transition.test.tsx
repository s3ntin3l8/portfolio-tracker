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

  // Regression coverage for the settings/admin "reload flash": soft-navigating into an
  // intercepted `/settings*`/`/admin*` overlay only swaps the `@modal` slot — `children`
  // here is still the same page that was showing before, so it must not remount (which
  // would replay its fade-in and reset any client-side state on it).
  it("does not remount children when navigating into a /settings overlay", () => {
    const scrollContainerRef = createRef<HTMLDivElement>();
    const { rerender } = render(
      <RouteTransition scrollContainerRef={scrollContainerRef}>
        <p>holdings content</p>
      </RouteTransition>,
    );
    const before = screen.getByText("holdings content").parentElement;

    mockPathname = "/settings";
    rerender(
      <RouteTransition scrollContainerRef={scrollContainerRef}>
        <p>holdings content</p>
      </RouteTransition>,
    );

    expect(screen.getByText("holdings content").parentElement).toBe(before);
  });

  it("does not remount children while navigating between /settings sub-routes", () => {
    const scrollContainerRef = createRef<HTMLDivElement>();
    mockPathname = "/settings";
    const { rerender } = render(
      <RouteTransition scrollContainerRef={scrollContainerRef}>
        <p>holdings content</p>
      </RouteTransition>,
    );
    const before = screen.getByText("holdings content").parentElement;

    mockPathname = "/settings/investing";
    rerender(
      <RouteTransition scrollContainerRef={scrollContainerRef}>
        <p>holdings content</p>
      </RouteTransition>,
    );

    expect(screen.getByText("holdings content").parentElement).toBe(before);
  });

  it("does not reset scroll while navigating into a /settings overlay", () => {
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

    mockPathname = "/settings";
    rerender(
      <RouteTransition scrollContainerRef={scrollContainerRef}>
        <p>holdings content</p>
      </RouteTransition>,
    );

    expect(scrollToSpy).not.toHaveBeenCalled();
  });

  it("does remount children when leaving a /settings overlay for a different real page", () => {
    const scrollContainerRef = createRef<HTMLDivElement>();
    mockPathname = "/settings";
    const { rerender } = render(
      <RouteTransition scrollContainerRef={scrollContainerRef}>
        <p>holdings content</p>
      </RouteTransition>,
    );
    const before = screen.getByText("holdings content").parentElement;

    mockPathname = "/instruments/123";
    rerender(
      <RouteTransition scrollContainerRef={scrollContainerRef}>
        <p>instrument content</p>
      </RouteTransition>,
    );

    expect(screen.getByText("instrument content").parentElement).not.toBe(before);
  });
});
