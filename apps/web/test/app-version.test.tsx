import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { vi } from "vitest";

// APP_VERSION is a module-level const normally fixed at build time; mock it as a mutable
// getter so each test can exercise both the linked and the "dev" fallback branch.
const version = vi.hoisted(() => ({ APP_VERSION: "0.1.1" }));
vi.mock("@/lib/version", () => ({
  get APP_VERSION() {
    return version.APP_VERSION;
  },
  releaseUrl: (v: string) =>
    `https://github.com/s3ntin3l8/portfolio-tracker/releases/tag/v${v}`,
}));

import { AppVersion } from "../src/components/app-version";

afterEach(() => {
  cleanup();
  version.APP_VERSION = "0.1.1";
});

describe("AppVersion", () => {
  it("renders a linked version label pointing at the GitHub release for the running build", () => {
    render(<AppVersion ariaLabel="Version 0.1.1 — release notes" />);

    const link = screen.getByRole("link", { name: "Version 0.1.1 — release notes" });
    expect(link).toHaveTextContent("v0.1.1");
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/s3ntin3l8/portfolio-tracker/releases/tag/v0.1.1",
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });

  it("falls back to plain, unlinked text when no version was injected at build time", () => {
    version.APP_VERSION = "dev";

    render(<AppVersion ariaLabel="Version dev — release notes" />);

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("vdev")).toBeInTheDocument();
  });
});
