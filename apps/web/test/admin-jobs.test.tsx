import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { AdminJobs } from "../src/components/admin-jobs";
import messages from "../messages/en.json";
import type { AdminJob } from "@portfolio/api-client";

// ── mocks ────────────────────────────────────────────────────────────────────

const mockTriggerAdminJob = vi.fn();
const mockGetAdminJobs = vi.fn();

vi.mock("../src/lib/api", () => ({
  useApiClient: () => ({
    triggerAdminJob: mockTriggerAdminJob,
    getAdminJobs: mockGetAdminJobs,
  }),
  apiBaseUrl: "",
}));

// ── helpers ──────────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<AdminJob> = {}): AdminJob {
  return {
    name: "refresh-prices",
    label: "Price refresh",
    description: "Refresh prices.",
    cron: "*/5 * * * *",
    lastRunAt: "2026-06-22T10:00:00.000Z",
    lastStatus: "completed",
    supportsForce: false,
    ...overrides,
  };
}

function renderJobs(jobs: AdminJob[]) {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AdminJobs initialJobs={jobs} schedulerAvailable={true} />
    </NextIntlClientProvider>,
  );
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("AdminJobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTriggerAdminJob.mockResolvedValue({ queued: true, name: "refresh-prices" });
    mockGetAdminJobs.mockResolvedValue({ schedulerAvailable: true, jobs: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders job rows with label, schedule and last-run", () => {
    const job = makeJob({ label: "Price refresh", cron: "*/5 * * * *", lastRunAt: null });
    renderJobs([job]);
    const table = within(screen.getByRole("table"));
    expect(table.getByText("Price refresh")).toBeInTheDocument();
    expect(table.getByText("*/5 * * * *")).toBeInTheDocument();
    expect(table.getByRole("button", { name: messages.Admin.jobRunNow })).toBeInTheDocument();
  });

  it("shows scheduler unavailable message when schedulerAvailable is false", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <AdminJobs initialJobs={[]} schedulerAvailable={false} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText(messages.Admin.schedulerUnavailable)).toBeInTheDocument();
  });

  it("shows 'Queued ✓' immediately after triggering", async () => {
    const job = makeJob({ lastRunAt: "2026-06-22T10:00:00.000Z" });
    // getAdminJobs returns the same lastRunAt (job hasn't finished yet)
    mockGetAdminJobs.mockResolvedValue({
      schedulerAvailable: true,
      jobs: [{ ...job, lastRunAt: "2026-06-22T10:00:00.000Z" }],
    });
    renderJobs([job]);

    const table = within(screen.getByRole("table"));

    // Wrap in act() so the async trigger + setPending state updates flush.
    await act(async () => {
      fireEvent.click(table.getByRole("button", { name: messages.Admin.jobRunNow }));
    });

    expect(table.getByText(messages.Admin.jobQueued)).toBeInTheDocument();
  });

  it("clears 'Queued' and shows fresh lastRunAt when poll detects a change", async () => {
    vi.useFakeTimers();
    const priorLastRunAt = "2026-06-22T10:00:00.000Z";
    const freshLastRunAt = "2026-06-22T16:00:00.000Z";
    const job = makeJob({ lastRunAt: priorLastRunAt });

    // Poll will return a different lastRunAt.
    mockGetAdminJobs.mockResolvedValue({
      schedulerAvailable: true,
      jobs: [{ ...job, lastRunAt: freshLastRunAt, lastStatus: "completed" }],
    });
    renderJobs([job]);

    const table = within(screen.getByRole("table"));

    // Trigger; act() flushes the resolved promise + onTriggered → setPending.
    await act(async () => {
      fireEvent.click(table.getByRole("button", { name: messages.Admin.jobRunNow }));
    });

    expect(table.getByText(messages.Admin.jobQueued)).toBeInTheDocument();

    // advanceTimersByTimeAsync fires the interval callback AND awaits its async body.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });

    // "Queued ✓" should be gone; poll saw the changed lastRunAt.
    expect(table.queryByText(messages.Admin.jobQueued)).toBeNull();
  });

  it("shows jobPollTimedOut after MAX_POLLS with no lastRunAt change", async () => {
    vi.useFakeTimers();
    const job = makeJob({ lastRunAt: "2026-06-22T10:00:00.000Z" });

    // Poll always returns the same lastRunAt (job never finishes in this test).
    mockGetAdminJobs.mockResolvedValue({
      schedulerAvailable: true,
      jobs: [{ ...job, lastRunAt: "2026-06-22T10:00:00.000Z" }],
    });
    renderJobs([job]);

    const table = within(screen.getByRole("table"));

    await act(async () => {
      fireEvent.click(table.getByRole("button", { name: messages.Admin.jobRunNow }));
    });

    // Advance through MAX_POLLS (10) polls.  Each advanceTimersByTimeAsync fires
    // the interval callback and awaits the async body (getAdminJobs + setPending).
    await act(async () => {
      for (let i = 0; i < 11; i++) {
        await vi.advanceTimersByTimeAsync(3500);
      }
    });

    expect(table.getByText(messages.Admin.jobPollTimedOut)).toBeInTheDocument();
  });

  it("shows error when trigger fails", async () => {
    mockTriggerAdminJob.mockRejectedValue(new Error("Network error"));
    const job = makeJob();
    renderJobs([job]);

    const table = within(screen.getByRole("table"));

    await act(async () => {
      fireEvent.click(table.getByRole("button", { name: messages.Admin.jobRunNow }));
    });

    // Error appears only in the clicked button's branch — use getAllByText across both.
    expect(screen.getAllByText(messages.Admin.jobTriggerFailed).length).toBeGreaterThanOrEqual(1);
    // Should NOT show Queued on failure.
    expect(screen.queryByText(messages.Admin.jobQueued)).toBeNull();
  });

  it("renders Force button only for supportsForce jobs", () => {
    const normalJob = makeJob({ name: "refresh-prices", supportsForce: false });
    const forceJob = makeJob({
      name: "refresh-instrument-metadata",
      label: "Instrument metadata refresh",
      supportsForce: true,
    });
    renderJobs([normalJob, forceJob]);

    const table = within(screen.getByRole("table"));
    const forceButtons = table.getAllByRole("button", { name: messages.Admin.jobForce });
    // Desktop table has one Force button — for the force-capable job.
    expect(forceButtons).toHaveLength(1);
  });

  it("calls triggerAdminJob with { force: true } when Force button is clicked", async () => {
    const job = makeJob({
      name: "refresh-instrument-metadata",
      label: "Instrument metadata refresh",
      supportsForce: true,
      lastRunAt: null,
    });
    mockTriggerAdminJob.mockResolvedValue({
      queued: true,
      name: "refresh-instrument-metadata",
      force: true,
    });
    renderJobs([job]);

    const table = within(screen.getByRole("table"));

    await act(async () => {
      fireEvent.click(table.getByRole("button", { name: messages.Admin.jobForce }));
    });

    expect(mockTriggerAdminJob).toHaveBeenCalledWith("refresh-instrument-metadata", {
      force: true,
    });
  });
});
