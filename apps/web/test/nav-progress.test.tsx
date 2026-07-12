import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { NavProgressProvider, LinkPendingSignal } from "../src/components/nav-progress";

// LinkPendingSignal calls next/link's real `useLinkStatus`, which returns its default
// `{ pending: false }` outside an actual <Link> (no router context needed, matching
// useFormStatus-style behavior) — so it renders standalone here without a fake `<Link>`.

function getBar(container: HTMLElement) {
  return container.querySelector("[aria-hidden]") as HTMLElement;
}

describe("NavProgressProvider", () => {
  it("renders a hidden (opacity-0) progress bar when nothing is pending", () => {
    const { container } = render(
      <NavProgressProvider>
        <div>content</div>
      </NavProgressProvider>,
    );

    expect(getBar(container)).toHaveClass("opacity-0");
  });

  it("does not throw when a LinkPendingSignal reports its (default, non-pending) status", () => {
    const { container } = render(
      <NavProgressProvider>
        <LinkPendingSignal id="test" />
      </NavProgressProvider>,
    );

    // Outside a real <Link>, useLinkStatus() defaults to not-pending, so the bar stays hidden.
    expect(getBar(container)).toHaveClass("opacity-0");
  });
});
