import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

const toast = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

// Minimal fake of @serwist/window's `Serwist`: records listeners so a test can fire them
// manually (there's no real service worker in jsdom), and exposes `register` /
// `messageSkipWaiting` spies matching the real API surface used by PwaUpdater. Defined
// inside vi.hoisted alongside its instance registry since vi.mock factories are hoisted
// above regular top-level declarations.
const { instances, FakeSerwist } = vi.hoisted(() => {
  class FakeSerwist {
    listeners: Record<string, Array<(event?: unknown) => void>> = {};
    register = vi.fn().mockResolvedValue(undefined);
    messageSkipWaiting = vi.fn();
    constructor(
      public scriptURL: string,
      public opts: unknown,
    ) {
      instances.push(this);
    }
    addEventListener(type: string, listener: (event?: unknown) => void) {
      (this.listeners[type] ??= []).push(listener);
    }
    emit(type: string) {
      for (const listener of this.listeners[type] ?? []) listener();
    }
  }
  const instances: InstanceType<typeof FakeSerwist>[] = [];
  return { instances, FakeSerwist };
});
vi.mock("@serwist/window", () => ({ Serwist: FakeSerwist }));

import { PwaUpdater } from "../src/components/pwa-updater";

function renderUpdater() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PwaUpdater />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  instances.length = 0;
  // jsdom has no navigator.serviceWorker by default; PwaUpdater gates on its presence.
  Object.defineProperty(navigator, "serviceWorker", { value: {}, configurable: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  toast.info.mockReset();
  delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
});

describe("PwaUpdater", () => {
  it("does nothing outside production, since the service worker itself is dev-disabled", () => {
    renderUpdater();
    expect(instances).toHaveLength(0);
  });

  it("registers the service worker and prompts a reload once an update is waiting", () => {
    vi.stubEnv("NODE_ENV", "production");
    renderUpdater();

    expect(instances).toHaveLength(1);
    const sw = instances[0];
    expect(sw.scriptURL).toBe("/sw.js");
    expect(sw.register).toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();

    sw.emit("waiting");

    expect(toast.info).toHaveBeenCalledTimes(1);
    const [message, opts] = toast.info.mock.calls[0] as [
      string,
      { id: string; action: { onClick: () => void } },
    ];
    expect(message).toBe("A new version is available");
    expect(opts.id).toBe("pwa-update-available");

    // Clicking "Reload" hands control to the waiting worker.
    opts.action.onClick();
    expect(sw.messageSkipWaiting).toHaveBeenCalledTimes(1);
  });
});
