import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/i18n/navigation", () => ({
  Link: ({
    href,
    children,
    className,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className} {...props}>
      {children}
    </a>
  ),
}));

import { SectionHeader } from "../src/components/section-header";

describe("SectionHeader", () => {
  it("renders the title and a back-link to the given href", () => {
    render(<SectionHeader title="Investing" backHref="/settings" />);
    // Title appears twice: once in the mobile back-row, once in the desktop-only heading.
    expect(screen.getAllByText("Investing").length).toBe(2);
    const backLink = screen.getByLabelText("Back");
    expect(backLink).toHaveAttribute("href", "/settings");
  });
});
