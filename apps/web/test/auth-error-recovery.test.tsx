import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

// The ?error code Auth.js puts on the callback-error redirect; mutate per test.
const search = { value: "" };

const { signInMock } = vi.hoisted(() => ({ signInMock: vi.fn() }));
vi.mock("next-auth/react", () => ({ signIn: signInMock }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search.value),
}));

import { AuthErrorRecovery } from "../src/components/auth-error-recovery";

function renderRecovery() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AuthErrorRecovery />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  signInMock.mockReset();
  sessionStorage.clear();
  search.value = "";
});

describe("AuthErrorRecovery", () => {
  it("auto-restarts a fresh sign-in for a recoverable callback error", () => {
    search.value = "error=Configuration";
    renderRecovery();

    expect(signInMock).toHaveBeenCalledWith("authentik", {
      callbackUrl: "/dashboard",
    });
    expect(screen.getByText(messages.AuthError.retrying)).toBeTruthy();
  });

  it("stops looping and shows a manual retry when a retry just failed", () => {
    // A retry fired moments ago → landing back here means the code exchange is really
    // failing, not just a stale code. Don't bounce again.
    sessionStorage.setItem("auth-callback-retry-at", String(Date.now()));
    search.value = "error=Configuration";
    renderRecovery();

    expect(signInMock).not.toHaveBeenCalled();
    expect(screen.getByText(messages.AuthError.title)).toBeTruthy();
  });

  it("does not auto-retry when the user cancelled consent (AccessDenied)", () => {
    search.value = "error=AccessDenied";
    renderRecovery();

    expect(signInMock).not.toHaveBeenCalled();
    expect(screen.getByText(messages.AuthError.deniedTitle)).toBeTruthy();
  });

  it("retries and clears the loop guard when the manual button is clicked", () => {
    sessionStorage.setItem("auth-callback-retry-at", String(Date.now()));
    search.value = "error=AccessDenied";
    renderRecovery();

    fireEvent.click(screen.getByRole("button", { name: messages.AuthError.retry }));

    expect(signInMock).toHaveBeenCalledWith("authentik", {
      callbackUrl: "/dashboard",
    });
    expect(sessionStorage.getItem("auth-callback-retry-at")).toBeNull();
  });
});
