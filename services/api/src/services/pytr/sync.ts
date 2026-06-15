import { eq } from "drizzle-orm";
import { screenshotImports, trConnections } from "@portfolio/db";
import { mapTrEvents } from "./mapper.js";
import { PytrAuthError } from "./runner.js";
import type { PytrRunner } from "./runner.js";
import type { DB } from "../../db/client.js";
import type { EncryptionService } from "../encryption.js";

type TrConnectionRow = typeof trConnections.$inferSelect;

export interface SyncResult {
  status: "connected" | "expired" | "error";
  importId?: string;
  drafts?: number;
  errors?: number;
}

/**
 * Sync one Trade Republic connection: resume the saved session, export the timeline,
 * map events to draft transactions, and stage them as a screenshot_imports row
 * (parser='pytr') the user confirms later — imports never auto-commit. The rolling
 * cookie session is re-saved to extend its life; a session that can't be resumed flips
 * the connection to `expired` (cron can't re-2FA — the UI prompts a reconnect).
 *
 * Pure of HTTP/pg-boss: callable from both the manual endpoint and the cron worker, and
 * unit-testable with a mock runner (no Python, no network).
 */
export async function syncTrConnection(
  db: DB,
  encryption: EncryptionService,
  runner: PytrRunner,
  connection: TrConnectionRow,
): Promise<SyncResult> {
  if (!connection.sessionEnc) return { status: "error" };

  const phone = encryption.decryptString(connection.phoneEnc);
  const pin = encryption.decryptString(connection.pinEnc);
  const sessionData = encryption.decryptString(connection.sessionEnc);

  let result: Awaited<ReturnType<PytrRunner["export"]>>;
  try {
    result = await runner.export({ phone, pin, sessionData });
  } catch (err) {
    const status = err instanceof PytrAuthError ? "expired" : "error";
    await db
      .update(trConnections)
      .set({
        status,
        lastError: err instanceof Error ? err.message : "sync failed",
        updatedAt: new Date(),
      })
      .where(eq(trConnections.id, connection.id));
    return { status };
  }

  const { drafts, errors } = mapTrEvents(result.events);

  const [imp] = await db
    .insert(screenshotImports)
    .values({
      userId: connection.userId,
      portfolioId: connection.portfolioId,
      parser: "pytr",
      parsedJson: { drafts, errors },
      status: "draft",
    })
    .returning();

  await db
    .update(trConnections)
    .set({
      sessionEnc: encryption.encryptString(result.sessionData),
      status: "connected",
      lastSyncAt: new Date(),
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(trConnections.id, connection.id));

  return {
    status: "connected",
    importId: imp.id,
    drafts: drafts.length,
    errors: errors.length,
  };
}
