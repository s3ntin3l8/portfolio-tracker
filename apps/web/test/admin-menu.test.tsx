import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type * as React from "react";

// Mock @/i18n/navigation so no Next.js router is needed.
vi.mock("@/i18n/navigation", () => ({
  Link: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => <a href={href} className={className}>{children}</a>,
}));

// Mock next-intl/server with an identity translator (returns the key itself).
// AdminMenu only calls getTranslations("Admin"), so this is sufficient.
vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));

// Import after mocks are registered so AdminMenu gets the mocked deps.
const { AdminMenu } = await import("../src/components/admin-menu");

describe("AdminMenu", () => {
  it("renders the section links with correct hrefs", async () => {
    const element = await AdminMenu();
    const { container } = render(element as React.ReactElement);
    const links = container.querySelectorAll("a");
    expect(links).toHaveLength(6);
    const hrefs = Array.from(links).map((l) => l.getAttribute("href"));
    expect(hrefs).toContain("/admin/providers");
    expect(hrefs).toContain("/admin/vision");
    expect(hrefs).toContain("/admin/imports");
    expect(hrefs).toContain("/admin/storage");
    expect(hrefs).toContain("/admin/database");
    expect(hrefs).toContain("/admin/jobs");
  });

  it("renders section title keys as text", async () => {
    const element = await AdminMenu();
    render(element as React.ReactElement);
    // Identity translator returns key names — verify each section title key is rendered.
    expect(screen.getByText("providers")).toBeInTheDocument();
    expect(screen.getByText("visionProviders")).toBeInTheDocument();
    expect(screen.getByText("stats")).toBeInTheDocument();
    expect(screen.getByText("jobs")).toBeInTheDocument();
  });
});
