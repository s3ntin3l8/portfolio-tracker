import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { afterAll } from "vitest";

// Give every test file an isolated SQLite database so parallel workers never
// contend on the default ./data/app.db file. Tests that need specific values
// (e.g. the env defaults test) override or delete these before building the app.
const tmpDb = path.join(
  os.tmpdir(),
  `vitest-${process.pid}-${crypto.randomBytes(4).toString("hex")}.db`,
);

process.env.DATABASE_URL = `file:${tmpDb}`;

afterAll(() => {
  fs.rmSync(tmpDb, { force: true });
});
