import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { forwardRef } from "react";
import type { ImportRecord } from "@portfolio/api-client";
import messages from "../messages/en.json";

vi.mock("@/lib/api", () => ({
  useApiClient: () => ({
    discardImport: vi.fn(),
    deleteImport: vi.fn(),
    clearImport: vi.fn(),
  }),
}));

vi.mock("@/i18n/navigation", () => ({
  Link: forwardRef<HTMLAnchorElement, React.ComponentPropsWithoutRef<"a">>(
    function Link({ children, ...props }, ref) {
      return (
        <a ref={ref} {...props}>
          {children}
        </a>
      );
    },
  ),
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { RecentImportsSection } from "../src/components/recent-imports-section";

function record(over: Partial<ImportRecord>): ImportRecord {
  return {
    id: "imp1",
    portfolioId: "p1",
    parser: "csv",
    status: "confirmed",
    count: 2,
    createdAt: "2026-06-01T10:00:00.000Z",
    ...over,
  } as ImportRecord;
}

function renderSection(items: ImportRecord[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <RecentImportsSection items={items} />
    </NextIntlClientProvider>,
  );
}

describe("RecentImportsSection", () => {
  it("collapses a confirmed/discarded-only audit trail and expands on toggle", () => {
    renderSection([record({ status: "confirmed" })]);

    const toggle = screen.getByRole("button", { expanded: false });
    // Header shows the title and the item count.
    expect(toggle).toHaveTextContent(messages.ImportHistory.title);
    expect(toggle).toHaveTextContent("(1)");

    // Collapsed: the history table (and its Undo action) isn't rendered yet.
    expect(
      screen.queryByRole("button", { name: messages.ImportHistory.undo }),
    ).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(screen.getByRole("button", { expanded: true })).toBeInTheDocument();
    // Confirmed imports are hidden by default within the history — reveal them to act.
    expect(
      screen.queryByRole("button", { name: messages.ImportHistory.undo }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Show completed/ }));
    expect(
      screen.getByRole("button", { name: messages.ImportHistory.undo }),
    ).toBeInTheDocument();
  });

  it("stays collapsed by default even when a pending draft exists", () => {
    renderSection([record({ id: "draft1", status: "draft" })]);

    // Collapsed by default: the toggle is not expanded and the draft's review link is hidden.
    expect(screen.getByRole("button", { expanded: false })).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: messages.ImportHistory.review }),
    ).not.toBeInTheDocument();

    // Expands on demand, surfacing the review link.
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(
      screen.getByRole("link", { name: messages.ImportHistory.review }),
    ).toHaveAttribute("href", "/transactions/import/draft1");
  });
});
