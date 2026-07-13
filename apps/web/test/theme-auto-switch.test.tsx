import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { ThemeColorSync } from "../src/components/theme-color-sync";
import { ThemeToggle } from "../src/components/theme-toggle";
import { ThemeSwitcher } from "../src/components/theme-switcher";
import { useTheme } from "next-themes";

vi.mock("next-themes", () => ({
  useTheme: vi.fn(),
}));

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

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

describe("ThemeColorSync", () => {
  const setTheme = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    installLocalStorage();
    window.localStorage.clear();

    vi.mocked(useTheme).mockReturnValue({
      resolvedTheme: "dark",
      setTheme,
      theme: "dark",
      themes: ["light", "dark", "system"],
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("auto-switches to system theme on mobile if no user preference is set", () => {
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    wrap(<ThemeColorSync />);

    expect(setTheme).toHaveBeenCalledWith("system");
  });

  it("does not auto-switch to system theme on mobile if user preference is set", () => {
    window.localStorage.setItem("theme", "light");

    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    wrap(<ThemeColorSync />);

    expect(setTheme).not.toHaveBeenCalled();
  });

  it("does not auto-switch on desktop", () => {
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    wrap(<ThemeColorSync />);

    expect(setTheme).not.toHaveBeenCalled();
  });
});

describe("ThemeToggle", () => {
  const setTheme = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(useTheme).mockReturnValue({
      resolvedTheme: "dark",
      setTheme,
      theme: "dark",
      themes: ["light", "dark", "system"],
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders and calls setTheme with opposite of resolvedTheme on click", () => {
    wrap(<ThemeToggle />);

    const button = screen.getByRole("button", { name: "Toggle theme" });
    expect(button).toBeInTheDocument();

    fireEvent.click(button);
    expect(setTheme).toHaveBeenCalledWith("light");
  });
});

describe("ThemeSwitcher", () => {
  const setTheme = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(useTheme).mockReturnValue({
      resolvedTheme: "dark",
      setTheme,
      theme: "dark",
      themes: ["light", "dark", "system"],
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders light, dark, and system options", () => {
    wrap(<ThemeSwitcher />);

    expect(screen.getByRole("button", { name: "Light" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dark" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "System" })).toBeInTheDocument();
  });

  it("marks current theme as selected using aria-pressed", () => {
    wrap(<ThemeSwitcher />);

    expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Light" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "System" })).toHaveAttribute("aria-pressed", "false");
  });

  it("calls setTheme with correct value when button is clicked", () => {
    wrap(<ThemeSwitcher />);

    fireEvent.click(screen.getByRole("button", { name: "Light" }));
    expect(setTheme).toHaveBeenCalledWith("light");

    fireEvent.click(screen.getByRole("button", { name: "System" }));
    expect(setTheme).toHaveBeenCalledWith("system");
  });
});
