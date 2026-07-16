import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useChartTooltip } from "../src/components/ui/use-chart-tooltip";

/**
 * The hook is the non-Recharts positioning layer for the bespoke tooltips
 * added for #478. The visual shell is `ChartTooltipPanel` and is covered
 * transitively by the three chart tests; this file focuses on the
 * positioning/integration concerns: open/close lifecycle, keyboard escape,
 * outside-click dismiss, scroll-while-open tracking, and viewport collision
 * flip.
 */
describe("useChartTooltip", () => {
  beforeEach(() => {
    // jsdom defaults: 1024x768 viewport.
    Object.defineProperty(window, "innerWidth", { value: 1024, writable: true });
    Object.defineProperty(window, "innerHeight", { value: 768, writable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts closed with no content", () => {
    const { result } = renderHook(() => useChartTooltip<string>());
    expect(result.current.open).toBe(false);
    expect(result.current.content).toBeNull();
    expect(result.current.x).toBe(0);
    expect(result.current.y).toBe(0);
  });

  it("opens on mouseenter and closes on mouseleave (positions via currentTarget)", () => {
    const { result } = renderHook(() => useChartTooltip<string>());
    const target = document.createElement("div");
    Object.defineProperty(target, "getBoundingClientRect", {
      value: () => ({
        top: 100,
        right: 200,
        bottom: 120,
        left: 180,
        width: 20,
        height: 20,
        x: 180,
        y: 100,
        toJSON: () => "",
      }),
    });
    const listeners = result.current.bind("hello");
    // mouseenter receives a synthetic event with `currentTarget` set to the
    // bound element. The hook reads `event.currentTarget.getBoundingClientRect`
    // to position — no ref required.
    const enterEvent = { currentTarget: target } as unknown as React.MouseEvent<HTMLElement>;
    act(() => {
      listeners.onMouseEnter(enterEvent);
    });
    expect(result.current.open).toBe(true);
    expect(result.current.content).toBe("hello");
    expect(result.current.x).toBe(200 + 8); // right edge + GAP
    expect(result.current.y).toBe(120 + 8); // bottom edge + GAP
    act(() => {
      listeners.onMouseLeave();
    });
    expect(result.current.open).toBe(false);
  });

  it("captures per-target content via bind()", () => {
    const { result } = renderHook(() => useChartTooltip<{ month: string }>());
    const a = result.current.bind({ month: "Jan" });
    const b = result.current.bind({ month: "Feb" });
    const target = document.createElement("div");
    Object.defineProperty(target, "getBoundingClientRect", {
      value: () => ({
        top: 0,
        right: 200,
        bottom: 20,
        left: 180,
        width: 20,
        height: 20,
        x: 180,
        y: 0,
        toJSON: () => "",
      }),
    });
    act(() => {
      a.onMouseEnter({ currentTarget: target } as unknown as React.MouseEvent<HTMLElement>);
    });
    expect(result.current.content).toEqual({ month: "Jan" });
    act(() => {
      b.onMouseEnter({ currentTarget: target } as unknown as React.MouseEvent<HTMLElement>);
    });
    expect(result.current.content).toEqual({ month: "Feb" });
  });

  it("flips horizontally when the target is near the right viewport edge", () => {
    const { result } = renderHook(() => useChartTooltip<string>());
    const target = document.createElement("div");
    Object.defineProperty(target, "getBoundingClientRect", {
      // Right edge at 980 — only 44px from the 1024 viewport edge.
      // TIP_W(200) + GAP(8) = 208 > 1024 - 980 - 12 = 32, so flip.
      value: () => ({
        top: 100,
        right: 980,
        bottom: 120,
        left: 960,
        width: 20,
        height: 20,
        x: 960,
        y: 100,
        toJSON: () => "",
      }),
    });
    act(() => {
      result.current
        .bind("x")
        .onMouseEnter({ currentTarget: target } as unknown as React.MouseEvent<HTMLElement>);
    });
    // Flipped: x = left - TIP_W - GAP = 960 - 200 - 8 = 752
    expect(result.current.x).toBe(752);
  });

  it("flips vertically when the target is near the bottom viewport edge", () => {
    const { result } = renderHook(() => useChartTooltip<string>());
    const target = document.createElement("div");
    Object.defineProperty(target, "getBoundingClientRect", {
      // Bottom edge at 740 — only 28px from the 768 viewport edge.
      // TIP_H(80) + GAP(8) = 88 > 768 - 740 - 12 = 16, so flip.
      value: () => ({
        top: 720,
        right: 200,
        bottom: 740,
        left: 180,
        width: 20,
        height: 20,
        x: 180,
        y: 720,
        toJSON: () => "",
      }),
    });
    act(() => {
      result.current
        .bind("x")
        .onMouseEnter({ currentTarget: target } as unknown as React.MouseEvent<HTMLElement>);
    });
    // Flipped: y = top - TIP_H - GAP = 720 - 80 - 8 = 632
    expect(result.current.y).toBe(632);
  });

  it("closes on Escape while open", () => {
    const { result } = renderHook(() => useChartTooltip<string>());
    const target = document.createElement("div");
    Object.defineProperty(target, "getBoundingClientRect", {
      value: () => ({
        top: 100,
        right: 200,
        bottom: 120,
        left: 180,
        width: 20,
        height: 20,
        x: 180,
        y: 100,
        toJSON: () => "",
      }),
    });
    act(() => {
      result.current
        .bind("x")
        .onMouseEnter({ currentTarget: target } as unknown as React.MouseEvent<HTMLElement>);
    });
    expect(result.current.open).toBe(true);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(result.current.open).toBe(false);
  });

  it("toggles on click and dismisses on outside mousedown", () => {
    // Use a renderHook with a real DOM target mounted so click/mousedown
    // events have actual nodes to land on.
    const wrapper = document.createElement("div");
    document.body.appendChild(wrapper);
    const target = document.createElement("button");
    target.textContent = "target";
    const outside = document.createElement("button");
    outside.textContent = "outside";
    wrapper.appendChild(target);
    wrapper.appendChild(outside);

    const { result } = renderHook(() => useChartTooltip<string>());
    const listeners = result.current.bind("x");
    act(() => {
      listeners.onMouseEnter({ currentTarget: target } as unknown as React.MouseEvent<HTMLElement>);
    });
    expect(result.current.open).toBe(true);

    // The toggle semantics are exercised by the chart-level tests
    // (income-charts/holding-sparkline/report-card) which assert that
    // mouseenter opens, mouseleave closes, and outside mousedown dismisses
    // an open tooltip. Here we just verify the click handler doesn't throw
    // and that an outside mousedown after a synthetic mouseenter dismisses
    // the tooltip.
    act(() => {
      listeners.onClick({ currentTarget: target } as unknown as React.MouseEvent<HTMLElement>);
    });
    // First click toggles open → closed.
    expect(result.current.open).toBe(false);
    act(() => {
      listeners.onClick({ currentTarget: target } as unknown as React.MouseEvent<HTMLElement>);
    });
    expect(result.current.open).toBe(true);

    // Outside mousedown dismisses (the capture-phase listener installed by
    // the hook's open-state effect runs before the React event reaches the
    // target's onClick).
    act(() => {
      outside.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(result.current.open).toBe(false);
    document.body.removeChild(wrapper);
  });

  it("repositions on scroll while open", () => {
    const { result } = renderHook(() => useChartTooltip<string>());
    const target = document.createElement("div");
    let rect = {
      top: 100,
      right: 200,
      bottom: 120,
      left: 180,
      width: 20,
      height: 20,
      x: 180,
      y: 100,
      toJSON: () => "",
    };
    Object.defineProperty(target, "getBoundingClientRect", { value: () => rect });
    act(() => {
      result.current
        .bind("x")
        .onMouseEnter({ currentTarget: target } as unknown as React.MouseEvent<HTMLElement>);
    });
    const before = result.current.y;
    rect = { ...rect, top: 200, bottom: 220 };
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(result.current.y).not.toBe(before);
    expect(result.current.y).toBe(220 + 8);
  });

  it("ignores outside clicks when the click target is contained in the bound element", () => {
    const { result } = renderHook(() => useChartTooltip<string>());
    const target = document.createElement("div");
    Object.defineProperty(target, "getBoundingClientRect", {
      value: () => ({
        top: 100,
        right: 200,
        bottom: 120,
        left: 180,
        width: 20,
        height: 20,
        x: 180,
        y: 100,
        toJSON: () => "",
      }),
    });
    act(() => {
      result.current
        .bind("x")
        .onMouseEnter({ currentTarget: target } as unknown as React.MouseEvent<HTMLElement>);
    });
    expect(result.current.open).toBe(true);
    // A mousedown whose target is contained in currentTarget should NOT close.
    const child = document.createElement("span");
    target.appendChild(child);
    act(() => {
      child.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(result.current.open).toBe(true);
  });

  it("repositions the open tooltip when setSize reports a different size", () => {
    // Regression guard for the #491 review's cosmetic edge case
    // ("position doesn't self-correct for the current open tooltip once
    // the real size arrives"). When the panel fires onSize with a
    // different size, the hook re-invokes update() so the open tooltip
    // snaps to the right position immediately. Tested by placing the
    // target close to the right edge of the 1024px-wide viewport so the
    // approximation (200px) doesn't trigger a flip but the real size
    // (320px) does.
    const { result } = renderHook(() => useChartTooltip<string>());
    const target = document.createElement("div");
    // Right edge at 750. Approximation TIP_W(200) + GAP(8) = 208
    // → 750 + 208 = 958 < 1024 - 12 = 1012, no flip → x = 750 + 8 = 758.
    // Real size 320: 750 + 320 + 8 = 1078 > 1012, flip → x = 730 - 320 - 8 = 402.
    // (The flipped formula reads r.left, not r.right, so it's left - tipW - gap.)
    Object.defineProperty(target, "getBoundingClientRect", {
      value: () => ({
        top: 100,
        right: 750,
        bottom: 120,
        left: 730,
        width: 20,
        height: 20,
        x: 730,
        y: 100,
        toJSON: () => "",
      }),
    });
    act(() => {
      result.current
        .bind("x")
        .onMouseEnter({ currentTarget: target } as unknown as React.MouseEvent<HTMLElement>);
    });
    // Approximation: 200x80, no flip at right=750 → x = 750 + 8 = 758
    expect(result.current.x).toBe(758);
    // Real panel is 320x96 — that triggers a flip → x = 730 - 320 - 8 = 402
    act(() => {
      result.current.setSize({ width: 320, height: 96 });
    });
    expect(result.current.x).toBe(402);
  });

  it("setSize is a no-op when no tooltip is open (targetElRef is null)", () => {
    // Defensive: if for some reason setSize is called with no active
    // target (e.g. a stale panel unmounting and firing its final size
    // report), the hook should silently ignore it rather than throw.
    const { result } = renderHook(() => useChartTooltip<string>());
    expect(() => {
      act(() => {
        result.current.setSize({ width: 320, height: 96 });
      });
    }).not.toThrow();
    expect(result.current.open).toBe(false);
    expect(result.current.x).toBe(0);
    expect(result.current.y).toBe(0);
  });
});
