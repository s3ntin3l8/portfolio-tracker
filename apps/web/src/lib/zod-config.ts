// Set before any Zod schema module is loaded, so Zod's globalConfig picks up
// `jitless: true` before the allowsEval probe (new Function("")) runs at
// schema-creation time. This prevents the Content-Security-Policy unsafe-eval
// violation logged by the report-only CSP in next.config.mjs.
const g = globalThis as unknown as { __zod_globalConfig: { jitless: boolean } };
if (!g.__zod_globalConfig) g.__zod_globalConfig = { jitless: true };
else g.__zod_globalConfig.jitless = true;

export {};
