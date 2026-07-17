import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import { documents } from "@portfolio/db";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { schema } from "@portfolio/db";

type AppLike = Pick<FastifyInstance, "storage" | "db" | "log">;

function db(app: Pick<FastifyInstance, "db">): PostgresJsDatabase<typeof schema> {
  return app.db as PostgresJsDatabase<typeof schema>;
}

export async function linkTrReceiptsToTransactions(
  app: AppLike,
  opts: {
    importId: string;
    links: { sourceEventId: string; transactionId: string }[];
  },
): Promise<void> {
  const { importId, links } = opts;
  if (links.length === 0) return;
  try {
    for (const { sourceEventId, transactionId } of links) {
      await db(app)
        .update(documents)
        .set({ transactionId })
        .where(
          and(
            eq(documents.importId, importId),
            eq(documents.sourceEventId, sourceEventId),
            eq(documents.status, "staged"),
          ),
        );
    }
    app.log.debug({ importId, linked: links.length }, "tr receipts linked to transactions");
  } catch (err) {
    app.log.warn({ err, importId }, "linkTrReceiptsToTransactions failed (non-fatal)");
  }
}
