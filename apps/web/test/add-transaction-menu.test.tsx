import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

const search = { value: "" };

// next/navigation's useSearchParams drives the auto-open effect.
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search.value),
}));

const replace = vi.fn();
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/transactions",
}));

vi.mock("@/lib/api", () => ({
  useApiClient: () => ({ listPortfolios: vi.fn(async () => []) }),
}));

// Stub the heavy flows — we only assert the right step/sheet renders.
vi.mock("@/components/import-flow-client", () => ({
  ImportFlowClient: () => <div data-testid="import-flow" />,
}));
vi.mock("@/components/new-entry-tabs", () => ({
  NewEntryTabs: () => <div data-testid="entry-tabs" />,
}));

import { AddTransactionMenu } from "../src/components/add-transaction-menu";

function renderMenu(props: { autoOpenFromParams?: boolean } = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AddTransactionMenu {...props} />
    </NextIntlClientProvider>,
  );
}

function openMenu() {
  fireEvent.click(
    screen.getByRole("button", { name: messages.Manage.addTransaction }),
  );
}

describe("AddTransactionMenu", () => {
  beforeEach(() => {
    search.value = "";
    replace.mockClear();
  });

  it("opens the add sheet with the three reference method cards", () => {
    renderMenu();
    openMenu();

    expect(
      screen.getByRole("dialog", { name: messages.Manage.addMenu.title }),
    ).toBeInTheDocument();
    expect(screen.getByText(messages.Manage.addMenu.screenshot)).toBeInTheDocument();
    expect(screen.getByText(messages.Manage.addMenu.recommended)).toBeInTheDocument();
    expect(screen.getByText(messages.Manage.addMenu.csv)).toBeInTheDocument();
    expect(screen.getByText(messages.Manage.addMenu.manual)).toBeInTheDocument();
  });

  it("swaps to the in-sheet manual entry tabs from the manual card", async () => {
    renderMenu();
    openMenu();
    fireEvent.click(screen.getByText(messages.Manage.addMenu.manual));
    await waitFor(() => expect(screen.getByTestId("entry-tabs")).toBeInTheDocument());
    // ...and a back button returns to the method cards.
    fireEvent.click(screen.getByRole("button", { name: messages.Manage.back }));
    expect(screen.getByText(messages.Manage.addMenu.screenshot)).toBeInTheDocument();
  });

  it("opens the import sheet from the screenshot card and closes the add sheet", async () => {
    renderMenu();
    openMenu();
    fireEvent.click(screen.getByText(messages.Manage.addMenu.screenshot));

    await waitFor(() =>
      expect(
        screen.getByRole("dialog", { name: messages.Import.title }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("dialog", { name: messages.Manage.addMenu.title }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("import-flow")).toBeInTheDocument();
  });

  // Regression test for #471: the CSV card called the same `openImport()` path as
  // screenshot but closing one Drawer.Root and opening a second in the same tick raced
  // vaul's body-scroll-lock cleanup, so the import sheet never became interactive.
  it("opens the import sheet from the CSV card too", async () => {
    renderMenu();
    openMenu();
    fireEvent.click(screen.getByText(messages.Manage.addMenu.csv));

    await waitFor(() =>
      expect(
        screen.getByRole("dialog", { name: messages.Import.title }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByTestId("import-flow")).toBeInTheDocument();
  });

  it("returns from the import step to the method cards via back, without closing the sheet", async () => {
    renderMenu();
    openMenu();
    fireEvent.click(screen.getByText(messages.Manage.addMenu.screenshot));
    await waitFor(() =>
      expect(
        screen.getByRole("dialog", { name: messages.Import.title }),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole("button", { name: messages.Manage.back }));

    expect(
      screen.getByRole("dialog", { name: messages.Manage.addMenu.title }),
    ).toBeInTheDocument();
    expect(screen.getByText(messages.Manage.addMenu.csv)).toBeInTheDocument();
  });

  it("keeps the import sheet closed without a share/import param", () => {
    renderMenu();
    expect(
      screen.queryByRole("dialog", { name: messages.Import.title }),
    ).not.toBeInTheDocument();
  });

  it("auto-opens the import sheet on ?import=1 and clears the flag", async () => {
    search.value = "import=1";
    renderMenu({ autoOpenFromParams: true });
    await waitFor(() =>
      expect(
        screen.getByRole("dialog", { name: messages.Import.title }),
      ).toBeInTheDocument(),
    );
    expect(replace).toHaveBeenCalledWith("/transactions");
  });

  it("auto-opens on ?shared=1 but leaves the param for ImportFlowClient", async () => {
    search.value = "shared=1";
    renderMenu({ autoOpenFromParams: true });
    await waitFor(() =>
      expect(
        screen.getByRole("dialog", { name: messages.Import.title }),
      ).toBeInTheDocument(),
    );
    expect(replace).not.toHaveBeenCalled();
  });

  it("ignores share/import params without autoOpenFromParams (only one instance owns it)", async () => {
    search.value = "import=1";
    renderMenu();
    await Promise.resolve();
    expect(
      screen.queryByRole("dialog", { name: messages.Import.title }),
    ).not.toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });
});
