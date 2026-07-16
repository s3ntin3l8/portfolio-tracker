import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import React, { createRef } from "react";
import { PullToRefresh } from "../src/components/pull-to-refresh";

const mockRefresh = vi.fn();
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({
    refresh: mockRefresh,
  }),
}));

describe("PullToRefresh", () => {
  beforeEach(() => {
    mockRefresh.mockClear();
  });

  it("renders children successfully", () => {
    const scrollContainerRef = createRef<HTMLDivElement>();
    const { getByText } = render(
      <div ref={scrollContainerRef}>
        <PullToRefresh scrollContainerRef={scrollContainerRef}>
          <div>content to refresh</div>
        </PullToRefresh>
      </div>,
    );

    expect(getByText("content to refresh")).toBeInTheDocument();
  });

  it("triggers router.refresh() when pulled down past TRIGGER_HEIGHT", () => {
    const scrollContainerRef = createRef<HTMLDivElement>();
    render(
      <div ref={scrollContainerRef} style={{ height: "400px", overflowY: "auto" }}>
        <PullToRefresh scrollContainerRef={scrollContainerRef}>
          <div>content to refresh</div>
        </PullToRefresh>
      </div>,
    );

    const container = scrollContainerRef.current!;
    Object.defineProperty(container, "scrollTop", { value: 0, writable: true });

    // Simulate touchstart at clientY: 100
    fireEvent.touchStart(container, {
      touches: [{ clientY: 100 }],
    });

    // Simulate touchmove to clientY: 300 (dy = 200, pullDistance = Math.min(100, 200 * 0.45) = 90)
    // 90px > TRIGGER_HEIGHT (65px)
    fireEvent.touchMove(container, {
      touches: [{ clientY: 300 }],
    });

    // Simulate touchend
    fireEvent.touchEnd(container);

    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("does not trigger router.refresh() when pulled down below TRIGGER_HEIGHT", () => {
    const scrollContainerRef = createRef<HTMLDivElement>();
    render(
      <div ref={scrollContainerRef} style={{ height: "400px", overflowY: "auto" }}>
        <PullToRefresh scrollContainerRef={scrollContainerRef}>
          <div>content to refresh</div>
        </PullToRefresh>
      </div>,
    );

    const container = scrollContainerRef.current!;
    Object.defineProperty(container, "scrollTop", { value: 0, writable: true });

    // Simulate touchstart at clientY: 100
    fireEvent.touchStart(container, {
      touches: [{ clientY: 100 }],
    });

    // Simulate touchmove to clientY: 200 (dy = 100, pullDistance = Math.min(100, 100 * 0.45) = 45)
    // 45px < TRIGGER_HEIGHT (65px)
    fireEvent.touchMove(container, {
      touches: [{ clientY: 200 }],
    });

    // Simulate touchend
    fireEvent.touchEnd(container);

    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
