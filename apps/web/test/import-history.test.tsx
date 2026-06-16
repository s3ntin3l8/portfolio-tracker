import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import type { ImportRecord } from "@portfolio/api-client";

const refresh = vi.fn();
const discardImport = vi.fn(async () => undefined);
const deleteImport = vi.fn(async () => ({ removed: 1 }));

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ refresh }),
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/lib/api", () => ({
  useApiClient: () => ({ discardImport, deleteImport }),
}));

import { ImportHistory } from "../src/components/import-history";

const m = messages.ImportHistory;

const items: ImportRecord[] = [
  {
    id: "draft1",
    portfolioId: "p1",
    parser: "csv",
    status: "draft",
    confidence: null,
    count: 2,
    createdAt: "2026-06-10T10:00:00.000Z",
  },
  {
    id: "conf1",
    portfolioId: "p1",
    parser: "dkb",
    status: "confirmed",
    confidence: null,
    count: 4,
    createdAt: "2026-06-09T10:00:00.000Z",
  },
];

function renderHistory() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ImportHistory items={items} />
    </NextIntlClientProvider>,
  );
}

describe("ImportHistory", () => {
  beforeEach(() => {
    refresh.mockClear();
    discardImport.mockClear();
    deleteImport.mockClear();
  });

  it("discards a draft import", async () => {
    renderHistory();
    fireEvent.click(screen.getByRole("button", { name: m.discard }));
    await waitFor(() => expect(discardImport).toHaveBeenCalledWith("draft1"));
    expect(refresh).toHaveBeenCalled();
  });

  it("links a draft import to its review page", () => {
    renderHistory();
    const link = screen.getByRole("link", { name: m.review });
    expect(link).toHaveAttribute("href", "/import/draft1");
  });

  it("undoes a confirmed import only after the two-step confirm", async () => {
    renderHistory();
    // First click reveals the warning + destructive confirm; nothing removed yet.
    fireEvent.click(screen.getByRole("button", { name: m.undo }));
    expect(deleteImport).not.toHaveBeenCalled();
    expect(screen.getByText(/Removes 4 transactions/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: m.undo }));
    await waitFor(() => expect(deleteImport).toHaveBeenCalledWith("conf1"));
    expect(refresh).toHaveBeenCalled();
  });
});
