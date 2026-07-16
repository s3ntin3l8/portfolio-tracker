import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import {
  AdminImportSettingsForm,
  type AdminImportSettingsClient,
} from "../src/components/admin-import-settings-form";
import messages from "../messages/en.json";

const m = messages.Admin;

function renderForm(
  client: AdminImportSettingsClient,
  initialStrategy: "parser_first" | "vision_only" = "parser_first",
  onSuccess = vi.fn(),
) {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AdminImportSettingsForm
        client={client}
        initialStrategy={initialStrategy}
        onSuccess={onSuccess}
      />
    </NextIntlClientProvider>,
  );
  return onSuccess;
}

const PARSER = /Deterministic parser first/;
const VISION = /Always use vision AI/;

describe("AdminImportSettingsForm", () => {
  it("reflects the initial strategy and offers both selectable options", () => {
    renderForm({ updateAdminImportSettings: vi.fn() }, "vision_only");
    const parser = screen.getByRole("radio", { name: PARSER });
    const vision = screen.getByRole("radio", { name: VISION });
    expect(vision).toHaveAttribute("aria-checked", "true");
    expect(parser).toHaveAttribute("aria-checked", "false");
  });

  it("disables save until the strategy changes, then saves and shows saved", async () => {
    const client: AdminImportSettingsClient = {
      updateAdminImportSettings: vi.fn(async () => ({ strategy: "vision_only" as const })),
    };
    const onSuccess = renderForm(client, "parser_first");

    const save = screen.getByRole("button", { name: m.importStrategySave });
    expect(save).toBeDisabled();

    fireEvent.click(screen.getByRole("radio", { name: VISION }));
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(client.updateAdminImportSettings).toHaveBeenCalledWith({
      strategy: "vision_only",
    });
    expect(screen.getByText(m.importStrategySaved)).toBeInTheDocument();
  });

  it("shows an error when saving fails", async () => {
    const client: AdminImportSettingsClient = {
      updateAdminImportSettings: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    renderForm(client, "parser_first");

    fireEvent.click(screen.getByRole("radio", { name: VISION }));
    fireEvent.click(screen.getByRole("button", { name: m.importStrategySave }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(m.importStrategyError));
  });
});
