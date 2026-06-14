import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { Landing } from "../src/components/landing";
import messages from "../messages/en.json";

describe("Landing", () => {
  it("renders the title, asset chips and CTA", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <Landing />
      </NextIntlClientProvider>,
    );

    expect(
      screen.getByRole("heading", { name: messages.Landing.title }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: messages.Landing.cta }),
    ).toBeInTheDocument();
    expect(screen.getByText(messages.Landing.assets.gold)).toBeInTheDocument();
  });
});
