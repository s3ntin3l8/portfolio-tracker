import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

const { signInMock } = vi.hoisted(() => ({ signInMock: vi.fn() }));
vi.mock("next-auth/react", () => ({ signIn: signInMock }));

import { Landing } from "../src/components/landing";

function renderLanding() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <Landing />
    </NextIntlClientProvider>,
  );
}

describe("Landing (Pocket split-hero sign-in)", () => {
  beforeEach(() => signInMock.mockReset());

  it("renders the sign-in hero, SSO CTA and connected brokerages", () => {
    renderLanding();

    expect(
      screen.getByRole("heading", { name: messages.Landing.signInTitle }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: messages.Landing.sso }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Trade Republic · IBKR · DKB"),
    ).toBeInTheDocument();
  });

  it("starts Authentik sign-in to /holdings from the SSO button", () => {
    renderLanding();

    fireEvent.click(screen.getByRole("button", { name: messages.Landing.sso }));

    expect(signInMock).toHaveBeenCalledWith("authentik", {
      callbackUrl: "/holdings",
    });
  });

  it("routes the email form through Authentik too (OIDC is the only auth)", () => {
    renderLanding();

    fireEvent.click(screen.getByRole("button", { name: messages.Landing.signIn }));

    expect(signInMock).toHaveBeenCalledWith("authentik", {
      callbackUrl: "/holdings",
    });
  });
});
