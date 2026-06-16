import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import {
  UpdateProfileForm,
  type UpdateProfileClient,
} from "../src/components/update-profile-form";
import messages from "../messages/en.json";

function renderForm(
  client: UpdateProfileClient,
  initial = { initialName: "Björn", initialCurrency: "IDR" },
  onSuccess = vi.fn(),
) {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <UpdateProfileForm
        client={client}
        initialName={initial.initialName}
        initialCurrency={initial.initialCurrency}
        onSuccess={onSuccess}
      />
    </NextIntlClientProvider>,
  );
  return onSuccess;
}

describe("UpdateProfileForm", () => {
  it("saves only the changed fields", async () => {
    const client: UpdateProfileClient = {
      updateMe: vi.fn(async () => ({
        id: "u1",
        authSub: "sub",
        email: "a@b.c",
        name: "Björn",
        displayCurrency: "USD",
        isAdmin: false,
      })),
    };
    const onSuccess = renderForm(client);

    // Only change the currency; name is untouched.
    fireEvent.change(screen.getByLabelText(messages.Settings.displayCurrency), {
      target: { value: "USD" },
    });
    fireEvent.click(screen.getByRole("button", { name: messages.Settings.save }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(client.updateMe).toHaveBeenCalledWith({ displayCurrency: "USD" });
  });

  it("disables save until something changes, then shows saved", async () => {
    const client: UpdateProfileClient = {
      updateMe: vi.fn(async () => ({
        id: "u1",
        authSub: "sub",
        email: "a@b.c",
        name: "Anya",
        displayCurrency: "IDR",
        isAdmin: false,
      })),
    };
    renderForm(client);

    const save = screen.getByRole("button", { name: messages.Settings.save });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText(messages.Settings.name), {
      target: { value: "Anya" },
    });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() =>
      expect(screen.getByText(messages.Settings.saved)).toBeInTheDocument(),
    );
    expect(client.updateMe).toHaveBeenCalledWith({ name: "Anya" });
  });

  it("shows an error when saving fails", async () => {
    const client: UpdateProfileClient = {
      updateMe: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    renderForm(client);

    fireEvent.change(screen.getByLabelText(messages.Settings.name), {
      target: { value: "X" },
    });
    fireEvent.click(screen.getByRole("button", { name: messages.Settings.save }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        messages.Settings.updateError,
      ),
    );
  });
});
