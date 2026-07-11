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
    // Authentik group whose members are admins (may configure data providers from the
    // UI). Empty ⇒ no admins. The group must be emitted in the token's `groups` claim.
    AUTHENTIK_ADMIN_GROUP: {
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
    TRUSTED_PROXY_CIDRS: {
      type: "string",
      default: "",
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
    // --- Interactive Brokers (Flex Web Service) ---
    // Master switch for the IBKR Flex sync feature.
    IBKR_FLEX_ENABLED: {
      type: "boolean",
      default: true,
    },
    // Base URL for the Flex Web Service (override for testing/staging).
    IBKR_FLEX_BASE_URL: {
      type: "string",
      default: "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService",
    },
    // pg-boss cron for the daily IBKR Flex sync (EOD data — daily, not hourly).
    IBKR_SYNC_CRON: {
      type: "string",
      default: "0 2 * * *", // daily 02:00 UTC (~09:00 WIB)
    },
    // --- Object storage (S3-compatible: MinIO, AWS, Supabase /storage/v1/s3, R2) ---
    // Endpoint URL for S3-compatible backends. Leave blank to use AWS's default endpoint.
    // MinIO (local): http://localhost:9000
    // Supabase Storage: https://<project>.supabase.co/storage/v1/s3
    STORAGE_ENDPOINT: {
      type: "string",
      default: "",
    },
    STORAGE_REGION: {
      type: "string",
      default: "us-east-1",
    },
    STORAGE_BUCKET: {
      type: "string",
      default: "screenshots",
    },
    STORAGE_ACCESS_KEY: {
      type: "string",
      default: "",
    },
    STORAGE_SECRET_KEY: {
      type: "string",
      default: "",
    },
    // true for MinIO and Supabase (path-style URL), false for AWS (virtual-hosted-style).
    STORAGE_FORCE_PATH_STYLE: {
      type: "boolean",
      default: true,
    },
    // Default presigned-URL TTL in seconds (used by app.storage.getSignedUrl).
    STORAGE_SIGNED_URL_TTL: {
      type: "number",
      default: 3600,
    },
    // Base directory for the folder (local-disk) storage provider.
    // Resolved relative to the API working directory; use an absolute path for production.
    STORAGE_FOLDER_PATH: {
      type: "string",
      default: "./.storage",
    },
    // External origin used to build folder-provider signed URLs (e.g. https://api.example.com).
    // Empty ⇒ root-relative path (/storage/…) — correct for same-origin reverse-proxy topology.
    STORAGE_PUBLIC_URL: {
      type: "string",
      default: "",
    },
    // Directory for rolling log files. Empty (default) = disabled; logs go to stdout only.
    // Set to an absolute path (e.g. /var/log/api) or a relative one (e.g. ./logs) in .env
    // to also persist logs to a rotating file (daily rotation, 20 MB size cap, 14-day retention).
    // The directory is created automatically. Docker/production environments that capture
    // stdout via journald/CloudWatch should leave this unset.
    LOG_DIR: {
      type: "string",
      default: "",
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
      AUTHENTIK_ADMIN_GROUP: string;
      CORS_ORIGIN: string;
      RATE_LIMIT_MAX: number;
      RATE_LIMIT_WINDOW: string;
      TRUSTED_PROXY_CIDRS: string;
      MARKET_DATA_TTL_MS: number;
      PYTR_PYTHON_BIN: string;
      PYTR_WAF_STRATEGY: "awswaf" | "playwright";
      PYTR_ENABLED: boolean;
      IBKR_FLEX_ENABLED: boolean;
      IBKR_FLEX_BASE_URL: string;
      IBKR_SYNC_CRON: string;
      STORAGE_ENDPOINT: string;
      STORAGE_REGION: string;
      STORAGE_BUCKET: string;
      STORAGE_ACCESS_KEY: string;
      STORAGE_SECRET_KEY: string;
      STORAGE_FORCE_PATH_STYLE: boolean;
      STORAGE_SIGNED_URL_TTL: number;
      STORAGE_FOLDER_PATH: string;
      STORAGE_PUBLIC_URL: string;
      LOG_DIR: string;
    };
  }
}
