import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const back = vi.fn();
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ back }),
}));

import { SettingsModalShell } from "../src/components/settings-modal-shell";

describe("SettingsModalShell", () => {
  beforeEach(() => {
    back.mockClear();
  });

  it("renders the title and children", () => {
    render(
      <SettingsModalShell title="Settings">
        <p>section content</p>
      </SettingsModalShell>,
    );
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByText("section content")).toBeInTheDocument();
  });

  it("calls router.back() when the close button is clicked", () => {
    render(
      <SettingsModalShell title="Settings">
        <p>section content</p>
      </SettingsModalShell>,
    );
    // Two close buttons render (mobile header + desktop corner); either closes the same way.
    const [closeButton] = screen.getAllByRole("button", { name: "Close" });
    fireEvent.click(closeButton);
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("calls router.back() on Escape — a real route pop, not a synthetic history marker", () => {
    render(
      <SettingsModalShell title="Settings">
        <p>section content</p>
      </SettingsModalShell>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("does not react to other keys", () => {
    render(
      <SettingsModalShell title="Settings">
        <p>section content</p>
      </SettingsModalShell>,
    );
    fireEvent.keyDown(window, { key: "Enter" });
    expect(back).not.toHaveBeenCalled();
  });

  it("closes when the scrim (outside the panel) is clicked", () => {
    render(
      <SettingsModalShell title="Settings">
        <p>section content</p>
      </SettingsModalShell>,
    );
    fireEvent.click(screen.getByRole("dialog", { name: "Settings" }).parentElement!);
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("does not close when clicking inside the panel", () => {
    render(
      <SettingsModalShell title="Settings">
        <p>section content</p>
      </SettingsModalShell>,
    );
    fireEvent.click(screen.getByText("section content"));
    expect(back).not.toHaveBeenCalled();
  });

  it("locks and restores background scroll while mounted", () => {
    document.body.style.overflow = "auto";
    const { unmount } = render(
      <SettingsModalShell title="Settings">
        <p>section content</p>
      </SettingsModalShell>,
    );
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("auto");
  });
});
