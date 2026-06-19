import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { forwardRef } from "react";
import messages from "../messages/en.json";

// Mock i18n navigation: render Link as an anchor that forwards ref + the props Radix's
// `asChild` Slot injects (role, tabindex…) so roving focus can find the menu items.
vi.mock("@/i18n/navigation", () => ({
  Link: forwardRef<HTMLAnchorElement, React.ComponentPropsWithoutRef<"a">>(
    function Link({ children, ...props }, ref) {
      return (
        <a ref={ref} {...props}>
          {children}
        </a>
      );
    },
  ),
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/transactions",
}));

// The menu calls useApiClient() at render; the import sheet (closed by default) never
// mounts, so a stub client is enough.
vi.mock("@/lib/api", () => ({
  useApiClient: () => ({ listPortfolios: vi.fn(async () => []) }),
}));

import { AddTransactionMenu } from "../src/components/add-transaction-menu";

function renderMenu() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AddTransactionMenu />
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
      "/corporate-actions/new",
    );
  });
});
