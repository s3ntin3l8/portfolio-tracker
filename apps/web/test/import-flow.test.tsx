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
    expect(client.confirmImport).toHaveBeenCalledWith("imp1", [DRAFT]);
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
    expect(client.confirmImport).toHaveBeenCalledWith("imp1", [
      { ...DRAFT, name: "Antam Gold 2" },
    ]);
  });

  it("sends CSV text when the CSV tab is selected", async () => {
    const client: ImportClient = {
      importScreenshot: vi.fn(),
      importCsv: vi.fn(async () => ({ importId: "imp2", drafts: [DRAFT], errors: [] })),
      confirmImport: vi.fn(),
    };
    const { container } = renderFlow(client);

    fireEvent.click(screen.getByRole("button", { name: messages.Import.tabs.csv }));
    const csv = new File(["date,action\n2026-01-01,buy"], "t.csv", { type: "text/csv" });
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
    const csv = new File(["Datum der Erstellung;..."], "dkb.csv", { type: "text/csv" });
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
    const csv = new File(["date,action\n2026-01-01,buy"], "t.csv", { type: "text/csv" });
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
});
