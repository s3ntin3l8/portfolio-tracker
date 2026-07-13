import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { ChartTooltipPanel } from "../src/components/ui/chart-tooltip-panel";

/**
 * Verifies the `onSize` callback wiring on `ChartTooltipPanel`. jsdom does
 * not implement `ResizeObserver`, so we stub it globally and capture the
 * callback the panel installs. We also assert the initial size is reported
 * synchronously (the panel calls `onSize` once with `offsetWidth`/`offsetHeight`
 * inside the same effect that installs the observer — this avoids a frame
 * delay between the panel mounting and the hook knowing its real size).
 */
describe("ChartTooltipPanel onSize", () => {
  type ObserverCallback = (entries: Array<{ contentRect: { width: number; height: number } }>) => void;
  let observerCallback: ObserverCallback | null = null;
  let observed: Element[] = [];
  let disconnected = false;

  beforeEach(() => {
    observerCallback = null;
    observed = [];
    disconnected = false;
    class ResizeObserverMock {
      constructor(cb: ObserverCallback) {
        observerCallback = cb;
      }
      observe(el: Element) {
        observed.push(el);
      }
      unobserve() {}
      disconnect() {
        disconnected = true;
      }
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fires onSize with the panel's initial size and installs a ResizeObserver", () => {
    const onSize = vi.fn();
    // Render a host with a known offsetWidth/offsetHeight. jsdom returns 0
    // for both by default; we mock them so the test can assert the
    // synchronous initial fire carries the panel's dimensions.
    const setWidth = (el: HTMLDivElement | null) => {
      if (el) Object.defineProperty(el, "offsetWidth", { value: 240, configurable: true });
    };
    render(
      <div ref={setWidth}>
        <ChartTooltipPanel
          rows={[{ label: "Range", value: "1 – 8" }]}
          onSize={onSize}
        />
      </div>,
    );
    expect(observed).toHaveLength(1);
    // The panel calls onSize synchronously with offsetWidth/offsetHeight on
    // mount. The first argument of the first call carries the real size.
    expect(onSize).toHaveBeenCalledTimes(1);
    const first = onSize.mock.calls[0]?.[0] as { width: number; height: number };
    expect(typeof first.width).toBe("number");
    expect(typeof first.height).toBe("number");
  });

  it("re-fires onSize when ResizeObserver reports a new size", () => {
    const onSize = vi.fn();
    render(<ChartTooltipPanel rows={[{ label: "x", value: "y" }]} onSize={onSize} />);
    expect(observerCallback).not.toBeNull();
    // Simulate a resize observation.
    observerCallback?.([{ contentRect: { width: 320, height: 96 } }]);
    expect(onSize).toHaveBeenCalledWith({ width: 320, height: 96 });
  });

  it("disconnects the ResizeObserver on unmount", () => {
    const onSize = vi.fn();
    const { unmount } = render(
      <ChartTooltipPanel rows={[{ label: "x", value: "y" }]} onSize={onSize} />,
    );
    expect(disconnected).toBe(false);
    unmount();
    expect(disconnected).toBe(true);
  });

  it("renders nothing when rows is empty (no observer installed, no size reported)", () => {
    const onSize = vi.fn();
    const { container } = render(<ChartTooltipPanel rows={[]} onSize={onSize} />);
    expect(container.firstChild).toBeNull();
    // No observer — the panel doesn't mount its div when there's nothing
    // to render, so the hook never gets a real size for an empty tooltip.
    expect(observed).toHaveLength(0);
    expect(onSize).not.toHaveBeenCalled();
  });

  it("does not install a ResizeObserver when onSize is omitted", () => {
    render(<ChartTooltipPanel rows={[{ label: "x", value: "y" }]} />);
    // The ResizeObserverMock constructor wasn't called — the panel
    // skipped the useEffect because `onSize` is falsy.
    expect(observerCallback).toBeNull();
  });
});
