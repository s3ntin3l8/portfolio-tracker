import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { afterAll } from "vitest";

// Give every test file an isolated, file-backed PGlite database so close/reopen
// within a file preserves data and parallel workers never contend. Tests that
// need specific values (e.g. the env defaults test) override or delete this.
const tmpDir = path.join(
  os.tmpdir(),
  `vitest-pglite-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
);

process.env.DATABASE_URL = `pglite://${tmpDir}`;

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
