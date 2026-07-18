import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DoneStep } from "../src/components/onboarding/steps/done-step";
import { darkTh } from "../src/components/onboarding/theme";

// The full flow can only reach Done with a portfolio already created (see
// onboarding-flow.tsx — step 4 is unreachable without one), so the
// `portfolioCreated={false}` branch is exercised directly here rather than through
// end-to-end navigation. It's still required correctness: per the task spec, any
// future path that skips portfolio creation before reaching Done (were one added)
// must not claim "Your portfolio is ready".
const copy = {
  heading: "You're all set",
  readySub: "Your portfolio is ready. Welcome to Pocket.",
  skippedSub: "Welcome to Pocket. Create a portfolio any time to start tracking.",
  cta: "Go to Holdings",
};

describe("DoneStep", () => {
  it("shows the portfolio-ready copy when a portfolio was created", () => {
    render(<DoneStep th={darkTh} copy={copy} portfolioCreated onFinish={vi.fn()} />);
    expect(screen.getByText(copy.readySub)).toBeInTheDocument();
    expect(screen.queryByText(copy.skippedSub)).not.toBeInTheDocument();
  });

  it("shows the skipped copy — never claims the portfolio is ready — when it wasn't", () => {
    render(<DoneStep th={darkTh} copy={copy} portfolioCreated={false} onFinish={vi.fn()} />);
    expect(screen.getByText(copy.skippedSub)).toBeInTheDocument();
    expect(screen.queryByText(copy.readySub)).not.toBeInTheDocument();
  });

  it("calls onFinish when the CTA is clicked", () => {
    const onFinish = vi.fn();
    render(<DoneStep th={darkTh} copy={copy} portfolioCreated onFinish={onFinish} />);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(copy.cta) }));
    expect(onFinish).toHaveBeenCalledTimes(1);
  });
});
