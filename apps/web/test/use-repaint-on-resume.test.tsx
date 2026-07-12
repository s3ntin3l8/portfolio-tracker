import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { useRef } from "react";
import { useRepaintOnResume } from "../src/lib/use-repaint-on-resume";

function Fixture() {
  const ref = useRef<HTMLDivElement>(null);
  useRepaintOnResume(ref);
  return <div ref={ref} style={{ backdropFilter: "blur(12px)" }} data-testid="target" />;
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
}

afterEach(() => {
  cleanup();
  setVisibility("visible");
  vi.restoreAllMocks();
});

// A plain `let` reassigned only inside the mock closure below trips TS's control-flow
// narrowing (it infers the variable can never be non-null at the call site); a boxed ref
// object sidesteps that.
function mockNextFrame() {
  const box: { raf: FrameRequestCallback | null } = { raf: null };
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    box.raf = cb;
    return 1;
  });
  return box;
}

describe("useRepaintOnResume", () => {
  it("toggles backdropFilter off then restores it on resume (visibilitychange → visible)", () => {
    const box = mockNextFrame();

    const { getByTestId } = render(<Fixture />);
    const el = getByTestId("target");
    expect(el.style.backdropFilter).toBe("blur(12px)");

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));

    // Filter is dropped immediately so the compositor tears the layer down...
    expect(el.style.backdropFilter).toBe("none");
    expect(box.raf).not.toBeNull();

    // ...then restored next frame so the recreated layer regains hit testing.
    box.raf?.(0);
    expect(el.style.backdropFilter).toBe("blur(12px)");
  });

  it("does not repaint when the document becomes hidden", () => {
    const { getByTestId } = render(<Fixture />);
    const el = getByTestId("target");

    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(el.style.backdropFilter).toBe("blur(12px)");
  });

  it("also repaints on pageshow (bfcache restore)", () => {
    const box = mockNextFrame();

    const { getByTestId } = render(<Fixture />);
    const el = getByTestId("target");

    window.dispatchEvent(new Event("pageshow"));
    expect(el.style.backdropFilter).toBe("none");
    box.raf?.(0);
    expect(el.style.backdropFilter).toBe("blur(12px)");
  });
});
