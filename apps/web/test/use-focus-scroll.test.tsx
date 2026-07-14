import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import React, { useRef } from "react";
import { useFocusScroll } from "../src/lib/use-focus-scroll";

function TestComponent() {
  const ref = useRef<HTMLDivElement>(null);
  useFocusScroll(ref);
  return (
    <div ref={ref}>
      <input data-testid="input" />
    </div>
  );
}

describe("useFocusScroll", () => {
  it("scrolls focused input into view on focusin", () => {
    const scrollIntoViewMock = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoViewMock;

    const { getByTestId } = render(<TestComponent />);
    const input = getByTestId("input");

    // Trigger focusin event
    fireEvent.focusIn(input);

    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      block: "center",
      behavior: "smooth",
    });
  });

  it("re-scrolls the focused element when the visual viewport resizes (iOS keyboard settling)", () => {
    const scrollIntoViewMock = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoViewMock;

    // jsdom has no visualViewport — stub a minimal EventTarget-like one so the hook's
    // `visualViewport?.addEventListener("resize", ...)` has something to attach to.
    const listeners: Record<string, ((e: Event) => void)[]> = {};
    vi.stubGlobal("visualViewport", {
      addEventListener: (type: string, cb: (e: Event) => void) => {
        (listeners[type] ??= []).push(cb);
      },
      removeEventListener: (type: string, cb: (e: Event) => void) => {
        listeners[type] = (listeners[type] ?? []).filter((l) => l !== cb);
      },
    });

    const { getByTestId } = render(<TestComponent />);
    const input = getByTestId("input");

    // .focus() both dispatches a real focusin event and sets document.activeElement,
    // matching what the keyboard-opening sequence looks like on a device.
    input.focus();
    scrollIntoViewMock.mockClear();

    listeners.resize?.forEach((cb) => cb(new Event("resize")));

    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      block: "center",
      behavior: "smooth",
    });

    vi.unstubAllGlobals();
  });

  it("does not re-scroll on viewport resize once focus has moved elsewhere", () => {
    const scrollIntoViewMock = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoViewMock;

    const listeners: Record<string, ((e: Event) => void)[]> = {};
    vi.stubGlobal("visualViewport", {
      addEventListener: (type: string, cb: (e: Event) => void) => {
        (listeners[type] ??= []).push(cb);
      },
      removeEventListener: (type: string, cb: (e: Event) => void) => {
        listeners[type] = (listeners[type] ?? []).filter((l) => l !== cb);
      },
    });

    const { getByTestId } = render(<TestComponent />);
    const input = getByTestId("input");

    input.focus();
    input.blur();
    scrollIntoViewMock.mockClear();

    listeners.resize?.forEach((cb) => cb(new Event("resize")));

    expect(scrollIntoViewMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
