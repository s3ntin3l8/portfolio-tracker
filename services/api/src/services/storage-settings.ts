import { storageSettings } from "@portfolio/db";
import type { DB } from "../db/client.js";
import type { EncryptionService } from "./encryption.js";

export const STORAGE_SETTINGS_ID = 1;

export type StorageProvider = "s3" | "folder";

export interface ResolvedS3Config {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  signedUrlTtl: number;
}

export interface ResolvedFolderConfig {
  folderPath: string;
}

export interface ResolvedStorageSettings {
  activeProvider: StorageProvider;
  s3: ResolvedS3Config;
  folder: ResolvedFolderConfig;
}

/** Env fallbacks — supplied by the caller (app.config). */
export interface StorageEnvFallback {
  STORAGE_ENDPOINT: string;
  STORAGE_REGION: string;
  STORAGE_BUCKET: string;
  STORAGE_ACCESS_KEY: string;
  STORAGE_SECRET_KEY: string;
  STORAGE_FORCE_PATH_STYLE: boolean;
  STORAGE_SIGNED_URL_TTL: number;
  STORAGE_FOLDER_PATH: string;
}

/**
 * Read the storage_settings singleton and overlay DB values over env fallbacks.
 * Decrypts the secret access key when the encryption service is active.
 * A missing row means "everything from env" (first-boot default).
 */
export async function resolveStorageSettings(
  db: DB,
  env: StorageEnvFallback,
  encryption: EncryptionService,
): Promise<ResolvedStorageSettings> {
  const [row] = await db.select().from(storageSettings).limit(1);

  const activeProvider = (row?.activeProvider ?? "s3") as StorageProvider;

  // S3 — each field: DB row value ?? env fallback
  let secretAccessKey = env.STORAGE_SECRET_KEY;
  if (row?.s3SecretAccessKeyEnc) {
    try {
      secretAccessKey = encryption.decryptString(row.s3SecretAccessKeyEnc);
    } catch {
      // Decryption failure: fall back to env
    }
  }

  const s3: ResolvedS3Config = {
    endpoint: (row?.s3Endpoint ?? env.STORAGE_ENDPOINT) || undefined,
    region: row?.s3Region ?? env.STORAGE_REGION,
    bucket: row?.s3Bucket ?? env.STORAGE_BUCKET,
    accessKeyId: row?.s3AccessKeyId ?? env.STORAGE_ACCESS_KEY,
    secretAccessKey,
    forcePathStyle: row?.s3ForcePathStyle ?? env.STORAGE_FORCE_PATH_STYLE,
    signedUrlTtl: row?.s3SignedUrlTtl ?? env.STORAGE_SIGNED_URL_TTL,
  };

  const folder: ResolvedFolderConfig = {
    folderPath: row?.folderPath ?? env.STORAGE_FOLDER_PATH,
  };

  return { activeProvider, s3, folder };
}

/**
 * The storage settings row as returned to the admin UI. Secret fields are masked;
 * each field carries a `source` indicator ("db" | "env") so the UI can show
 * when the DB is overriding the env default.
 */
export interface StorageSettingsResponse {
  activeProvider: StorageProvider;
  s3: {
    endpoint: string;
    endpointSource: "db" | "env";
    region: string;
    regionSource: "db" | "env";
    bucket: string;
    bucketSource: "db" | "env";
    accessKeyId: string;
    accessKeyIdSource: "db" | "env";
    forcePathStyle: boolean;
    forcePathStyleSource: "db" | "env";
    signedUrlTtl: number;
    signedUrlTtlSource: "db" | "env";
    hasSecret: boolean;
    secretHint: string;
    secretSource: "db" | "env";
  };
  folder: {
    path: string;
    pathSource: "db" | "env";
  };
  encryptionEnabled: boolean;
}

/**
 * Build the masked admin response from the raw row + env + encryption service.
 * Secrets never leave this function as plaintext.
 */
export async function getStorageSettingsResponse(
  db: DB,
  env: StorageEnvFallback,
  encryption: EncryptionService,
): Promise<StorageSettingsResponse> {
  const [row] = await db.select().from(storageSettings).limit(1);

  const activeProvider = (row?.activeProvider ?? "s3") as StorageProvider;

  // Secret hint: ••••<last 4 chars of the decrypted key>
  let hasSecret = false;
  let secretHint = "";
  let secretSource: "db" | "env" = "env";
  if (row?.s3SecretAccessKeyEnc) {
    hasSecret = true;
    secretSource = "db";
    try {
      const plaintext = encryption.decryptString(row.s3SecretAccessKeyEnc);
      secretHint = maskKey(plaintext);
    } catch {
      secretHint = "••••????";
    }
  } else if (env.STORAGE_SECRET_KEY) {
    hasSecret = true;
    secretHint = maskKey(env.STORAGE_SECRET_KEY);
  }

  return {
    activeProvider,
    s3: {
      endpoint: row?.s3Endpoint ?? env.STORAGE_ENDPOINT ?? "",
      endpointSource: row?.s3Endpoint != null ? "db" : "env",
      region: row?.s3Region ?? env.STORAGE_REGION,
      regionSource: row?.s3Region != null ? "db" : "env",
      bucket: row?.s3Bucket ?? env.STORAGE_BUCKET,
      bucketSource: row?.s3Bucket != null ? "db" : "env",
      accessKeyId: row?.s3AccessKeyId ?? env.STORAGE_ACCESS_KEY ?? "",
      accessKeyIdSource: row?.s3AccessKeyId != null ? "db" : "env",
      forcePathStyle: row?.s3ForcePathStyle ?? env.STORAGE_FORCE_PATH_STYLE,
      forcePathStyleSource: row?.s3ForcePathStyle != null ? "db" : "env",
      signedUrlTtl: row?.s3SignedUrlTtl ?? env.STORAGE_SIGNED_URL_TTL,
      signedUrlTtlSource: row?.s3SignedUrlTtl != null ? "db" : "env",
      hasSecret,
      secretHint,
      secretSource,
    },
    folder: {
      path: row?.folderPath ?? env.STORAGE_FOLDER_PATH,
      pathSource: row?.folderPath != null ? "db" : "env",
    },
    encryptionEnabled: encryption.isEnabled,
  };
}

function maskKey(key: string): string {
  if (key.length <= 4) return "••••";
  return `••••${key.slice(-4)}`;
}

export interface StorageSettingsPatch {
  activeProvider?: StorageProvider;
  s3Endpoint?: string | null;
  s3Region?: string | null;
  s3Bucket?: string | null;
  s3AccessKeyId?: string | null;
  s3ForcePathStyle?: boolean | null;
  s3SignedUrlTtl?: number | null;
  folderPath?: string | null;
}

/** Upsert the storage_settings singleton with the given patch. */
export async function updateStorageSettings(db: DB, patch: StorageSettingsPatch): Promise<void> {
  await db
    .insert(storageSettings)
    .values({
      id: STORAGE_SETTINGS_ID,
      activeProvider: patch.activeProvider ?? "s3",
      s3Endpoint: patch.s3Endpoint ?? null,
      s3Region: patch.s3Region ?? null,
      s3Bucket: patch.s3Bucket ?? null,
      s3AccessKeyId: patch.s3AccessKeyId ?? null,
      s3ForcePathStyle: patch.s3ForcePathStyle ?? null,
      s3SignedUrlTtl: patch.s3SignedUrlTtl ?? null,
      folderPath: patch.folderPath ?? null,
    })
    .onConflictDoUpdate({
      target: storageSettings.id,
      set: {
        ...(patch.activeProvider !== undefined ? { activeProvider: patch.activeProvider } : {}),
        ...(patch.s3Endpoint !== undefined ? { s3Endpoint: patch.s3Endpoint } : {}),
        ...(patch.s3Region !== undefined ? { s3Region: patch.s3Region } : {}),
        ...(patch.s3Bucket !== undefined ? { s3Bucket: patch.s3Bucket } : {}),
        ...(patch.s3AccessKeyId !== undefined ? { s3AccessKeyId: patch.s3AccessKeyId } : {}),
        ...(patch.s3ForcePathStyle !== undefined
          ? { s3ForcePathStyle: patch.s3ForcePathStyle }
          : {}),
        ...(patch.s3SignedUrlTtl !== undefined ? { s3SignedUrlTtl: patch.s3SignedUrlTtl } : {}),
        ...(patch.folderPath !== undefined ? { folderPath: patch.folderPath } : {}),
        updatedAt: new Date(),
      },
    });
}

/** Encrypt and store a new S3 secret access key. */
export async function setStorageSecret(
  db: DB,
  encryption: EncryptionService,
  plaintext: string,
): Promise<void> {
  const encrypted = encryption.encryptString(plaintext);
  await db
    .insert(storageSettings)
    .values({ id: STORAGE_SETTINGS_ID, activeProvider: "s3", s3SecretAccessKeyEnc: encrypted })
    .onConflictDoUpdate({
      target: storageSettings.id,
      set: { s3SecretAccessKeyEnc: encrypted, updatedAt: new Date() },
    });
}

/** Clear the stored S3 secret (revert to env fallback). */
export async function clearStorageSecret(db: DB): Promise<void> {
  await db
    .insert(storageSettings)
    .values({ id: STORAGE_SETTINGS_ID, activeProvider: "s3", s3SecretAccessKeyEnc: null })
    .onConflictDoUpdate({
      target: storageSettings.id,
      set: { s3SecretAccessKeyEnc: null, updatedAt: new Date() },
    });
}
