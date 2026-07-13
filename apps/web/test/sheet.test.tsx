import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { Sheet, SheetContent } from "../src/components/ui/sheet";

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
    if (window.visualViewport) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window.visualViewport as any).height = 768;
    }
  });

  afterEach(() => {
    cleanup();
    document.documentElement.style.removeProperty("--visual-viewport-height");
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

    expect(document.documentElement.style.getPropertyValue("--visual-viewport-height")).toBe("768px");
  });

  it("updates --visual-viewport-height on visualViewport resize event", () => {
    wrap(
      <Sheet open={true}>
        <SheetContent>
          <div>Sheet Content</div>
        </SheetContent>
      </Sheet>,
    );

    expect(document.documentElement.style.getPropertyValue("--visual-viewport-height")).toBe("768px");

    // Change height and dispatch resize
    act(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window.visualViewport as any).height = 450;
      window.visualViewport!.dispatchEvent(new Event("resize"));
    });

    expect(document.documentElement.style.getPropertyValue("--visual-viewport-height")).toBe("450px");
  });

  it("removes --visual-viewport-height on unmount or when closed", () => {
    const { rerender } = wrap(
      <Sheet open={true}>
        <SheetContent>
          <div>Sheet Content</div>
        </SheetContent>
      </Sheet>,
    );

    expect(document.documentElement.style.getPropertyValue("--visual-viewport-height")).toBe("768px");

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
});
