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
  portfolios: { id: string; name: string; brokerage: string | null }[];
  selectedId: string | null;
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

  it("renders nothing with fewer than two portfolios", () => {
    const { container } = renderSwitcher({
      portfolios: [{ id: "p1", name: "Main", brokerage: null }],
      selectedId: null,
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the selected portfolio on the trigger, falling back to All", () => {
    const { rerender } = renderSwitcher({
      portfolios: [
        { id: "p1", name: "Main", brokerage: null },
        { id: "p2", name: "DKB", brokerage: null },
      ],
      selectedId: null,
    });
    expect(trigger()).toHaveTextContent(messages.PortfolioSwitcher.all);

    rerender(
      <NextIntlClientProvider locale="en" messages={messages}>
        <PortfolioSwitcher
          portfolios={[
            { id: "p1", name: "Main", brokerage: null },
            { id: "p2", name: "DKB", brokerage: null },
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
        { id: "p1", name: "Main", brokerage: null },
        { id: "p2", name: "Euro", brokerage: "Trade Republic" },
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
        { id: "p1", name: "Main", brokerage: null },
        { id: "p2", name: "DKB", brokerage: null },
      ],
      selectedId: null,
    });
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /DKB/ }));
    expect(document.cookie).toContain("pf=p2");
    expect(refresh).toHaveBeenCalled();
  });
});
