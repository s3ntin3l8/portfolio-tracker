import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { SettingsInstallItem } from "../src/components/settings-install-item";
import { resetPwaInstallStateForTests } from "../src/lib/use-pwa-install";
import messages from "../messages/en.json";

const toast = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

function renderItem(variant: "rail" | "landing" = "landing") {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <SettingsInstallItem variant={variant} />
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

describe("SettingsInstallItem", () => {
  beforeEach(() => {
    resetPwaInstallStateForTests();
    toast.info.mockClear();
    mockMatchMedia(false);
    setUserAgent("Mozilla/5.0 (Linux; Android 14) Chrome/120");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders nothing when the browser hasn't signaled install support", async () => {
    renderItem();
    await waitFor(() => expect(screen.queryByRole("button")).not.toBeInTheDocument());
  });

  it("shows a button on beforeinstallprompt and triggers the native prompt on click", async () => {
    renderItem();
    const prompt = fireBeforeInstallPrompt();

    const button = await screen.findByRole("button", {
      name: new RegExp(messages.Settings.navInstall),
    });
    fireEvent.click(button);

    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
  });

  it("shows a button on iOS that surfaces the manual Add-to-Home-Screen hint via toast", async () => {
    setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari");
    renderItem();

    const button = await screen.findByRole("button", {
      name: new RegExp(messages.Settings.navInstall),
    });
    fireEvent.click(button);

    expect(toast.info).toHaveBeenCalledWith(
      messages.Settings.installAppIosTitle,
      expect.objectContaining({ description: messages.Settings.installAppIosHint }),
    );
  });

  it("renders nothing when already installed (standalone)", async () => {
    mockMatchMedia(true);
    renderItem();
    fireBeforeInstallPrompt();
    await waitFor(() => expect(screen.queryByRole("button")).not.toBeInTheDocument());
  });

  it("renders the rail variant with the same accessible label", async () => {
    renderItem("rail");
    fireBeforeInstallPrompt();
    expect(
      await screen.findByRole("button", { name: new RegExp(messages.Settings.navInstall) }),
    ).toBeInTheDocument();
  });
});
