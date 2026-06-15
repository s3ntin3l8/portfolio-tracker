import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Mirror the tsconfig `@/*` → src/* path so component imports resolve in tests.
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // The `server-only` guard throws outside RSC; stub it so server-side lib code
      // (e.g. lib/server-api.ts) can be unit-tested under jsdom.
      "server-only": fileURLToPath(new URL("./test/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
  },
});
