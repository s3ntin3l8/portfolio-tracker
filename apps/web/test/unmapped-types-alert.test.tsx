import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type * as React from "react";
import type { UnmappedEventType } from "@portfolio/api-client";

// Identity translator: returns the key, and for `title` echoes the count so we can assert it.
vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(async () => (key: string, vars?: Record<string, unknown>) =>
    vars && "count" in vars ? `${key}:${vars.count}` : key,
  ),
}));

const { UnmappedTypesAlert } = await import("../src/components/unmapped-types-alert");

const TYPES: UnmappedEventType[] = [
  {
    eventType: "TAXES",
    code: "unmapped_event_type",
    message: "unmapped event type: TAXES",
    count: 3,
    lastSeen: "2026-06-20T00:00:00.000Z",
    sample: { amount: -1.23 },
  },
  {
    eventType: null,
    code: "unparseable_event",
    message: "unparseable event: eventType Required",
    count: 1,
    lastSeen: "2026-06-21T00:00:00.000Z",
    sample: null,
  },
];

describe("UnmappedTypesAlert", () => {
  it("renders nothing when there are no unmapped types", async () => {
    const el = await UnmappedTypesAlert({ types: [] });
    expect(el).toBeNull();
  });

  it("lists each event type with its count and a debug payload", async () => {
    const el = await UnmappedTypesAlert({ types: TYPES });
    const { container } = render(el as React.ReactElement);

    // Title carries the number of distinct unmapped types.
    expect(screen.getByText("title:2")).toBeInTheDocument();
    // Named type and the null-eventType fallback both shown.
    expect(screen.getByText("TAXES")).toBeInTheDocument();
    expect(screen.getByText("unparseable")).toBeInTheDocument();
    // Counts rendered.
    expect(screen.getByText("× 3")).toBeInTheDocument();
    // Raw debug payload present (behind a <details>) so a gap is diagnosable.
    expect(container.querySelector("details")).not.toBeNull();
    expect(container.textContent).toContain("unmapped event type: TAXES");
  });
});
