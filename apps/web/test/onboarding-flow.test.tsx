import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, cleanup } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { useTheme } from "next-themes";
import messages from "../messages/en.json";

vi.mock("next-themes", () => ({ useTheme: vi.fn() }));

const push = vi.fn();
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push }),
}));

const createAccountHolder = vi.fn(async () => ({ id: "holder-1" }));
const updateAccountHolder = vi.fn(async () => ({ id: "holder-1" }));
const putPreferences = vi.fn(async () => ({}));
const createdPortfolio = {
  id: "portfolio-1",
  name: "My Portfolio",
  brokerage: null,
  accountHolder: "Björn",
};
const createPortfolio = vi.fn(async () => createdPortfolio);
const updatePortfolio = vi.fn(async () => createdPortfolio);
const completeOnboarding = vi.fn(async () => ({}));
const getTrConnection = vi.fn(async () => ({ status: "disconnected" }));

vi.mock("@/lib/api", () => ({
  useApiClient: () => ({
    createAccountHolder,
    updateAccountHolder,
    putPreferences,
    createPortfolio,
    updatePortfolio,
    completeOnboarding,
    getTrConnection,
  }),
}));

// Sub-flows are real app components with their own dependencies (ImportTasksProvider,
// TrConnectFlow's polling, etc.) — stubbed here since these tests only assert the
// onboarding flow reaches/renders the right sub-view, not those flows' own behavior
// (covered by their own test suites).
vi.mock("@/components/import-flow-client", () => ({
  ImportFlowClient: () => <div data-testid="import-flow" />,
}));
vi.mock("@/components/new-entry-tabs", () => ({
  NewEntryTabs: () => <div data-testid="entry-tabs" />,
}));
vi.mock("@/components/tr-connect-flow", () => ({
  TrConnectFlow: () => <div data-testid="tr-connect-flow" />,
}));

import { OnboardingFlow } from "../src/components/onboarding/onboarding-flow";

function renderFlow() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <OnboardingFlow />
    </NextIntlClientProvider>,
  );
}

function setViewport(width: number) {
  act(() => {
    Object.defineProperty(window, "innerWidth", {
      writable: true,
      configurable: true,
      value: width,
    });
    window.dispatchEvent(new Event("resize"));
  });
}

describe("OnboardingFlow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useTheme).mockReturnValue({
      resolvedTheme: "dark",
      setTheme: vi.fn(),
      theme: "dark",
      themes: ["light", "dark"],
      systemTheme: "dark",
    });
    // jsdom defaults to a desktop-sized window; make it explicit so isDesktop resolves
    // to true regardless of test order / prior viewport mutations.
    setViewport(1280);
  });

  afterEach(() => {
    cleanup();
  });

  it("starts on the Welcome step", () => {
    renderFlow();
    expect(screen.getByText(messages.Onboarding.steps.welcome.title)).toBeInTheDocument();
    expect(screen.getByText(messages.Onboarding.welcome.tourSectionLabel)).toBeInTheDocument();
  });

  it("blocks Continue on the Holder step until a name is entered, and validates birth year", () => {
    renderFlow();
    fireEvent.click(screen.getByRole("button", { name: /Get started/ }));
    expect(screen.getByText(messages.Onboarding.steps.holder.title)).toBeInTheDocument();

    // Empty name — blocked.
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    expect(screen.getByText(messages.Onboarding.holder.nameRequired)).toBeInTheDocument();
    expect(screen.getByText(messages.Onboarding.steps.holder.title)).toBeInTheDocument();

    // Name filled, bad birth year — blocked with a birth-year error.
    fireEvent.change(screen.getByPlaceholderText(messages.Onboarding.holder.namePlaceholder), {
      target: { value: "Björn" },
    });
    fireEvent.change(screen.getByPlaceholderText(messages.Onboarding.holder.birthYearPlaceholder), {
      target: { value: "1800" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    expect(screen.getByText(messages.Onboarding.steps.holder.title)).toBeInTheDocument();

    // Valid birth year — advances to the Tax step.
    fireEvent.change(screen.getByPlaceholderText(messages.Onboarding.holder.birthYearPlaceholder), {
      target: { value: "1990" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    expect(screen.getByText(messages.Onboarding.steps.tax.title)).toBeInTheDocument();
  });

  it("commits holder + preferences + portfolio on Create portfolio, in order, then advances to Add data", async () => {
    renderFlow();
    fireEvent.click(screen.getByRole("button", { name: /Get started/ }));
    fireEvent.change(screen.getByPlaceholderText(messages.Onboarding.holder.namePlaceholder), {
      target: { value: "Björn" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Continue/ })); // -> Tax
    fireEvent.click(screen.getByRole("button", { name: /Continue/ })); // -> Portfolio
    expect(screen.getByText(messages.Onboarding.steps.portfolio.title)).toBeInTheDocument();

    // Blocked without a portfolio name.
    fireEvent.click(screen.getByRole("button", { name: /Create portfolio/ }));
    expect(screen.getByText(messages.Onboarding.portfolio.nameRequired)).toBeInTheDocument();
    expect(createPortfolio).not.toHaveBeenCalled();

    // Portfolio name and Brokerage share the identical design placeholder
    // ("e.g. Trade Republic") — Portfolio name is the first match in DOM order.
    fireEvent.change(
      screen.getAllByPlaceholderText(messages.Onboarding.portfolio.namePlaceholder)[0],
      {
        target: { value: "My Portfolio" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: /Create portfolio/ }));

    await waitFor(() => expect(createPortfolio).toHaveBeenCalledTimes(1));
    expect(createAccountHolder).toHaveBeenCalledTimes(1);
    expect(putPreferences).toHaveBeenCalledWith({ taxRegime: "DE" });

    const holderOrder = createAccountHolder.mock.invocationCallOrder[0];
    const prefsOrder = putPreferences.mock.invocationCallOrder[0];
    const portfolioOrder = createPortfolio.mock.invocationCallOrder[0];
    expect(holderOrder).toBeLessThan(prefsOrder);
    expect(prefsOrder).toBeLessThan(portfolioOrder);

    await waitFor(() =>
      expect(screen.getByText(messages.Onboarding.steps.addData.title)).toBeInTheDocument(),
    );
  });

  it("'Skip for now' reaches Done with the portfolio-ready copy; 'Go to Holdings' completes onboarding and navigates", async () => {
    renderFlow();
    fireEvent.click(screen.getByRole("button", { name: /Get started/ }));
    fireEvent.change(screen.getByPlaceholderText(messages.Onboarding.holder.namePlaceholder), {
      target: { value: "Björn" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    // Portfolio name and Brokerage share the identical design placeholder
    // ("e.g. Trade Republic") — Portfolio name is the first match in DOM order.
    fireEvent.change(
      screen.getAllByPlaceholderText(messages.Onboarding.portfolio.namePlaceholder)[0],
      {
        target: { value: "My Portfolio" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: /Create portfolio/ }));
    await waitFor(() =>
      expect(screen.getByText(messages.Onboarding.steps.addData.title)).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByText(messages.Onboarding.addData.skipTitle));
    expect(screen.getByText(messages.Onboarding.done.heading)).toBeInTheDocument();
    expect(screen.getByText(messages.Onboarding.done.readySub)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: new RegExp(messages.Onboarding.done.cta) }));
    await waitFor(() => expect(completeOnboarding).toHaveBeenCalledTimes(1));
    expect(push).toHaveBeenCalledWith("/holdings");
  });

  it("'Skip setup' exits straight to holdings without reaching Done", async () => {
    renderFlow();
    fireEvent.click(screen.getByText(messages.Onboarding.skipSetup));
    await waitFor(() => expect(completeOnboarding).toHaveBeenCalledTimes(1));
    expect(push).toHaveBeenCalledWith("/holdings");
    expect(screen.queryByText(messages.Onboarding.done.heading)).not.toBeInTheDocument();
  });

  it("selecting 'Connect Trade Republic' on Add data shows the dedicated TR sub-step, not the portfolio dialog", async () => {
    renderFlow();
    fireEvent.click(screen.getByRole("button", { name: /Get started/ }));
    fireEvent.change(screen.getByPlaceholderText(messages.Onboarding.holder.namePlaceholder), {
      target: { value: "Björn" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    fireEvent.click(screen.getByRole("button", { name: /Continue/ }));
    // Portfolio name and Brokerage share the identical design placeholder
    // ("e.g. Trade Republic") — Portfolio name is the first match in DOM order.
    fireEvent.change(
      screen.getAllByPlaceholderText(messages.Onboarding.portfolio.namePlaceholder)[0],
      {
        target: { value: "My Portfolio" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: /Create portfolio/ }));
    await waitFor(() =>
      expect(screen.getByText(messages.Onboarding.steps.addData.title)).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByText(messages.Onboarding.addData.connectTitle));
    await waitFor(() => expect(screen.getByTestId("tr-connect-flow")).toBeInTheDocument());
    expect(screen.queryByText(messages.Onboarding.addData.manualTitle)).not.toBeInTheDocument();

    // Regression guard: Back from the TR sub-step must return to the add-data cards,
    // not be hidden or fall through to the Portfolio step.
    fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    expect(screen.getByText(messages.Onboarding.addData.manualTitle)).toBeInTheDocument();
    expect(screen.queryByTestId("tr-connect-flow")).not.toBeInTheDocument();
  });

  describe("mobile", () => {
    beforeEach(() => setViewport(390));
    afterEach(() => setViewport(1280));

    it("shows the branded intro carousel first, and Get started dismisses it into the steps", () => {
      renderFlow();
      expect(screen.getByText(messages.Onboarding.mobileIntro.slide1.headline)).toBeInTheDocument();

      // The underlying step content (with its own step-0 "Get started" CTA) is still
      // mounted behind the fixed-position intro overlay (matches the design's own DOM
      // shape) — the intro's button is the last match in document order.
      const getStartedButtons = screen.getAllByRole("button", {
        name: messages.Onboarding.mobileIntro.getStarted,
      });
      fireEvent.click(getStartedButtons[getStartedButtons.length - 1]);
      expect(screen.getByText(messages.Onboarding.steps.welcome.title)).toBeInTheDocument();
    });

    it("dots advance the carousel slide", () => {
      renderFlow();
      const dots = screen.getAllByRole("button", { name: "Go to slide" });
      expect(dots).toHaveLength(4);
      fireEvent.click(dots[2]);
      expect(screen.getByText(messages.Onboarding.mobileIntro.slide3.headline)).toBeInTheDocument();
    });
  });
});
