import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { WifiOff } from "lucide-react";
import { ErrorState } from "../src/components/error-state";

describe("ErrorState", () => {
  it("renders eyebrow, title, body, code, meta and actions", () => {
    render(
      <ErrorState
        icon={WifiOff}
        tone="warn"
        eyebrow="500"
        title="Something slipped on our side"
        body="Try again in a moment."
        code="REF · A3F9-22C1"
        meta="Last synced 2 minutes ago"
        primary={<button type="button">Try again</button>}
        secondary={<a href="#go">Go home</a>}
      />,
    );

    expect(screen.getByText("500")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Something slipped on our side" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Try again in a moment.")).toBeInTheDocument();
    expect(screen.getByText("REF · A3F9-22C1")).toBeInTheDocument();
    expect(screen.getByText("Last synced 2 minutes ago")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go home" })).toBeInTheDocument();
  });

  it("omits optional slots when not provided", () => {
    render(<ErrorState icon={WifiOff} title="You're offline" body="Check your connection." />);

    expect(screen.getByRole("heading", { name: "You're offline" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
