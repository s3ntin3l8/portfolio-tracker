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
      "p1",
      expect.any(String),
      "image/png",
    );

    fireEvent.click(screen.getByRole("button", { name: messages.Import.confirm }));

    await waitFor(() =>
      expect(screen.getByText(messages.Import.done.title)).toBeInTheDocument(),
    );
    expect(client.confirmImport).toHaveBeenCalledWith("imp1", [DRAFT], []);
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
    );
  });

  it("sends CSV text when the CSV tab is selected", async () => {
    const client: ImportClient = {
      importScreenshot: vi.fn(),
      importCsv: vi.fn(async () => ({ importId: "imp2", drafts: [DRAFT], errors: [] })),
      confirmImport: vi.fn(),
    };
    const { container } = renderFlow(client);

    fireEvent.click(screen.getByRole("button", { name: messages.Import.tabs.csv }));
    const csv = csvFile("t.csv");
    fireEvent.change(fileInput(container), { target: { files: [csv] } });

    await waitFor(() => expect(client.importCsv).toHaveBeenCalled());
    // Format defaults to auto-detect.
    expect(client.importCsv).toHaveBeenCalledWith("p1", expect.any(String), "auto");
    expect(client.importScreenshot).not.toHaveBeenCalled();
  });

  it("passes the DKB format when the DKB CSV source is selected", async () => {
    const client: ImportClient = {
      importScreenshot: vi.fn(),
      importCsv: vi.fn(async () => ({ importId: "imp3", drafts: [DRAFT], errors: [] })),
      confirmImport: vi.fn(),
    };
    const { container } = renderFlow(client);

    fireEvent.click(screen.getByRole("button", { name: messages.Import.tabs.csv }));
    fireEvent.change(screen.getByLabelText(messages.Import.csvFormat.label), {
      target: { value: "dkb" },
    });
    const csv = csvFile("dkb.csv", "Datum der Erstellung;...");
    fireEvent.change(fileInput(container), { target: { files: [csv] } });

    await waitFor(() =>
      expect(client.importCsv).toHaveBeenCalledWith("p1", expect.any(String), "dkb"),
    );
  });

  it("routes the import to the chosen target portfolio", async () => {
    const client: ImportClient = {
      importScreenshot: vi.fn(),
      importCsv: vi.fn(async () => ({ importId: "imp4", drafts: [DRAFT], errors: [] })),
      confirmImport: vi.fn(),
    };
    const { container } = renderFlow(client, [
      { id: "p1", name: "Main" },
      { id: "p2", name: "DKB" },
    ]);

    fireEvent.change(screen.getByLabelText(messages.Import.targetPortfolio), {
      target: { value: "p2" },
    });
    fireEvent.click(screen.getByRole("button", { name: messages.Import.tabs.csv }));
    const csv = csvFile("t.csv");
    fireEvent.change(fileInput(container), { target: { files: [csv] } });

    await waitFor(() =>
      expect(client.importCsv).toHaveBeenCalledWith("p2", expect.any(String), "auto"),
    );
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
      "p1",
      expect.any(String),
      "image/png",
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
    expect(client.confirmImport).toHaveBeenCalledWith("imp-c", [], [contract]);
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

    fireEvent.click(screen.getByRole("button", { name: messages.Import.tabs.csv }));
    const fileA = csvFile("broker-a.csv", "a");
    const fileB = csvFile("broker-b.csv", "b");
    fireEvent.change(fileInput(container), { target: { files: [fileA, fileB] } });

    // Both filenames should appear as section headings.
    await waitFor(() => expect(screen.getByText("broker-a.csv")).toBeInTheDocument());
    expect(screen.getByText("broker-b.csv")).toBeInTheDocument();

    // Both draft names should appear.
    expect(screen.getAllByText("Antam Gold").length).toBeGreaterThan(0);
    expect(screen.getAllByText("BBCA").length).toBeGreaterThan(0);

    // Global confirm button (from the shared footer).
    fireEvent.click(screen.getByRole("button", { name: messages.Import.confirm }));

    await waitFor(() =>
      expect(screen.getByText(messages.Import.done.title)).toBeInTheDocument(),
    );

    // One confirmImport call per import id.
    expect(client.confirmImport).toHaveBeenCalledTimes(2);
    expect(client.confirmImport).toHaveBeenCalledWith("imp-a", [DRAFT], []);
    expect(client.confirmImport).toHaveBeenCalledWith("imp-b", [DRAFT_B], []);
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

    fireEvent.click(screen.getByRole("button", { name: messages.Import.tabs.csv }));
    fireEvent.change(fileInput(container), {
      target: {
        files: [csvFile("good-a.csv", "a"), csvFile("dup.csv", "b"), csvFile("good-c.csv", "c")],
      },
    });

    // Two good sections appear.
    await waitFor(() => expect(screen.getByText("good-a.csv")).toBeInTheDocument());
    expect(screen.getByText("good-c.csv")).toBeInTheDocument();

    // Skip notice for the confirmed file.
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
    expect(client.confirmImport).toHaveBeenCalledWith("imp-a", [DRAFT], []);
    expect(client.confirmImport).toHaveBeenCalledWith("imp-c", [DRAFT_B], []);
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

    fireEvent.click(screen.getByRole("button", { name: messages.Import.tabs.csv }));
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

    fireEvent.click(screen.getByRole("button", { name: messages.Import.tabs.csv }));
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
    expect(client.confirmImport).toHaveBeenCalledWith("imp-s", [DRAFT], []);
  });
});
