import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { InboxDocument } from "@portfolio/api-client";
import type { PickablePortfolio } from "../src/components/portfolio-picker";
import messages from "../messages/en.json";

const refresh = vi.fn();
const listDocuments = vi.fn(async () => [] as InboxDocument[]);
const uploadDocument = vi.fn(async () => ({ id: "doc1", duplicate: false }));
const getDocumentUrl = vi.fn(async () => ({
  url: "https://x/doc.pdf",
  filename: "doc.pdf",
  mimeType: "application/pdf",
}));
const deleteDocument = vi.fn(async () => undefined);

vi.mock("@/i18n/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock("@/lib/api", () => ({
  useApiClient: () => ({ listDocuments, uploadDocument, getDocumentUrl, deleteDocument }),
}));

import { TaxReportsInbox } from "../src/components/tax-reports-inbox";

function pdfFile(name = "report.pdf") {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "application/pdf" });
}

function fileInput(container: HTMLElement) {
  return container.querySelector('input[type="file"]') as HTMLInputElement;
}

function renderInbox(opts: {
  portfolios?: PickablePortfolio[];
  initialPortfolioId?: string;
  initialDocuments?: InboxDocument[];
}) {
  const {
    portfolios = [{ id: "p1", name: "Main", brokerage: null, accountHolder: null }],
    initialPortfolioId = "p1",
    initialDocuments = [],
  } = opts;
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TaxReportsInbox
        initialDocuments={initialDocuments}
        portfolios={portfolios}
        initialPortfolioId={initialPortfolioId}
      />
    </NextIntlClientProvider>,
  );
}

describe("TaxReportsInbox", () => {
  beforeEach(() => {
    refresh.mockClear();
    listDocuments.mockClear();
    uploadDocument.mockClear();
    getDocumentUrl.mockClear();
    deleteDocument.mockClear();
  });

  it("hides the portfolio picker and uploads with the sole portfolio", async () => {
    const { container } = renderInbox({});
    expect(screen.queryByText(messages.TaxReports.portfolioPicker)).not.toBeInTheDocument();

    fireEvent.change(fileInput(container), { target: { files: [pdfFile()] } });

    await waitFor(() =>
      expect(uploadDocument).toHaveBeenCalledWith(expect.any(File), {
        category: "tax_report",
        portfolioId: "p1",
      }),
    );
  });

  it("shows the portfolio picker when there's more than one portfolio", () => {
    renderInbox({
      portfolios: [
        { id: "p1", name: "Main", brokerage: null, accountHolder: null },
        { id: "p2", name: "Second", brokerage: null, accountHolder: null },
      ],
    });
    expect(screen.getByText(messages.TaxReports.portfolioPicker)).toBeInTheDocument();
  });

  it("disables upload and shows guidance when there's no portfolio to upload into", () => {
    const { container } = renderInbox({ portfolios: [], initialPortfolioId: "" });
    expect(screen.getByText(messages.TaxReports.noPortfolio)).toBeInTheDocument();
    expect(fileInput(container)).toBeDisabled();
  });

  it("lists existing documents and downloads via a signed URL", async () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    renderInbox({
      initialDocuments: [
        {
          id: "doc1",
          category: "tax_report",
          taxYear: 2025,
          source: "pytr",
          originalFilename: "steuerbericht-2025.pdf",
          mimeType: "application/pdf",
          sizeBytes: 12345,
          portfolioId: "p1",
          portfolioLabel: "Main",
          storedAt: "2026-01-15T00:00:00.000Z",
        },
      ],
    });
    // Both the desktop table and the mobile card render in jsdom (hidden purely via CSS
    // breakpoints, not removed from the DOM), so the filename appears twice.
    expect(screen.getAllByText("steuerbericht-2025.pdf")).toHaveLength(2);

    fireEvent.click(screen.getAllByRole("button", { name: messages.TaxReports.download })[0]!);
    await waitFor(() => expect(getDocumentUrl).toHaveBeenCalledWith("doc1"));
    expect(openSpy).toHaveBeenCalledWith("https://x/doc.pdf", "_blank", "noopener,noreferrer");
    openSpy.mockRestore();
  });

  it("sorts the documents by Year on click", () => {
    renderInbox({
      initialDocuments: [
        {
          id: "doc-newer",
          category: "tax_report",
          taxYear: 2026,
          source: "upload",
          originalFilename: "newer.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1000,
          portfolioId: "p1",
          portfolioLabel: "Main",
          storedAt: "2026-06-01T00:00:00.000Z",
        },
        {
          id: "doc-older",
          category: "tax_report",
          taxYear: 2024,
          source: "pytr",
          originalFilename: "older.pdf",
          mimeType: "application/pdf",
          sizeBytes: 2000,
          portfolioId: "p1",
          portfolioLabel: "Main",
          storedAt: "2025-01-01T00:00:00.000Z",
        },
      ],
    });
    // Both desktop table and mobile card render in jsdom; assert against the desktop button.
    const yearBtn = screen.getAllByRole("button", { name: /Year/i })[0]!;
    fireEvent.click(yearBtn);
    const dataRows = screen.getAllByRole("row").slice(1); // drop header
    // Asc: 2024 first, 2026 second.
    expect(dataRows[0]).toHaveTextContent("older.pdf");
    expect(dataRows[1]).toHaveTextContent("newer.pdf");
    expect(yearBtn.closest("th")).toHaveAttribute("aria-sort", "ascending");
    fireEvent.click(yearBtn);
    const dataRowsDesc = screen.getAllByRole("row").slice(1);
    // Desc: 2026 first, 2024 second.
    expect(dataRowsDesc[0]).toHaveTextContent("newer.pdf");
    expect(dataRowsDesc[1]).toHaveTextContent("older.pdf");
    expect(yearBtn.closest("th")).toHaveAttribute("aria-sort", "descending");
  });
});
