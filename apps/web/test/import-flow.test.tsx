import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import {
  ImportFlow,
  type ImportClient,
  type ImportDraft,
  type ImportTask,
} from "../src/components/import-flow";
import messages from "../messages/en.json";

// Spy on the router so the Phase-2 (auto-materialized) path's refresh is satisfied.
const pushMock = vi.fn();
const refreshMock = vi.fn();
vi.mock("@/i18n/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/i18n/navigation")>();
  return {
    ...actual,
    useRouter: () => ({
      push: pushMock,
      replace: vi.fn(),
      back: vi.fn(),
      refresh: refreshMock,
    }),
  };
});

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

/** Build an ImportClient with no-op defaults; override per test. */
function makeClient(overrides: Partial<ImportClient> = {}): ImportClient {
  return {
    importScreenshot: vi.fn(),
    importCsv: vi.fn(),
    confirmImport: vi.fn(async () => ({ confirmed: 1 })),
    materializeImport: vi.fn(async () => ({ materializedCount: 1, excludedCashMovements: 0 })),
    ...overrides,
  };
}

function renderFlow(
  client: ImportClient,
  portfolios: {
    id: string;
    name: string;
    brokerage: string | null;
    accountHolder: string | null;
  }[] = [{ id: "p1", name: "Main", brokerage: null, accountHolder: null }],
) {
  const onSubmit = vi.fn<(task: ImportTask) => void>();
  const onClose = vi.fn();
  const result = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ImportFlow
        client={client}
        portfolios={portfolios}
        defaultPortfolioId={portfolios[0].id}
        onSubmit={onSubmit}
        onClose={onClose}
      />
    </NextIntlClientProvider>,
  );
  return { ...result, onSubmit, onClose };
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

const confirmBtn = () =>
  screen.getByRole("button", { name: messages.Import.confirmPortfolio.confirm });

describe("ImportFlow", () => {
  it("uploads a screenshot, then hands a materialize task off and closes", async () => {
    const client = makeClient({
      importScreenshot: vi.fn(async () => ({
        importId: "imp1",
        drafts: [DRAFT],
        errors: [],
      })),
    });
    const { container, onSubmit, onClose } = renderFlow(client);

    fireEvent.change(fileInput(container), { target: { files: [pngFile()] } });

    // The confirm-portfolio step renders (count summary + Import button), not a draft table.
    await waitFor(() => expect(confirmBtn()).toBeInTheDocument());
    expect(screen.getByText(messages.Import.confirmPortfolio.title)).toBeInTheDocument();
    expect(client.importScreenshot).toHaveBeenCalledWith(expect.any(File), false);

    fireEvent.click(confirmBtn());

    // Sole portfolio is used as the target (no picker shown). The write is backgrounded.
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "materialize",
        acknowledge: false,
        expectedCount: 1,
        units: [{ importId: "imp1", portfolioId: "p1" }],
      }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    // The write itself is the provider's job — ImportFlow no longer calls the client.
    expect(client.materializeImport).not.toHaveBeenCalled();
  });

  it("auto-detects file type: CSV → importCsv, PNG → importScreenshot", async () => {
    const client = makeClient({
      importCsv: vi.fn(async () => ({ importId: "imp2c", drafts: [DRAFT], errors: [] })),
    });
    const { container } = renderFlow(client);

    fireEvent.change(fileInput(container), { target: { files: [csvFile("t.csv")] } });
    await waitFor(() => expect(client.importCsv).toHaveBeenCalled());
    expect(client.importCsv).toHaveBeenCalledWith(expect.any(String), "auto", false);
    expect(client.importScreenshot).not.toHaveBeenCalled();
  });

  it("pre-selects the suggested portfolio and targets it in the task", async () => {
    const client = makeClient({
      importCsv: vi.fn(async () => ({
        importId: "imp-s",
        drafts: [DRAFT],
        errors: [],
        // Account match → server suggests p2 (the matched portfolio).
        matchedPortfolioId: "p2",
        suggestedPortfolioId: "p2",
      })),
    });
    const { container, onSubmit } = renderFlow(client, [
      { id: "p1", name: "Main", brokerage: null, accountHolder: null },
      { id: "p2", name: "DKB", brokerage: null, accountHolder: null },
    ]);

    fireEvent.change(fileInput(container), { target: { files: [csvFile("dkb.csv")] } });

    await waitFor(() => expect(confirmBtn()).toBeInTheDocument());
    // The "pre-selected from the account number" note is shown.
    expect(screen.getByText(messages.Import.confirmPortfolio.matched)).toBeInTheDocument();

    fireEvent.click(confirmBtn());
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ units: [{ importId: "imp-s", portfolioId: "p2" }] }),
    );
  });

  it("targets a portfolio chosen on the confirm step", async () => {
    const client = makeClient({
      importCsv: vi.fn(async () => ({ importId: "imp4", drafts: [DRAFT], errors: [] })),
    });
    const { container, onSubmit, onClose } = renderFlow(client, [
      { id: "p1", name: "Main", brokerage: null, accountHolder: null },
      { id: "p2", name: "DKB", brokerage: null, accountHolder: null },
    ]);

    fireEvent.change(fileInput(container), { target: { files: [csvFile("t.csv")] } });
    await waitFor(() => expect(confirmBtn()).toBeInTheDocument());

    // Pick a different portfolio (rich Radix dropdown: Enter opens, click selects).
    fireEvent.keyDown(
      screen.getByRole("button", { name: messages.Import.targetPortfolio }),
      { key: "Enter" },
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /DKB/ }));

    fireEvent.click(confirmBtn());
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ units: [{ importId: "imp4", portfolioId: "p2" }] }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a parse-time account mismatch shows a banner; Import anyway submits with acknowledge (#197)", async () => {
    const client = makeClient({
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
    });
    const { onSubmit, onClose } = renderFlow(client, [
      { id: "p1", name: "Main", brokerage: null, accountHolder: null },
      { id: "p2", name: "Other", brokerage: null, accountHolder: null },
    ]);

    fireEvent.change(fileInput(document.body), { target: { files: [pngFile()] } });

    // The mismatch banner renders on the review step with an "Import anyway" button.
    const importAnyway = await screen.findByRole("button", {
      name: messages.Import.accountMismatch.importAnyway,
    });
    fireEvent.click(importAnyway);

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "materialize",
        acknowledge: true,
        units: [{ importId: "imp-mm", portfolioId: "p1" }],
      }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("reviews a gold installment contract and hands off a confirm task", async () => {
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
    const client = makeClient({
      importScreenshot: vi.fn(async () => ({
        importId: "imp-c",
        drafts: [],
        contracts: [contract],
        errors: [],
      })),
    });
    const { container, onSubmit, onClose } = renderFlow(client);

    fireEvent.change(fileInput(container), { target: { files: [pngFile()] } });

    await waitFor(() =>
      expect(screen.getByText(messages.Import.contract.title)).toBeInTheDocument(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: messages.Import.contract.confirm }),
    );

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "confirm",
        importId: "imp-c",
        contracts: [contract],
        portfolioId: "p1",
        acknowledge: false,
      }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    // Gold contracts never use the materialize path.
    expect(client.materializeImport).not.toHaveBeenCalled();
  });

  it("Phase 2: a server-materialized upload closes the modal without a submit task", async () => {
    refreshMock.mockClear();
    const client = makeClient({
      importCsv: vi.fn(async () => ({
        importId: "imp-p2",
        drafts: [],
        errors: [],
        materialized: true,
        materializedCount: 3,
      })),
    });
    const { container, onSubmit, onClose } = renderFlow(client);

    fireEvent.change(fileInput(container), { target: { files: [csvFile("dkb.csv")] } });

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    // The write already happened server-side, so there's nothing to background.
    expect(onSubmit).not.toHaveBeenCalled();
    expect(refreshMock).toHaveBeenCalled();
  });

  it("offers a force re-import when a file was already confirmed (#229)", async () => {
    const importCsv = vi
      .fn()
      .mockResolvedValueOnce({ importId: "imp-x", drafts: [], errors: [], alreadyConfirmed: true })
      .mockResolvedValueOnce({ importId: "imp-x2", drafts: [DRAFT], errors: [] });
    const client = makeClient({ importCsv });
    const { container } = renderFlow(client);

    fireEvent.change(fileInput(container), { target: { files: [csvFile("dup.csv")] } });

    await waitFor(() =>
      expect(screen.getByText(messages.Import.errors.alreadyConfirmed)).toBeInTheDocument(),
    );
    const reImport = screen.getByRole("button", { name: messages.Import.reImportAnyway });
    expect(importCsv).toHaveBeenLastCalledWith(expect.any(String), "auto", false);

    fireEvent.click(reImport);

    await waitFor(() =>
      expect(importCsv).toHaveBeenLastCalledWith(expect.any(String), "auto", true),
    );
    // Force re-import lands on the confirm-portfolio step.
    await waitFor(() => expect(confirmBtn()).toBeInTheDocument());
  });

  it("two CSV files → per-group confirm → materialize task fans out per import", async () => {
    const client = makeClient({
      importCsv: vi
        .fn()
        .mockResolvedValueOnce({ importId: "imp-a", drafts: [DRAFT], errors: [] })
        .mockResolvedValueOnce({ importId: "imp-b", drafts: [DRAFT_B], errors: [] }),
    });
    const { container, onSubmit } = renderFlow(client);

    fireEvent.change(fileInput(container), {
      target: { files: [csvFile("broker-a.csv", "a"), csvFile("broker-b.csv", "b")] },
    });

    // Both filenames show as group headings on the confirm step.
    await waitFor(() => expect(confirmBtn()).toBeInTheDocument());
    expect(screen.getAllByText("broker-a.csv").length).toBeGreaterThan(0);
    expect(screen.getAllByText("broker-b.csv").length).toBeGreaterThan(0);

    fireEvent.click(confirmBtn());
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "materialize",
        units: [
          { importId: "imp-a", portfolioId: "p1" },
          { importId: "imp-b", portfolioId: "p1" },
        ],
      }),
    );
  });

  it("skip & continue: one already-confirmed file is skipped, the rest proceeds", async () => {
    const client = makeClient({
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
    });
    const { container } = renderFlow(client);

    fireEvent.change(fileInput(container), {
      target: {
        files: [csvFile("good-a.csv", "a"), csvFile("dup.csv", "b"), csvFile("good-c.csv", "c")],
      },
    });

    await waitFor(() => expect(confirmBtn()).toBeInTheDocument());
    expect(screen.getAllByText("good-a.csv").length).toBeGreaterThan(0);
    expect(screen.getAllByText("good-c.csv").length).toBeGreaterThan(0);
    // Skip notice for the confirmed file (inside the collapsible banner).
    expect(
      screen.getByText(
        messages.Import.skipped.alreadyConfirmed.replace("{file}", "dup.csv"),
      ),
    ).toBeInTheDocument();
  });

  it("all files empty/duplicate → stays on upload with error notice", async () => {
    const client = makeClient({
      importCsv: vi
        .fn()
        .mockResolvedValueOnce({
          importId: "i1",
          drafts: [],
          errors: [],
          alreadyConfirmed: true,
        })
        .mockResolvedValueOnce({ importId: "i2", drafts: [], errors: [] }),
    });
    const { container, onSubmit } = renderFlow(client);

    fireEvent.change(fileInput(container), {
      target: { files: [csvFile("a.csv", "a"), csvFile("b.csv", "b")] },
    });

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.queryByText("a.csv")).not.toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("auto-parses a screenshot handed in via initialFile (share target)", async () => {
    const client = makeClient({
      importScreenshot: vi.fn(async () => ({
        importId: "imp5",
        drafts: [DRAFT],
        errors: [],
      })),
    });
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ImportFlow
          client={client}
          portfolios={[{ id: "p1", name: "Main", brokerage: null, accountHolder: null }]}
          defaultPortfolioId="p1"
          initialFile={pngFile()}
        />
      </NextIntlClientProvider>,
    );

    await waitFor(() => expect(confirmBtn()).toBeInTheDocument());
    expect(client.importScreenshot).toHaveBeenCalledTimes(1);
    expect(client.importScreenshot).toHaveBeenCalledWith(expect.any(File), false);
    expect(client.importCsv).not.toHaveBeenCalled();
  });

  it("surfaces the not-configured message on a 503", async () => {
    const client = makeClient({
      importScreenshot: vi.fn(async () => {
        throw Object.assign(new Error("x"), { status: 503 });
      }),
    });
    const { container } = renderFlow(client);

    fireEvent.change(fileInput(container), { target: { files: [pngFile()] } });

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        messages.Import.errors.notConfigured,
      ),
    );
  });
});
