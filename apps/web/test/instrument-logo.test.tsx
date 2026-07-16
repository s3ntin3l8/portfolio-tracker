import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { InstrumentLogo } from "../src/components/instrument-logo";

const ORIGINAL_TOKEN = process.env.NEXT_PUBLIC_LOGODEV_TOKEN;

describe("InstrumentLogo", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_LOGODEV_TOKEN = "pk_test123";
  });

  afterEach(() => {
    process.env.NEXT_PUBLIC_LOGODEV_TOKEN = ORIGINAL_TOKEN;
  });

  it("looks up an IDX equity with the .JK suffix", () => {
    const { container } = render(
      <InstrumentLogo label="BBCA" symbol="BBCA" market="IDX" assetClass="equity" />,
    );
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toContain("ticker/BBCA.JK");
    expect(img?.getAttribute("src")).toContain("token=pk_test123");
  });

  it("looks up a Xetra equity with the .DE suffix", () => {
    const { container } = render(
      <InstrumentLogo label="SAP" symbol="SAP" market="XETRA" assetClass="equity" />,
    );
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toContain("ticker/SAP.DE");
  });

  it("looks up a US equity with the bare ticker", () => {
    const { container } = render(
      <InstrumentLogo label="AAPL" symbol="AAPL" market="US" assetClass="equity" />,
    );
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toContain("ticker/AAPL?");
  });

  it("looks up crypto via the crypto/ path, ignoring market", () => {
    const { container } = render(
      <InstrumentLogo label="BTC" symbol="BTC" market="CRYPTO" assetClass="crypto" />,
    );
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toContain("crypto/BTC");
  });

  it.each(["gold", "cash", "bond", "mutual_fund", "derivative"])(
    "renders the monogram fallback for %s, never a logo.dev lookup",
    (assetClass) => {
      const { container } = render(
        <InstrumentLogo label="Antam Gold" symbol="ANTM" market="ANTAM" assetClass={assetClass} />,
      );
      expect(container.querySelector("img")).toBeNull();
      expect(container).toHaveTextContent("AG");
    },
  );

  it("falls back to the monogram when the image errors (e.g. logo.dev 404)", () => {
    const { container } = render(
      <InstrumentLogo label="AAPL" symbol="AAPL" market="US" assetClass="equity" />,
    );
    const img = container.querySelector("img")!;
    fireEvent.error(img);
    expect(container.querySelector("img")).toBeNull();
    expect(container).toHaveTextContent("AA");
  });

  it("falls back to the monogram when no token is configured", () => {
    delete process.env.NEXT_PUBLIC_LOGODEV_TOKEN;
    const { container } = render(
      <InstrumentLogo label="AAPL" symbol="AAPL" market="US" assetClass="equity" />,
    );
    expect(container.querySelector("img")).toBeNull();
  });

  it("falls back to the monogram when no symbol is available", () => {
    const { container } = render(<InstrumentLogo label="Cash" market="US" assetClass="equity" />);
    expect(container.querySelector("img")).toBeNull();
  });
});
