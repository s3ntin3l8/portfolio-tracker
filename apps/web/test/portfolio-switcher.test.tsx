import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

const refresh = vi.fn();
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

import { PortfolioSwitcher } from "../src/components/portfolio-switcher";

function renderSwitcher(props: {
  portfolios: { id: string; name: string; brokerage: string | null; accountHolder: string | null }[];
  holders?: { id: string; name: string }[];
  selectedId: string | null;
  selectedHolderId?: string | null;
}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PortfolioSwitcher {...props} />
    </NextIntlClientProvider>,
  );
}

const trigger = () =>
  screen.getByRole("button", { name: messages.PortfolioSwitcher.label });

// Radix opens its dropdown on pointer/keyboard events, not a synthetic click; Enter on
// the focused trigger is the most reliable opener under jsdom.
function openMenu() {
  fireEvent.keyDown(trigger(), { key: "Enter" });
}

describe("PortfolioSwitcher", () => {
  beforeEach(() => {
    refresh.mockClear();
    document.cookie = "pf=; max-age=0; path=/";
  });

  it("renders nothing with no portfolios", () => {
    const { container } = renderSwitcher({
      portfolios: [],
      selectedId: null,
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a static label (no switcher) with exactly one portfolio and no holders", () => {
    renderSwitcher({
      portfolios: [{ id: "p1", name: "Main", brokerage: null, accountHolder: null }],
      selectedId: null,
    });
    // The single-portfolio scope indicator is non-interactive — no dropdown trigger.
    expect(
      screen.queryByRole("button", { name: messages.PortfolioSwitcher.label }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Main")).toBeInTheDocument();
  });

  it("shows the selected portfolio on the trigger, falling back to All", () => {
    const { rerender } = renderSwitcher({
      portfolios: [
        { id: "p1", name: "Main", brokerage: null, accountHolder: null },
        { id: "p2", name: "DKB", brokerage: null, accountHolder: null },
      ],
      selectedId: null,
    });
    expect(trigger()).toHaveTextContent(messages.PortfolioSwitcher.all);

    rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <PortfolioSwitcher
          portfolios={[
            { id: "p1", name: "Main", brokerage: null, accountHolder: null },
            { id: "p2", name: "DKB", brokerage: null, accountHolder: null },
          ]}
          selectedId="p2"
        />
      </NextIntlClientProvider>,
    );
    expect(trigger()).toHaveTextContent("DKB");
  });

  it("lists an All option plus each portfolio, appending the brokerage", () => {
    renderSwitcher({
      portfolios: [
        { id: "p1", name: "Main", brokerage: null, accountHolder: null },
        { id: "p2", name: "Euro", brokerage: "Trade Republic", accountHolder: null },
      ],
      selectedId: "p2",
    });
    openMenu();
    expect(
      screen.getByRole("menuitem", { name: messages.PortfolioSwitcher.all }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /Euro · Trade Republic/ }),
    ).toBeInTheDocument();
  });

  it("writes the cookie and refreshes when a portfolio is chosen", () => {
    renderSwitcher({
      portfolios: [
        { id: "p1", name: "Main", brokerage: null, accountHolder: null },
        { id: "p2", name: "DKB", brokerage: null, accountHolder: null },
      ],
      selectedId: null,
    });
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /DKB/ }));
    expect(document.cookie).toContain("pf=p2");
    expect(refresh).toHaveBeenCalled();
  });

  it("shows the Account holders section when qualifying holders are passed", () => {
    renderSwitcher({
      portfolios: [
        { id: "p1", name: "Main", brokerage: null, accountHolder: null },
        { id: "p2", name: "DKB",  brokerage: null, accountHolder: null },
      ],
      holders: [
        { id: "h1", name: "Self" },
        { id: "h2", name: "Child" },
      ],
      selectedId: null,
    });
    openMenu();
    // Section header is rendered as a non-interactive label.
    expect(screen.getByText(messages.PortfolioSwitcher.accountHolders)).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Self/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Child/ })).toBeInTheDocument();
  });

  it("writes pf=holder:<id> and refreshes when a holder row is chosen", () => {
    renderSwitcher({
      portfolios: [
        { id: "p1", name: "Main", brokerage: null, accountHolder: null },
        { id: "p2", name: "DKB",  brokerage: null, accountHolder: null },
      ],
      holders: [{ id: "h1", name: "Self" }],
      selectedId: null,
    });
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Self/ }));
    // document.cookie doesn't encode `:` — the raw value is `holder:h1`.
    expect(document.cookie).toContain("pf=holder:h1");
    expect(refresh).toHaveBeenCalled();
  });

  it("shows holder name on the trigger when selectedHolderId is set", () => {
    renderSwitcher({
      portfolios: [
        { id: "p1", name: "Main", brokerage: null, accountHolder: null },
        { id: "p2", name: "DKB",  brokerage: null, accountHolder: null },
      ],
      holders: [{ id: "h1", name: "Self" }],
      selectedId: null,
      selectedHolderId: "h1",
    });
    expect(trigger()).toHaveTextContent("Self");
    // Must not show "All" or any portfolio name.
    expect(trigger()).not.toHaveTextContent(messages.PortfolioSwitcher.all);
  });

  it("does not show the Account holders section when no holders are passed", () => {
    renderSwitcher({
      portfolios: [
        { id: "p1", name: "Main", brokerage: null, accountHolder: null },
        { id: "p2", name: "DKB",  brokerage: null, accountHolder: null },
      ],
      selectedId: null,
    });
    openMenu();
    expect(screen.queryByText(messages.PortfolioSwitcher.accountHolders)).not.toBeInTheDocument();
  });

  it("shows the dropdown (not a static label) when a holder qualifies, even with 1 portfolio", () => {
    // A single portfolio + a qualifying holder → should show the dropdown, not the static label.
    renderSwitcher({
      portfolios: [{ id: "p1", name: "Solo", brokerage: null, accountHolder: null }],
      holders: [{ id: "h1", name: "Self" }],
      selectedId: null,
    });
    expect(trigger()).toBeInTheDocument();
  });
});
