import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { UserRound, Briefcase } from "lucide-react";

let mockPathname = "/settings";

vi.mock("@/i18n/navigation", () => ({
  Link: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
  usePathname: () => mockPathname,
}));

import { SettingsShell, type ShellNavItem } from "../src/components/settings-shell";

const NAV_ITEMS: ShellNavItem[] = [
  {
    key: "account",
    href: "/settings/account",
    icon: UserRound,
    title: "Account",
    subtitle: "Currency, language & appearance",
    color: "#0E9F6E",
    bg: "rgba(16,163,114,.14)",
  },
  {
    key: "portfolios",
    href: "/settings/portfolios",
    icon: Briefcase,
    title: "Portfolios & holders",
    subtitle: "2 portfolios · 1 holder",
    color: "#7C5CFC",
    bg: "rgba(124,92,252,.16)",
  },
];

describe("SettingsShell", () => {
  beforeEach(() => {
    mockPathname = "/settings";
  });

  it("renders every nav item as a rail link with the right href", () => {
    render(
      <SettingsShell navItems={NAV_ITEMS} indexHref="/settings">
        <div>content</div>
      </SettingsShell>,
    );
    const links = screen.getAllByRole("link");
    const hrefs = links.map((l) => l.getAttribute("href"));
    expect(hrefs).toContain("/settings/account");
    expect(hrefs).toContain("/settings/portfolios");
  });

  it("shows the mobile landing menu (grouped nav rows) at the exact index route", () => {
    mockPathname = "/settings";
    render(
      <SettingsShell navItems={NAV_ITEMS} indexHref="/settings">
        <div>account content</div>
      </SettingsShell>,
    );
    // Landing rows render each item's title + subtitle.
    expect(screen.getAllByText("Account").length).toBeGreaterThan(0);
    expect(screen.getByText("2 portfolios · 1 holder")).toBeInTheDocument();
  });

  it("renders children (not the landing menu content) on a sub-route", () => {
    mockPathname = "/settings/portfolios";
    render(
      <SettingsShell navItems={NAV_ITEMS} indexHref="/settings">
        <div>portfolios content</div>
      </SettingsShell>,
    );
    expect(screen.getByText("portfolios content")).toBeInTheDocument();
    // The landing-only subtitle row shouldn't be rendered on a sub-route.
    expect(screen.queryByText("2 portfolios · 1 holder")).not.toBeInTheDocument();
  });

  it("renders railTop/railBottom/landingTop slots", () => {
    render(
      <SettingsShell
        navItems={NAV_ITEMS}
        indexHref="/settings"
        railTop={<div>rail-top-slot</div>}
        railBottom={<div>rail-bottom-slot</div>}
        landingTop={<div>landing-top-slot</div>}
      >
        <div>content</div>
      </SettingsShell>,
    );
    expect(screen.getByText("rail-top-slot")).toBeInTheDocument();
    expect(screen.getByText("rail-bottom-slot")).toBeInTheDocument();
    expect(screen.getByText("landing-top-slot")).toBeInTheDocument();
  });
});
