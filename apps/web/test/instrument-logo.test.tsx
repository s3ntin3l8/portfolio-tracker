import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { MARKET_YAHOO_SUFFIX } from "@portfolio/market-data";
import { InstrumentLogo, MARKET_LOGO_SUFFIX } from "../src/components/instrument-logo";

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

  it("recovers the logo when a new, resolvable instrument replaces an errored one", () => {
    // Regression test: call sites like the "selected instrument" chip in
    // add-transaction-form.tsx render this component at a stable tree position with no
    // `key`, so switching instruments reuses the same instance (rerender, not a fresh
    // render) rather than remounting it.
    const { container, rerender } = render(
      <InstrumentLogo label="MISS" symbol="MISS" market="US" assetClass="equity" />,
    );
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container).toHaveTextContent("MI");

    rerender(<InstrumentLogo label="AAPL" symbol="AAPL" market="US" assetClass="equity" />);
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toContain("ticker/AAPL?");
  });

  it("keeps the market-suffix map in sync with the server's yahooSuffixForMarket table", () => {
    // Both are hand-maintained copies of the same suffixes (the client one can't import
    // the server-side market-data package into the bundle) — nothing else would catch
    // them drifting apart if a market is added to one but not the other.
    expect(MARKET_LOGO_SUFFIX).toEqual(MARKET_YAHOO_SUFFIX);
  });
});
