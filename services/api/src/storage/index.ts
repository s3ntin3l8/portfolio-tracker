import type { FastifyInstance } from "fastify";
import { S3Provider } from "./s3-provider.js";
import { FolderProvider } from "./folder-provider.js";
import type { StorageProvider } from "./types.js";
import { resolveStorageSettings } from "../services/storage-settings.js";
import { getDb, getEncryption } from "../db/client.js";

export type { StorageProvider } from "./types.js";
export type { StorageStats } from "./types.js";
export { S3Provider } from "./s3-provider.js";
export { FolderProvider } from "./folder-provider.js";

/**
 * Synchronous factory — still used by the test-injection seam and the static path.
 * Builds an S3Provider from env config (no DB, no encryption). Tests that inject
 * `buildApp({ storage: fakeStorage })` never reach this function.
 *
 * @deprecated Prefer the async `getStorageProvider(app)` for runtime use so that
 *   admin UI changes take effect without a restart.
 */
export function getStorage(config: {
  STORAGE_ENDPOINT: string;
  STORAGE_REGION: string;
  STORAGE_BUCKET: string;
  STORAGE_ACCESS_KEY: string;
  STORAGE_SECRET_KEY: string;
  STORAGE_FORCE_PATH_STYLE: boolean;
  STORAGE_SIGNED_URL_TTL: number;
}): StorageProvider {
  return new S3Provider({
    endpoint: config.STORAGE_ENDPOINT || undefined,
    region: config.STORAGE_REGION,
    bucket: config.STORAGE_BUCKET,
    accessKeyId: config.STORAGE_ACCESS_KEY,
    secretAccessKey: config.STORAGE_SECRET_KEY,
    forcePathStyle: config.STORAGE_FORCE_PATH_STYLE,
    signedUrlTtl: config.STORAGE_SIGNED_URL_TTL,
  });
}

/** Module-level singleton — dropped by `invalidateStorage()` on admin config change. */
let cachedProvider: StorageProvider | null = null;

/**
 * Return the live storage provider, building it from the DB-backed settings (with env
 * fallbacks) on first call and caching it until `invalidateStorage()` is called.
 *
 * Mirrors the `getMarketData()` lazy-singleton pattern in `services/market-data.ts`.
 * The Fastify app instance is required to read `app.config` for env defaults and
 * `app.db` / `app.encryption` for the DB-backed credential layer.
 */
export async function getStorageProvider(
  app: FastifyInstance,
): Promise<StorageProvider> {
  if (cachedProvider) return cachedProvider;

  const db = getDb();
  const encryption = getEncryption();
  const settings = await resolveStorageSettings(db, app.config, encryption);

  let provider: StorageProvider;
  if (settings.activeProvider === "folder") {
    provider = new FolderProvider({
      basePath: settings.folder.folderPath,
      publicUrl: app.config.STORAGE_PUBLIC_URL,
      signingSecret: app.config.DB_ENCRYPTION_KEY,
      signedUrlTtl: settings.s3.signedUrlTtl, // reuse the TTL setting
    });
  } else {
    provider = new S3Provider({
      endpoint: settings.s3.endpoint,
      region: settings.s3.region,
      bucket: settings.s3.bucket,
      accessKeyId: settings.s3.accessKeyId,
      secretAccessKey: settings.s3.secretAccessKey,
      forcePathStyle: settings.s3.forcePathStyle,
      signedUrlTtl: settings.s3.signedUrlTtl,
    });
  }

  cachedProvider = provider;
  return provider;
}

/** Drop the cached provider so the next `getStorageProvider()` rebuilds from DB+env. */
export function invalidateStorage(): void {
  cachedProvider = null;
}
