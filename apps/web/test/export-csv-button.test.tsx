import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { ExportCsvButton } from "../src/components/export-csv-button";

function renderBtn(rows: (string | number)[][]) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ExportCsvButton filename="x.csv" headers={["a"]} rows={rows} label="Export CSV" />
    </NextIntlClientProvider>,
  );
}

describe("ExportCsvButton", () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
  });

  it("builds a CSV blob and triggers a download on click", () => {
    renderBtn([["1"]]);
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it("is disabled when there is nothing to export", () => {
    renderBtn([]);
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeDisabled();
  });
});
