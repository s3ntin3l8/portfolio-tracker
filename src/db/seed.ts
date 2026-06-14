import { getDb } from "./client.js";
import { users } from "./schema.js";

export async function seed() {
  const db = getDb();

  const existing = db.select({ id: users.id }).from(users).all();
  if (existing.length > 0) {
    console.log("Database already seeded, skipping.");
    return;
  }

  db.insert(users)
    .values([{ name: "Admin User", email: "admin@example.com" }])
    .run();

  console.log("Database seeded with initial data.");
}