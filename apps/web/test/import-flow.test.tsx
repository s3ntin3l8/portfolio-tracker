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

function renderFlow(client: ImportClient) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ImportFlow client={client} portfolioId="p1" />
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

    await waitFor(() =>
      expect(screen.getByDisplayValue("Antam Gold")).toBeInTheDocument(),
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
    expect(client.importCsv).toHaveBeenCalledWith("p1", expect.any(String), "generic");
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
    fireEvent.click(screen.getByRole("radio", { name: messages.Import.csvFormat.dkb }));
    const csv = new File(["Datum der Erstellung;..."], "dkb.csv", { type: "text/csv" });
    fireEvent.change(fileInput(container), { target: { files: [csv] } });

    await waitFor(() =>
      expect(client.importCsv).toHaveBeenCalledWith("p1", expect.any(String), "dkb"),
    );
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
