import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { ApiError } from "@portfolio/api-client";
import { ImportTasksProvider, useImportTasks } from "../src/components/import-tasks-provider";
import type { ImportClient, ImportTask } from "../src/components/import-flow/types";
import messages from "../messages/en.json";

// Mutable holders the mocks read from (hoisted so vi.mock factories may reference them).
const h = vi.hoisted(() => ({
  client: null as unknown as ImportClient,
  push: vi.fn(),
  refresh: vi.fn(),
  loading: vi.fn((_message?: unknown, _opts?: unknown): string | number => "toast-1"),
  success: vi.fn(),
  error: vi.fn(),
  getSession: vi.fn(async () => ({ accessToken: "fresh" })),
}));

vi.mock("sonner", () => ({
  toast: { loading: h.loading, success: h.success, error: h.error },
}));
vi.mock("next-auth/react", () => ({ getSession: h.getSession }));
vi.mock("@/lib/use-import-client", () => ({ useImportClient: () => h.client }));
vi.mock("@/i18n/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/i18n/navigation")>();
  return { ...actual, useRouter: () => ({ push: h.push, refresh: h.refresh }) };
});

function makeClient(overrides: Partial<ImportClient> = {}): ImportClient {
  return {
    importScreenshot: vi.fn(),
    importCsv: vi.fn(),
    confirmImport: vi.fn(async () => ({ confirmed: 1 })),
    materializeImport: vi.fn(async () => ({
      materializedCount: 1,
      excludedCashMovements: 0,
      enrichedCount: 0,
    })),
    checkAccounts: vi.fn(async () => ({ mismatches: [] })),
    uploadDocument: vi.fn(async () => ({ id: "doc1", duplicate: false })),
    ...overrides,
  };
}

function Runner({ task }: { task: ImportTask }) {
  const { run } = useImportTasks();
  return (
    <button type="button" onClick={() => run(task)}>
      run
    </button>
  );
}

function renderRunner(task: ImportTask) {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ImportTasksProvider>
        <Runner task={task} />
      </ImportTasksProvider>
    </NextIntlClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "run" }));
}

const materializeTask = (overrides: Partial<ImportTask> = {}): ImportTask => ({
  kind: "materialize",
  label: "shot.png",
  acknowledge: false,
  units: [{ importId: "imp1", portfolioId: "p1" }],
  ...overrides,
});

describe("ImportTasksProvider", () => {
  beforeEach(() => {
    h.push.mockClear();
    h.refresh.mockClear();
    h.loading.mockClear();
    h.success.mockClear();
    h.error.mockClear();
    h.getSession.mockClear();
  });

  it("throws when used outside the provider", () => {
    const Bare = () => {
      useImportTasks();
      return null;
    };
    // Swallow React's error logging for the expected throw.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      render(
        <NextIntlClientProvider locale="en" messages={messages}>
          <Bare />
        </NextIntlClientProvider>,
      ),
    ).toThrow(/ImportTasksProvider/);
    spy.mockRestore();
  });

  it("materialize: sums counts across units and resolves the toast to success", async () => {
    const materializeImport = vi
      .fn()
      .mockResolvedValueOnce({ materializedCount: 2, excludedCashMovements: 0, enrichedCount: 0 })
      .mockResolvedValueOnce({ materializedCount: 3, excludedCashMovements: 0, enrichedCount: 0 });
    h.client = makeClient({ materializeImport });

    renderRunner(
      materializeTask({
        units: [
          { importId: "imp-a", portfolioId: "p1" },
          { importId: "imp-b", portfolioId: "p2" },
        ],
      }),
    );

    await waitFor(() => expect(h.success).toHaveBeenCalled());
    expect(materializeImport).toHaveBeenNthCalledWith(1, "imp-a", "p1", false);
    expect(materializeImport).toHaveBeenNthCalledWith(2, "imp-b", "p2", false);
    // 2 + 3 = 5 imported.
    const [msg, opts] = h.success.mock.calls[0]! as [string, { id?: string | number }];
    expect(msg).toContain("5");
    // The success toast reuses the same id the loading toast was painted with (one lifecycle).
    const loadingId = (h.loading.mock.calls[0]![1] as { id?: string | number }).id;
    expect(opts.id).toBe(loadingId);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    // Live per-file progress ticked through the loading toast (by the same id).
    const loadingMsgs = h.loading.mock.calls.map((c) => String(c[0]));
    expect(loadingMsgs.some((m) => m.includes("1 of 2"))).toBe(true);
    expect(loadingMsgs.some((m) => m.includes("2 of 2"))).toBe(true);
  });

  it("single-file materialize shows no per-file progress in the toast", async () => {
    h.client = makeClient();
    renderRunner(materializeTask({ expectedCount: 1 }));

    await waitFor(() => expect(h.success).toHaveBeenCalled());
    const loadingMsgs = h.loading.mock.calls.map((c) => String(c[0]));
    expect(loadingMsgs.some((m) => m.includes(" of "))).toBe(false);
  });

  it("paints exactly one loading toast for a single-file import (no throwaway)", async () => {
    h.client = makeClient();
    renderRunner(materializeTask({ expectedCount: 1 }));

    await waitFor(() => expect(h.success).toHaveBeenCalled());
    // Only execute()'s initial loading toast — run() no longer mints a throwaway one.
    expect(h.loading).toHaveBeenCalledTimes(1);
  });

  it("reports 'X of Y' and splits the gap into excluded cash + skipped duplicates", async () => {
    // Expected 12, server materializes 9 with 1 cash excluded → 2 duplicates skipped.
    h.client = makeClient({
      materializeImport: vi.fn(async () => ({
        materializedCount: 9,
        excludedCashMovements: 1,
        enrichedCount: 0,
      })),
    });
    renderRunner(materializeTask({ expectedCount: 12 }));

    await waitFor(() => expect(h.success).toHaveBeenCalled());
    const [msg, opts] = h.success.mock.calls[0]! as [string, { description?: string }];
    expect(msg).toContain("9");
    expect(msg).toContain("12");
    // Description carries both the excluded-cash (1) and duplicate-skipped (2) counts.
    expect(opts.description).toContain("1");
    expect(opts.description).toContain("2");
  });

  it("surfaces excluded cash movements in the success description", async () => {
    h.client = makeClient({
      materializeImport: vi.fn(async () => ({
        materializedCount: 4,
        excludedCashMovements: 2,
        enrichedCount: 0,
      })),
    });

    renderRunner(materializeTask());

    await waitFor(() => expect(h.success).toHaveBeenCalled());
    const opts = h.success.mock.calls[0]![1] as { description?: string };
    expect(opts.description).toBeTruthy();
    expect(opts.description).toContain("2");
  });

  it("generic error → error toast with the mapped reason and a Retry action", async () => {
    const materializeImport = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("x"), { status: 503 }))
      .mockResolvedValueOnce({ materializedCount: 1, excludedCashMovements: 0, enrichedCount: 0 });
    h.client = makeClient({ materializeImport });

    renderRunner(materializeTask());

    await waitFor(() => expect(h.error).toHaveBeenCalled());
    const opts = h.error.mock.calls[0]![1] as {
      description?: string;
      id?: string | number;
      action?: { label: string; onClick: () => void };
    };
    const loadingId = (h.loading.mock.calls[0]![1] as { id?: string | number }).id;
    expect(opts.id).toBe(loadingId);
    expect(opts.description).toBe(messages.Import.errors.notConfigured);
    expect(opts.action?.label).toBe(messages.Import.toast.retry);
    expect(h.success).not.toHaveBeenCalled();

    // Retry replays the same task (no acknowledge change) and resolves to success.
    opts.action!.onClick();
    await waitFor(() => expect(h.success).toHaveBeenCalled());
    expect(materializeImport).toHaveBeenNthCalledWith(2, "imp1", "p1", false);
  });

  it("session-expiry 401 → 'session expired' description (not opaque generic)", async () => {
    h.client = makeClient({
      materializeImport: vi.fn(async () => {
        throw Object.assign(new Error("unauthorized"), { status: 401 });
      }),
    });
    renderRunner(materializeTask());

    await waitFor(() => expect(h.error).toHaveBeenCalled());
    const opts = h.error.mock.calls[0]![1] as { description?: string };
    expect(opts.description).toBe(messages.Import.errors.sessionExpired);
  });

  it("session-expiry Retry forces getSession() before replaying (fresh token)", async () => {
    const materializeImport = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("unauthorized"), { status: 401 }))
      .mockResolvedValueOnce({ materializedCount: 1, excludedCashMovements: 0, enrichedCount: 0 });
    h.client = makeClient({ materializeImport });
    renderRunner(materializeTask());

    await waitFor(() => expect(h.error).toHaveBeenCalled());
    const opts = h.error.mock.calls[0]![1] as { action?: { onClick: () => void } };

    opts.action!.onClick();
    await waitFor(() => expect(h.success).toHaveBeenCalled());
    // The refresh ran before the replay landed.
    expect(h.getSession).toHaveBeenCalledTimes(1);
    expect(materializeImport).toHaveBeenCalledTimes(2);
  });

  it("unmapped 500 → self-diagnosing description carrying the HTTP status", async () => {
    h.client = makeClient({
      materializeImport: vi.fn(async () => {
        throw new ApiError(500, JSON.stringify({ error: "server_error" }));
      }),
    });
    renderRunner(materializeTask());

    await waitFor(() => expect(h.error).toHaveBeenCalled());
    const opts = h.error.mock.calls[0]![1] as { description?: string };
    expect(opts.description).toContain("HTTP 500");
    expect(opts.description).toContain("server_error");
  });

  it("partial failure → Retry resumes only the un-written units and totals correctly", async () => {
    let impBCalls = 0;
    const materializeImport = vi.fn(async (importId: string) => {
      if (importId === "imp-a")
        return { materializedCount: 2, excludedCashMovements: 0, enrichedCount: 0 };
      impBCalls++;
      if (impBCalls === 1) throw Object.assign(new Error("x"), { status: 401 });
      return { materializedCount: 3, excludedCashMovements: 0, enrichedCount: 0 };
    });
    h.client = makeClient({ materializeImport });

    renderRunner(
      materializeTask({
        expectedCount: 5,
        units: [
          { importId: "imp-a", portfolioId: "p1" },
          { importId: "imp-b", portfolioId: "p2" },
        ],
      }),
    );

    // First pass: imp-a lands, imp-b 401 → error toast with Retry.
    await waitFor(() => expect(h.error).toHaveBeenCalled());
    const opts = h.error.mock.calls[0]![1] as { action?: { onClick: () => void } };

    // Retry resumes from imp-b only — imp-a is not re-materialized.
    opts.action!.onClick();
    await waitFor(() => expect(h.success).toHaveBeenCalled());
    expect(materializeImport.mock.calls.filter((c) => c[0] === "imp-a")).toHaveLength(1);
    expect(materializeImport.mock.calls.filter((c) => c[0] === "imp-b")).toHaveLength(2);
    // Total carried across the retry: imp-a (2) + imp-b (3) = 5, matching expectedCount.
    const msg = h.success.mock.calls[0]![0] as string;
    expect(msg).toContain("5");
  });

  it("account-mismatch 409 → error toast whose action replays with acknowledge=true", async () => {
    const materializeImport = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError(
          409,
          JSON.stringify({
            error: "account_mismatch",
            kind: "other_portfolio",
            matchedPortfolioId: "p2",
            matchedName: "Other",
            detected: "506740786",
          }),
        ),
      )
      .mockResolvedValueOnce({ materializedCount: 1, excludedCashMovements: 0, enrichedCount: 0 });
    h.client = makeClient({ materializeImport });

    renderRunner(materializeTask());

    // First attempt → error toast carrying an "Import anyway" action.
    await waitFor(() => expect(h.error).toHaveBeenCalled());
    const opts = h.error.mock.calls[0]![1] as {
      action?: { label: string; onClick: () => void };
      duration?: number;
    };
    expect(opts.action?.label).toBe(messages.Import.accountMismatch.importAnyway);
    expect(opts.duration).toBe(Infinity);

    // Invoking the action replays the same task acknowledged.
    opts.action!.onClick();
    await waitFor(() => expect(h.success).toHaveBeenCalled());
    expect(materializeImport).toHaveBeenNthCalledWith(1, "imp1", "p1", false);
    expect(materializeImport).toHaveBeenNthCalledWith(2, "imp1", "p1", true);
  });

  it("confirm (gold contract) path → count comes from `confirmed`", async () => {
    const confirmImport = vi.fn(async () => ({ confirmed: 4 }));
    h.client = makeClient({ confirmImport });

    renderRunner({
      kind: "confirm",
      label: "contract.pdf",
      acknowledge: false,
      importId: "imp-c",
      drafts: [],
      contracts: [],
      portfolioId: "p1",
    });

    await waitFor(() => expect(h.success).toHaveBeenCalled());
    expect(confirmImport).toHaveBeenCalledWith("imp-c", [], [], "p1", false);
    expect(h.refresh).toHaveBeenCalledTimes(1);
  });
});
