import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { BrokerageIcon } from "../src/components/brokerage-icon";

describe("BrokerageIcon", () => {
  it("renders the bundled logo for a known brokerage", () => {
    render(<BrokerageIcon brokerage="Trade Republic" />);
    const icon = screen.getByRole("img", { name: "Trade Republic" });
    expect(icon).toBeInTheDocument();
    const imgs = icon.querySelectorAll("img");
    expect(imgs.length).toBeGreaterThan(0);
    expect([...imgs].some((i) => i.getAttribute("src")?.includes("trade-republic"))).toBe(true);
  });

  it("renders a monogram fallback for an unknown brokerage", () => {
    render(<BrokerageIcon brokerage="My Local Broker" />);
    const icon = screen.getByRole("img", { name: "My Local Broker" });
    expect(icon).toHaveTextContent("ML");
    expect(icon.querySelector("img")).toBeNull();
  });

  it("renders nothing for an empty brokerage", () => {
    const { container } = render(<BrokerageIcon brokerage={null} />);
    expect(container.firstChild).toBeNull();
  });
});
