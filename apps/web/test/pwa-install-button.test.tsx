import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { PwaInstallButton } from "../src/components/pwa-install-button";
import messages from "../messages/en.json";

function renderButton() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PwaInstallButton />
    </NextIntlClientProvider>,
  );
}

function mockMatchMedia(standalone = false) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes("standalone") ? standalone : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function setUserAgent(ua: string) {
  Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true });
}

function fireBeforeInstallPrompt() {
  const prompt = vi.fn().mockResolvedValue(undefined);
  const event = Object.assign(new Event("beforeinstallprompt"), {
    prompt,
    userChoice: Promise.resolve({ outcome: "accepted" as const }),
  });
  fireEvent(window, event);
  return prompt;
}

describe("PwaInstallButton", () => {
  beforeEach(() => {
    mockMatchMedia(false);
    setUserAgent("Mozilla/5.0 (Linux; Android 14) Chrome/120");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows an unsupported message when no beforeinstallprompt has fired", async () => {
    renderButton();
    // Chrome without beforeinstallprompt (not yet fired, or non-Chromium) falls
    // through to the unsupported state since eligible is resolved but deferred is null.
    expect(
      await screen.findByText(messages.Settings.installAppUnavailable),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: messages.Settings.installAppCta }),
    ).not.toBeInTheDocument();
  });

  it("shows an install button on beforeinstallprompt and triggers the native prompt", async () => {
    renderButton();

    const prompt = fireBeforeInstallPrompt();
    const button = await screen.findByRole("button", { name: messages.Settings.installAppCta });
    fireEvent.click(button);

    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
  });

  it("shows the manual Add-to-Home-Screen hint on iOS (no beforeinstallprompt)", async () => {
    setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari");
    renderButton();

    expect(await screen.findByText(messages.Settings.installAppIosHint)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: messages.Settings.installAppCta }),
    ).not.toBeInTheDocument();
  });

  it("shows an already-installed message when in standalone mode", async () => {
    mockMatchMedia(true);
    setUserAgent("Mozilla/5.0 (Linux; Android 14) Chrome/120");
    renderButton();

    expect(
      await screen.findByText(messages.Settings.installAppInstalled),
    ).toBeInTheDocument();
  });
});
