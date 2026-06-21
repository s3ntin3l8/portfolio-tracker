import type { Readable } from "stream";

/**
 * Storage provider interface. All backends (MinIO, AWS S3, Supabase Storage via the
 * S3-compatible endpoint, local folder) implement this contract so callers never import
 * a concrete SDK.
 *
 * Keys are relative paths within the configured bucket (e.g. `"receipts/2024/scan.pdf"`).
 */
export interface StorageProvider {
  /**
   * Upload `body` under `key`. Overwrites an existing object silently.
   * `meta.mimeType` is stored as the object's Content-Type.
   */
  put(
    key: string,
    body: Buffer | Readable,
    meta: { mimeType: string; originalFilename?: string },
  ): Promise<void>;

  /**
   * Return a pre-signed GET URL valid for `expiresInSeconds` seconds.
   * Defaults to the configured `STORAGE_SIGNED_URL_TTL` (3600 s).
   */
  getSignedUrl(key: string, expiresInSeconds?: number): Promise<string>;

  /** Permanently delete the object. No-ops silently if the key does not exist. */
  delete(key: string): Promise<void>;

  /** Return `true` if an object exists at `key`, `false` otherwise. */
  exists(key: string): Promise<boolean>;

  /**
   * Usage statistics for the admin UI.
   * Optional — providers that don't support it (e.g. test fakes) may omit this method.
   * `freeBytes` / `diskTotalBytes` are only meaningful for the folder provider (disk stat);
   * S3 backends have no bounded capacity and omit them.
   */
  stats?(): Promise<StorageStats>;
}

export interface StorageStats {
  /** Number of objects stored (excludes metadata sidecars for the folder provider). */
  objectCount: number;
  /** Total bytes used across all objects. */
  totalBytes: number;
  /** Free bytes on the underlying filesystem (folder provider only). */
  freeBytes?: number;
  /** Total capacity of the filesystem (folder provider only). */
  diskTotalBytes?: number;
}
