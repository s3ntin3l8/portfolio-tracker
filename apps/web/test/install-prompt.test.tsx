import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { InstallPrompt } from "../src/components/install-prompt";
import messages from "../messages/en.json";

function renderPrompt() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <InstallPrompt />
    </NextIntlClientProvider>,
  );
}

// jsdom has no matchMedia; default it to "not standalone" so the prompt is eligible.
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

// This jsdom config doesn't enable localStorage; install a minimal in-memory shim.
function installLocalStorage() {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
  });
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

describe("InstallPrompt", () => {
  beforeEach(() => {
    installLocalStorage();
    localStorage.clear();
    mockMatchMedia(false);
    setUserAgent("Mozilla/5.0 (Linux; Android 14) Chrome/120");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders nothing until an install signal arrives", () => {
    renderPrompt();
    expect(screen.queryByText(messages.Install.title)).not.toBeInTheDocument();
  });

  it("shows an install button on beforeinstallprompt and triggers the native prompt", async () => {
    renderPrompt();
    const prompt = fireBeforeInstallPrompt();

    const button = await screen.findByRole("button", { name: messages.Install.cta });
    fireEvent.click(button);
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
  });

  it("shows the manual Add-to-Home-Screen hint on iOS (no beforeinstallprompt)", async () => {
    setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari");
    renderPrompt();

    expect(await screen.findByText(messages.Install.iosHint)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: messages.Install.cta }),
    ).not.toBeInTheDocument();
  });

  it("stays dismissed across renders once dismissed", async () => {
    const first = renderPrompt();
    fireBeforeInstallPrompt();
    fireEvent.click(
      await screen.findByRole("button", { name: messages.Install.dismiss }),
    );
    expect(screen.queryByText(messages.Install.title)).not.toBeInTheDocument();
    expect(localStorage.getItem("pwa-install-dismissed")).toBe("1");
    first.unmount();

    // A fresh mount honors the persisted dismissal — nothing shows even on iOS.
    setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari");
    renderPrompt();
    expect(screen.queryByText(messages.Install.title)).not.toBeInTheDocument();
  });

  it("does not show when already installed (standalone)", () => {
    mockMatchMedia(true);
    renderPrompt();
    fireBeforeInstallPrompt();
    expect(screen.queryByText(messages.Install.title)).not.toBeInTheDocument();
  });
});
