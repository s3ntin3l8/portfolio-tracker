import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { createPortal } from "react-dom";
import messages from "../messages/en.json";
import { Sheet, SheetContent, useSheetFooter } from "../src/components/ui/sheet";

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("Sheet Visual Viewport Sync", () => {
  beforeEach(() => {
    document.documentElement.style.removeProperty("--visual-viewport-height");
    document.documentElement.style.removeProperty("--keyboard-inset");
    if (window.visualViewport) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window.visualViewport as any).height = 768;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window.visualViewport as any).offsetTop = 0;
    }
  });

  afterEach(() => {
    cleanup();
    document.documentElement.style.removeProperty("--visual-viewport-height");
    document.documentElement.style.removeProperty("--keyboard-inset");
  });

  it("sets --visual-viewport-height on mount when open", () => {
    expect(document.documentElement.style.getPropertyValue("--visual-viewport-height")).toBe("");

    wrap(
      <Sheet open={true}>
        <SheetContent>
          <div>Sheet Content</div>
        </SheetContent>
      </Sheet>,
    );

    expect(document.documentElement.style.getPropertyValue("--visual-viewport-height")).toBe(
      "768px",
    );
  });

  it("updates --visual-viewport-height on visualViewport resize event", () => {
    wrap(
      <Sheet open={true}>
        <SheetContent>
          <div>Sheet Content</div>
        </SheetContent>
      </Sheet>,
    );

    expect(document.documentElement.style.getPropertyValue("--visual-viewport-height")).toBe(
      "768px",
    );

    // Change height and dispatch resize
    act(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window.visualViewport as any).height = 450;
      window.visualViewport!.dispatchEvent(new Event("resize"));
    });

    expect(document.documentElement.style.getPropertyValue("--visual-viewport-height")).toBe(
      "450px",
    );
  });

  it("sets --keyboard-inset to ~0 when the visual viewport matches the layout viewport (no keyboard)", () => {
    wrap(
      <Sheet open={true}>
        <SheetContent>
          <div>Sheet Content</div>
        </SheetContent>
      </Sheet>,
    );

    expect(document.documentElement.style.getPropertyValue("--keyboard-inset")).toBe("0px");
  });

  it("sets --keyboard-inset to the keyboard height when visualViewport shrinks (iOS keyboard open)", () => {
    wrap(
      <Sheet open={true}>
        <SheetContent>
          <div>Sheet Content</div>
        </SheetContent>
      </Sheet>,
    );

    // iOS: the layout viewport (window.innerHeight) stays put; only the visual
    // viewport shrinks by the keyboard's height.
    act(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window.visualViewport as any).height = 400; // 768 - 368 keyboard
      window.visualViewport!.dispatchEvent(new Event("resize"));
    });

    expect(document.documentElement.style.getPropertyValue("--keyboard-inset")).toBe("368px");
  });

  it("removes --keyboard-inset on unmount or when closed", () => {
    const { rerender } = wrap(
      <Sheet open={true}>
        <SheetContent>
          <div>Sheet Content</div>
        </SheetContent>
      </Sheet>,
    );

    expect(document.documentElement.style.getPropertyValue("--keyboard-inset")).toBe("0px");

    rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <Sheet open={false}>
          <SheetContent>
            <div>Sheet Content</div>
          </SheetContent>
        </Sheet>
      </NextIntlClientProvider>,
    );

    expect(document.documentElement.style.getPropertyValue("--keyboard-inset")).toBe("");
  });

  it("removes --visual-viewport-height on unmount or when closed", () => {
    const { rerender } = wrap(
      <Sheet open={true}>
        <SheetContent>
          <div>Sheet Content</div>
        </SheetContent>
      </Sheet>,
    );

    expect(document.documentElement.style.getPropertyValue("--visual-viewport-height")).toBe(
      "768px",
    );

    // Close the sheet
    rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <Sheet open={false}>
          <SheetContent>
            <div>Sheet Content</div>
          </SheetContent>
        </Sheet>
      </NextIntlClientProvider>,
    );

    expect(document.documentElement.style.getPropertyValue("--visual-viewport-height")).toBe("");
  });

  it("portals the submit button into the sheet footer region", () => {
    const { getByTestId } = wrap(
      <Sheet open={true}>
        <SheetContent>
          <TestPortalForm />
        </SheetContent>
      </Sheet>,
    );

    const submitBtn = getByTestId("submit-btn");
    expect(submitBtn).toBeInTheDocument();

    const form = getByTestId("form");
    expect(form).not.toContainElement(submitBtn);
  });
});

function TestPortalForm() {
  const footerRef = useSheetFooter();
  return (
    <form data-testid="form">
      <div>Form Fields</div>
      {footerRef && createPortal(<button data-testid="submit-btn">Submit</button>, footerRef)}
    </form>
  );
}
