import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import {
  ImportFlow,
  type ImportClient,
  type ImportDraft,
} from "../src/components/import-flow";
import messages from "../messages/en.json";

const DRAFT: ImportDraft = {
  assetClass: "gold",
  action: "buy",
  name: "Antam Gold",
  quantity: "5",
  unit: "grams",
  price: "1150000",
  fees: "0",
  currency: "IDR",
  executedAt: "2026-02-08",
  confidence: 0.94,
};

const DRAFT_B: ImportDraft = {
  assetClass: "equity",
  action: "buy",
  name: "BBCA",
  quantity: "100",
  unit: "shares",
  price: "9000",
  fees: "5000",
  currency: "IDR",
  executedAt: "2026-03-01",
  confidence: 0.97,
};

function renderFlow(
  client: ImportClient,
  portfolios: { id: string; name: string }[] = [{ id: "p1", name: "Main" }],
) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ImportFlow
        client={client}
        portfolios={portfolios}
        defaultPortfolioId={portfolios[0].id}
      />
    </NextIntlClientProvider>,
  );
}

function pngFile() {
  return new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
}

function csvFile(name: string, content = "date,action\n2026-01-01,buy") {
  return new File([content], name, { type: "text/csv" });
}

function fileInput(container: HTMLElement) {
  return container.querySelector('input[type="file"]') as HTMLInputElement;
}

describe("ImportFlow", () => {
  it("uploads a screenshot, reviews the draft, and confirms it", async () => {
    const client: ImportClient = {
      importScreenshot: vi.fn(async () => ({
        importId: "imp1",
        drafts: [DRAFT],
        errors: [],
      })),
      importCsv: vi.fn(),
      confirmImport: vi.fn(async () => ({ confirmed: 1 })),
    };
    const { container } = renderFlow(client);

    fireEvent.change(fileInput(container), { target: { files: [pngFile()] } });

    // The draft name now renders as row text (desktop table + mobile card) until edited.
    await waitFor(() =>
      expect(screen.getAllByText("Antam Gold").length).toBeGreaterThan(0),
    );
    expect(client.importScreenshot).toHaveBeenCalledWith(
      expect.any(File),
    );

    fireEvent.click(screen.getByRole("button", { name: messages.Import.confirm }));

    await waitFor(() =>
      expect(screen.getByText(messages.Import.done.title)).toBeInTheDocument(),
    );
    expect(client.confirmImport).toHaveBeenCalledWith("imp1", [DRAFT], [], "p1", false);
  });

  it("edits a draft in the dialog and confirms the edited value", async () => {
    const client: ImportClient = {
      importScreenshot: vi.fn(async () => ({
        importId: "imp1",
        drafts: [DRAFT],
        errors: [],
      })),
      importCsv: vi.fn(),
      confirmImport: vi.fn(async () => ({ confirmed: 1 })),
    };
    const { container } = renderFlow(client);

    fireEvent.change(fileInput(container), { target: { files: [pngFile()] } });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: messages.Import.review.edit.open }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: messages.Import.review.edit.open }),
    );

    // The dialog seeds the name input from the draft; editing it patches the draft.
    fireEvent.change(screen.getByDisplayValue("Antam Gold"), {
      target: { value: "Antam Gold 2" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: messages.Import.review.edit.done }),
    );

    fireEvent.click(screen.getByRole("button", { name: messages.Import.confirm }));

    await waitFor(() =>
      expect(screen.getByText(messages.Import.done.title)).toBeInTheDocument(),
    );
    expect(client.confirmImport).toHaveBeenCalledWith(
      "imp1",
      [{ ...DRAFT, name: "Antam Gold 2" }],
      [],
      "p1",
      false,
    );
  });

  it("sends CSV text when the CSV tab is selected", async () => {
    const client: ImportClient = {
      importScreenshot: vi.fn(),
      importCsv: vi.fn(async () => ({ importId: "imp2", drafts: [DRAFT], errors: [] })),
      confirmImport: vi.fn(),
    };
    const { container } = renderFlow(client);

    fireEvent.mouseDown(screen.getByRole("tab", { name: messages.Import.tabs.csv }));
    const csv = csvFile("t.csv");
    fireEvent.change(fileInput(container), { target: { files: [csv] } });

    await waitFor(() => expect(client.importCsv).toHaveBeenCalled());
    // Format defaults to auto-detect. No portfolioId in upload (upload-first flow).
    expect(client.importCsv).toHaveBeenCalledWith(expect.any(String), "auto");
    expect(client.importScreenshot).not.toHaveBeenCalled();
  });

  it("passes the DKB format when the DKB CSV source is selected", async () => {
    const client: ImportClient = {
      importScreenshot: vi.fn(),
      importCsv: vi.fn(async () => ({ importId: "imp3", drafts: [DRAFT], errors: [] })),
      confirmImport: vi.fn(),
    };
    const { container } = renderFlow(client);

    fireEvent.mouseDown(screen.getByRole("tab", { name: messages.Import.tabs.csv }));
    fireEvent.change(screen.getByLabelText(messages.Import.csvFormat.label), {
      target: { value: "dkb" },
    });
    const csv = csvFile("dkb.csv", "Datum der Erstellung;...");
    fireEvent.change(fileInput(container), { target: { files: [csv] } });

    await waitFor(() =>
      expect(client.importCsv).toHaveBeenCalledWith(expect.any(String), "dkb"),
    );
  });

  it("routes the import to the chosen target portfolio (selected on review step)", async () => {
    const client: ImportClient = {
      importScreenshot: vi.fn(),
      importCsv: vi.fn(async () => ({ importId: "imp4", drafts: [DRAFT], errors: [] })),
      confirmImport: vi.fn(async () => ({ confirmed: 1 })),
    };
    const { container } = renderFlow(client, [
      { id: "p1", name: "Main" },
      { id: "p2", name: "DKB" },
    ]);

    // Portfolio is NOT selected before upload — picker is now on the review step.
    fireEvent.mouseDown(screen.getByRole("tab", { name: messages.Import.tabs.csv }));
    const csv = csvFile("t.csv");
    fireEvent.change(fileInput(container), { target: { files: [csv] } });

    // Wait for the review step to render with the portfolio picker.
    await waitFor(() =>
      expect(screen.getAllByText("Antam Gold").length).toBeGreaterThan(0),
    );
    // Upload call has NO portfolioId in the new upload-first flow.
    expect(client.importCsv).toHaveBeenCalledWith(expect.any(String), "auto");

    // The portfolio picker is now shown on the review step.
    fireEvent.change(screen.getByLabelText(messages.Import.targetPortfolio), {
      target: { value: "p2" },
    });

    fireEvent.click(screen.getByRole("button", { name: messages.Import.confirm }));
    await waitFor(() =>
      expect(screen.getByText(messages.Import.done.title)).toBeInTheDocument(),
    );
    // Confirm carries the selected portfolio.
    expect(client.confirmImport).toHaveBeenCalledWith("imp4", [DRAFT], [], "p2", false);
  });

  it("auto-parses a screenshot handed in via initialFile (share target)", async () => {
    const client: ImportClient = {
      importScreenshot: vi.fn(async () => ({
        importId: "imp5",
        drafts: [DRAFT],
        errors: [],
      })),
      importCsv: vi.fn(),
      confirmImport: vi.fn(),
    };
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ImportFlow
          client={client}
          portfolios={[{ id: "p1", name: "Main" }]}
          defaultPortfolioId="p1"
          initialFile={pngFile()}
        />
      </NextIntlClientProvider>,
    );

    await waitFor(() =>
      expect(screen.getAllByText("Antam Gold").length).toBeGreaterThan(0),
    );
    expect(client.importScreenshot).toHaveBeenCalledTimes(1);
    expect(client.importScreenshot).toHaveBeenCalledWith(
      expect.any(File),
    );
    expect(client.importCsv).not.toHaveBeenCalled();
  });

  it("surfaces the not-configured message on a 503", async () => {
    const client: ImportClient = {
      importScreenshot: vi.fn(async () => {
        throw Object.assign(new Error("x"), { status: 503 });
      }),
      importCsv: vi.fn(),
      confirmImport: vi.fn(),
    };
    const { container } = renderFlow(client);

    fireEvent.change(fileInput(container), { target: { files: [pngFile()] } });

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        messages.Import.errors.notConfigured,
      ),
    );
  });

  it("reviews a gold installment contract and confirms it", async () => {
    const contract = {
      provider: "GALERI24",
      contractNo: "C-9",
      currency: "IDR",
      grams: "50",
      goldName: "LM 50 Gram",
      purchasePrice: "80243000",
      downPayment: "12036450",
      adminFee: "50000",
      discount: "1250000",
      principal: "68206550",
      marginTotal: "8858832",
      tenorMonths: 12,
      monthlyInstallment: "6422116",
      startDate: "2025-02-13",
      costBasisMode: "purchase_price" as const,
      schedule: [],
      confidence: 0.95,
    };
    const client: ImportClient = {
      importScreenshot: vi.fn(async () => ({
        importId: "imp-c",
        drafts: [],
        contracts: [contract],
        errors: [],
      })),
      importCsv: vi.fn(),
      confirmImport: vi.fn(async () => ({ confirmed: 4 })),
    };
    const { container } = renderFlow(client);

    fireEvent.change(fileInput(container), { target: { files: [pngFile()] } });

    await waitFor(() =>
      expect(screen.getByText(messages.Import.contract.title)).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByRole("button", { name: messages.Import.contract.confirm }),
    );

    await waitFor(() =>
      expect(screen.getByText(messages.Import.done.title)).toBeInTheDocument(),
    );
    expect(client.confirmImport).toHaveBeenCalledWith("imp-c", [], [contract], "p1", false);
  });

  // ── Multi-file CSV tests ────────────────────────────────────────────────────

  it("two CSV files → grouped review sections → confirm fans out per import", async () => {
    const client: ImportClient = {
      importScreenshot: vi.fn(),
      importCsv: vi
        .fn()
        .mockResolvedValueOnce({ importId: "imp-a", drafts: [DRAFT], errors: [] })
        .mockResolvedValueOnce({ importId: "imp-b", drafts: [DRAFT_B], errors: [] }),
      confirmImport: vi.fn(async () => ({ confirmed: 1 })),
    };
    const { container } = renderFlow(client);

    fireEvent.mouseDown(screen.getByRole("tab", { name: messages.Import.tabs.csv }));
    const fileA = csvFile("broker-a.csv", "a");
    const fileB = csvFile("broker-b.csv", "b");
    fireEvent.change(fileInput(container), { target: { files: [fileA, fileB] } });

    // Wait for the review step: both draft names appear (unique to review; filenames also
    // appear in the parsing-step status list so they're not a reliable wait condition).
    await waitFor(() => expect(screen.getAllByText("Antam Gold").length).toBeGreaterThan(0));
    expect(screen.getAllByText("BBCA").length).toBeGreaterThan(0);

    // Both filenames should appear as group-header rows (appear twice: desktop table + mobile cards).
    expect(screen.getAllByText("broker-a.csv").length).toBeGreaterThan(0);
    expect(screen.getAllByText("broker-b.csv").length).toBeGreaterThan(0);

    // Global confirm button (from the shared footer).
    fireEvent.click(screen.getByRole("button", { name: messages.Import.confirm }));

    await waitFor(() =>
      expect(screen.getByText(messages.Import.done.title)).toBeInTheDocument(),
    );

    // One confirmImport call per import id, each with the default portfolio.
    expect(client.confirmImport).toHaveBeenCalledTimes(2);
    expect(client.confirmImport).toHaveBeenCalledWith("imp-a", [DRAFT], [], "p1", false);
    expect(client.confirmImport).toHaveBeenCalledWith("imp-b", [DRAFT_B], [], "p1", false);
  });

  it("skip & continue: one already-confirmed file is skipped, the rest proceeds", async () => {
    const client: ImportClient = {
      importScreenshot: vi.fn(),
      importCsv: vi
        .fn()
        .mockResolvedValueOnce({ importId: "imp-a", drafts: [DRAFT], errors: [] })
        .mockResolvedValueOnce({
          importId: "imp-skip",
          drafts: [],
          errors: [],
          alreadyConfirmed: true,
        })
        .mockResolvedValueOnce({ importId: "imp-c", drafts: [DRAFT_B], errors: [] }),
      confirmImport: vi.fn(async () => ({ confirmed: 1 })),
    };
    const { container } = renderFlow(client);

    fireEvent.mouseDown(screen.getByRole("tab", { name: messages.Import.tabs.csv }));
    fireEvent.change(fileInput(container), {
      target: {
        files: [csvFile("good-a.csv", "a"), csvFile("dup.csv", "b"), csvFile("good-c.csv", "c")],
      },
    });

    // Wait for the review step using draft names (filenames also appear in the
    // parsing-step status list and are not a reliable wait condition).
    await waitFor(() => expect(screen.getAllByText("Antam Gold").length).toBeGreaterThan(0));

    // Good section group headers appear in the review table (appear twice: desktop table + mobile cards).
    expect(screen.getAllByText("good-a.csv").length).toBeGreaterThan(0);
    expect(screen.getAllByText("good-c.csv").length).toBeGreaterThan(0);

    // Skip notice for the confirmed file (inside the collapsible error banner).
    expect(
      screen.getByText(
        messages.Import.skipped.alreadyConfirmed.replace("{file}", "dup.csv"),
      ),
    ).toBeInTheDocument();

    // Confirm fans out over only the two good imports.
    fireEvent.click(screen.getByRole("button", { name: messages.Import.confirm }));
    await waitFor(() =>
      expect(screen.getByText(messages.Import.done.title)).toBeInTheDocument(),
    );
    expect(client.confirmImport).toHaveBeenCalledTimes(2);
    expect(client.confirmImport).toHaveBeenCalledWith("imp-a", [DRAFT], [], "p1", false);
    expect(client.confirmImport).toHaveBeenCalledWith("imp-c", [DRAFT_B], [], "p1", false);
  });

  it("all files empty/duplicate → stays on upload with error notice", async () => {
    const client: ImportClient = {
      importScreenshot: vi.fn(),
      importCsv: vi
        .fn()
        .mockResolvedValueOnce({
          importId: "i1",
          drafts: [],
          errors: [],
          alreadyConfirmed: true,
        })
        .mockResolvedValueOnce({ importId: "i2", drafts: [], errors: [] }),
      confirmImport: vi.fn(),
    };
    const { container } = renderFlow(client);

    fireEvent.mouseDown(screen.getByRole("tab", { name: messages.Import.tabs.csv }));
    fireEvent.change(fileInput(container), {
      target: { files: [csvFile("a.csv", "a"), csvFile("b.csv", "b")] },
    });

    // Should stay on upload (no filename headings in review).
    await waitFor(() =>
      expect(screen.getByRole("alert")).toBeInTheDocument(),
    );
    expect(screen.queryByText("a.csv")).not.toBeInTheDocument();
    expect(client.confirmImport).not.toHaveBeenCalled();
  });

  it("multi-file: distinct skip reasons for each failed file (regression: tautological ternary)", async () => {
    // Regression guard: every multi-file failure used to collapse to "parseError"
    // ("couldn't be read") because of a tautological ternary bug. Now each error
    // maps to its own reason via importSkipReason().
    const client: ImportClient = {
      importScreenshot: vi
        .fn()
        // File 1: succeeds (so we reach the review step and can see the skip notices)
        .mockResolvedValueOnce({ importId: "imp-ok", drafts: [DRAFT], errors: [] })
        // File 2: provider error → parseFailed (502)
        .mockRejectedValueOnce(Object.assign(new Error("parse"), { status: 502 }))
        // File 3: file too large → tooLarge (413)
        .mockRejectedValueOnce(Object.assign(new Error("large"), { status: 413 })),
      importCsv: vi.fn(),
      confirmImport: vi.fn(async () => ({ confirmed: 1 })),
    };
    const { container } = renderFlow(client);

    const file1 = pngFile();
    const file2 = new File([new Uint8Array([4, 5])], "bad1.png", { type: "image/png" });
    const file3 = new File([new Uint8Array([6, 7])], "big.png", { type: "image/png" });
    fireEvent.change(fileInput(container), { target: { files: [file1, file2, file3] } });

    // We should reach the review step (file1 succeeded).
    await waitFor(() =>
      expect(screen.getAllByText("Antam Gold").length).toBeGreaterThan(0),
    );

    // The two failed files must show DIFFERENT skip messages, not both "couldn't be read".
    const parseFailed = messages.Import.skipped.parseFailed.replace("{file}", "bad1.png");
    const tooLarge = messages.Import.skipped.tooLarge.replace("{file}", "big.png");
    expect(screen.getByText(parseFailed)).toBeInTheDocument();
    expect(screen.getByText(tooLarge)).toBeInTheDocument();
  });

  it("single CSV file uses single-group path with ImportReview's own footer", async () => {
    // The single-file path must NOT render filename headings.
    const client: ImportClient = {
      importScreenshot: vi.fn(),
      importCsv: vi.fn(async () => ({
        importId: "imp-s",
        drafts: [DRAFT],
        errors: [],
      })),
      confirmImport: vi.fn(async () => ({ confirmed: 1 })),
    };
    const { container } = renderFlow(client);

    fireEvent.mouseDown(screen.getByRole("tab", { name: messages.Import.tabs.csv }));
    fireEvent.change(fileInput(container), { target: { files: [csvFile("single.csv")] } });

    await waitFor(() =>
      expect(screen.getAllByText("Antam Gold").length).toBeGreaterThan(0),
    );

    // No filename heading rendered.
    expect(screen.queryByText("single.csv")).not.toBeInTheDocument();

    // The standard Confirm button (from ImportReview's own footer) works.
    fireEvent.click(screen.getByRole("button", { name: messages.Import.confirm }));
    await waitFor(() =>
      expect(screen.getByText(messages.Import.done.title)).toBeInTheDocument(),
    );
    expect(client.confirmImport).toHaveBeenCalledWith("imp-s", [DRAFT], [], "p1", false);
  });

  it("excludes likely-duplicate drafts from the default Confirm (#196)", async () => {
    const dup: ImportDraft = {
      ...DRAFT,
      likelyDuplicate: { source: "screenshot", executedAt: "2026-02-08" },
    };
    const client: ImportClient = {
      importScreenshot: vi.fn(async () => ({
        importId: "imp-dup",
        drafts: [dup, DRAFT_B],
        errors: [],
      })),
      importCsv: vi.fn(),
      confirmImport: vi.fn(async () => ({ confirmed: 1 })),
    };
    const { container } = renderFlow(client);

    fireEvent.change(fileInput(container), { target: { files: [pngFile()] } });

    // The duplicate badge + notice render in review.
    await waitFor(() =>
      expect(screen.getAllByText(/Already imported/i).length).toBeGreaterThan(0),
    );

    // Confirm (all) writes everything EXCEPT the flagged duplicate.
    fireEvent.click(screen.getByRole("button", { name: messages.Import.confirm }));
    await waitFor(() =>
      expect(screen.getByText(messages.Import.done.title)).toBeInTheDocument(),
    );
    expect(client.confirmImport).toHaveBeenCalledWith("imp-dup", [DRAFT_B], [], "p1", false);
  });

  it("warns on an account mismatch and re-confirms with acknowledgement (#197)", async () => {
    const client: ImportClient = {
      importScreenshot: vi.fn(async () => ({
        importId: "imp-mm",
        drafts: [DRAFT],
        errors: [],
        accountMismatch: {
          kind: "other_portfolio" as const,
          matchedPortfolioId: "p2",
          matchedName: "Other",
          detected: "506740786",
        },
      })),
      importCsv: vi.fn(),
      confirmImport: vi.fn(async () => ({ confirmed: 1 })),
    };
    renderFlow(client, [
      { id: "p1", name: "Main" },
      { id: "p2", name: "Other" },
    ]);

    fireEvent.change(fileInput(document.body), { target: { files: [pngFile()] } });

    // The mismatch banner + "Import anyway" CTA render.
    const importAnyway = await screen.findByRole("button", {
      name: messages.Import.accountMismatch.importAnyway,
    });
    fireEvent.click(importAnyway);

    await waitFor(() =>
      expect(screen.getByText(messages.Import.done.title)).toBeInTheDocument(),
    );
    // Re-confirm carries the acknowledgement flag.
    expect(client.confirmImport).toHaveBeenCalledWith("imp-mm", [DRAFT], [], "p1", true);
  });
});
