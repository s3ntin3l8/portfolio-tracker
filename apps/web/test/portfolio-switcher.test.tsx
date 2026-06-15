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
  portfolios: { id: string; name: string }[];
  selectedId: string | null;
}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PortfolioSwitcher {...props} />
    </NextIntlClientProvider>,
  );
}

describe("PortfolioSwitcher", () => {
  beforeEach(() => {
    refresh.mockClear();
    document.cookie = "pf=; max-age=0; path=/";
  });

  it("renders nothing with fewer than two portfolios", () => {
    const { container } = renderSwitcher({
      portfolios: [{ id: "p1", name: "Main" }],
      selectedId: null,
    });
    expect(container.querySelector("select")).toBeNull();
  });

  it("offers an All option plus each portfolio, reflecting the selection", () => {
    renderSwitcher({
      portfolios: [
        { id: "p1", name: "Main" },
        { id: "p2", name: "DKB" },
      ],
      selectedId: "p2",
    });
    const select = screen.getByLabelText(
      messages.PortfolioSwitcher.label,
    ) as HTMLSelectElement;
    expect(select.value).toBe("p2");
    expect(
      screen.getByRole("option", { name: messages.PortfolioSwitcher.all }),
    ).toBeInTheDocument();
  });

  it("writes the cookie and refreshes when a portfolio is chosen", () => {
    renderSwitcher({
      portfolios: [
        { id: "p1", name: "Main" },
        { id: "p2", name: "DKB" },
      ],
      selectedId: null,
    });
    fireEvent.change(screen.getByLabelText(messages.PortfolioSwitcher.label), {
      target: { value: "p2" },
    });
    expect(document.cookie).toContain("pf=p2");
    expect(refresh).toHaveBeenCalled();
  });
});
