import fp from "fastify-plugin";
import env from "@fastify/env";

const schema = {
  type: "object",
  required: [],
  properties: {
    NODE_ENV: {
      type: "string",
      default: "development",
      enum: ["development", "production", "test"],
    },
    PORT: {
      type: "number",
      default: 3000,
    },
    LOG_LEVEL: {
      type: "string",
      default: "info",
      enum: ["fatal", "error", "warn", "info", "debug", "trace"],
    },
    DATABASE_URL: {
      type: "string",
      default: "postgres://postgres:postgres@localhost:5432/portfolio",
    },
    DB_ENCRYPTION_KEY: {
      type: "string",
      default: "",
    },
    AUTHENTIK_ISSUER: {
      type: "string",
      default: "",
    },
    AUTHENTIK_AUDIENCE: {
      type: "string",
      default: "",
    },
    AUTHENTIK_JWKS_URL: {
      type: "string",
      default: "",
    },
    CORS_ORIGIN: {
      type: "string",
      default: "",
    },
    RATE_LIMIT_MAX: {
      type: "number",
      default: 100,
    },
    RATE_LIMIT_WINDOW: {
      type: "string",
      default: "1 minute",
    },
    // How long a cached last-price stays fresh before a live re-fetch (ms).
    MARKET_DATA_TTL_MS: {
      type: "number",
      default: 900000, // 15 minutes
    },
    // --- Trade Republic (pytr) ---
    // Interpreter that runs the vendored pytr entrypoints; the venv's python in prod.
    PYTR_PYTHON_BIN: {
      type: "string",
      default: "python3",
    },
    // How pytr mints the AWS-WAF token at pairing time. The no-browser solver by
    // default; 'playwright' needs a bundled Chromium (not installed by default).
    PYTR_WAF_STRATEGY: {
      type: "string",
      default: "awswaf",
      enum: ["awswaf", "playwright"],
    },
    // Master switch for the Trade Republic feature (subprocess + routes).
    PYTR_ENABLED: {
      type: "boolean",
      default: true,
    },
  },
};

export const envPlugin = fp(async (app) => {
  await app.register(env, {
    schema: schema,
    // Don't read the developer's .env during tests — keep them hermetic.
    dotenv: process.env.NODE_ENV !== "test",
  });
});

declare module "fastify" {
  interface FastifyInstance {
    config: {
      NODE_ENV: "development" | "production" | "test";
      PORT: number;
      LOG_LEVEL: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
      DATABASE_URL: string;
      DB_ENCRYPTION_KEY: string;
      AUTHENTIK_ISSUER: string;
      AUTHENTIK_AUDIENCE: string;
      AUTHENTIK_JWKS_URL: string;
      CORS_ORIGIN: string;
      RATE_LIMIT_MAX: number;
      RATE_LIMIT_WINDOW: string;
      MARKET_DATA_TTL_MS: number;
      PYTR_PYTHON_BIN: string;
      PYTR_WAF_STRATEGY: "awswaf" | "playwright";
      PYTR_ENABLED: boolean;
    };
  }
}