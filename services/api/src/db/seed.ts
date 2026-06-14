import { ensureDb, getDb, closeDb } from "./client.js";
import { users } from "./schema.js";

export async function seed() {
  const db = getDb();

  const existing = await db.select({ id: users.id }).from(users);
  if (existing.length > 0) {
    console.log("Database already seeded, skipping.");
    return;
  }

  await db.insert(users).values([{ name: "Admin User", email: "admin@example.com" }]);

  console.log("Database seeded with initial data.");
}

// Allow running directly: `tsx src/db/seed.ts`.
const invokedDirectly =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  await ensureDb();
  await seed();
  await closeDb();
}
