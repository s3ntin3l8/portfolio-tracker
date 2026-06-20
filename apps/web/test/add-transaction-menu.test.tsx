import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { forwardRef } from "react";
import messages from "../messages/en.json";

const search = { value: "" };

// next/navigation's useSearchParams drives the auto-open effect.
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search.value),
}));

// Render Link as an anchor that forwards ref + the props Radix's `asChild` Slot injects
// (role, tabindex…) so roving focus can find the menu items. Serialize the next-intl
// object href form ({pathname, query}) the way real next-intl does, so the test asserts
// the query survives.
const replace = vi.fn();
function hrefToString(href: unknown): string {
  if (typeof href === "string") return href;
  const { pathname, query } = href as {
    pathname: string;
    query?: Record<string, string>;
  };
  const qs = query ? new URLSearchParams(query).toString() : "";
  return qs ? `${pathname}?${qs}` : pathname;
}
vi.mock("@/i18n/navigation", () => ({
  Link: forwardRef<HTMLAnchorElement, { href: unknown; children?: React.ReactNode }>(
    function Link({ children, href, ...props }, ref) {
      return (
        <a ref={ref} href={hrefToString(href)} {...props}>
          {children}
        </a>
      );
    },
  ),
  useRouter: () => ({ replace }),
  usePathname: () => "/transactions",
}));

vi.mock("@/lib/api", () => ({
  useApiClient: () => ({ listPortfolios: vi.fn(async () => []) }),
}));

// Stub the heavy import flow — we only assert the sheet opens.
vi.mock("@/components/import-flow-client", () => ({
  ImportFlowClient: () => <div data-testid="import-flow" />,
}));

import { AddTransactionMenu } from "../src/components/add-transaction-menu";

function renderMenu(props: { autoOpenFromParams?: boolean } = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AddTransactionMenu {...props} />
    </NextIntlClientProvider>,
  );
}

// Radix opens its dropdown on keyboard/pointer events, not a synthetic click; Enter on
// the focused trigger is the most reliable opener under jsdom.
function openMenu() {
  const trigger = screen.getByRole("button", {
    name: messages.Manage.addTransaction,
  });
  fireEvent.keyDown(trigger, { key: "Enter" });
}

describe("AddTransactionMenu", () => {
  beforeEach(() => {
    search.value = "";
    replace.mockClear();
  });

  it("offers manual entry, import, and a corporate-action shortcut", () => {
    renderMenu();
    openMenu();

    const manual = screen.getByRole("menuitem", {
      name: messages.Import.menu.manual,
    });
    expect(manual.closest("a")).toHaveAttribute("href", "/transactions/new");

    expect(
      screen.getByRole("menuitem", { name: messages.Import.menu.import }),
    ).toBeInTheDocument();

    const corpAction = screen.getByRole("menuitem", {
      name: messages.CorpAction.link,
    });
    expect(corpAction.closest("a")).toHaveAttribute(
      "href",
      "/transactions/new?kind=corporate-action",
    );
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
    // Give the (gated) effect a chance to run, then confirm it stayed closed.
    await Promise.resolve();
    expect(
      screen.queryByRole("dialog", { name: messages.Import.title }),
    ).not.toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });
});
