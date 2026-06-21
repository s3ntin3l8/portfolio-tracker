import type { Readable } from "stream";
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  NoSuchBucket,
} from "@aws-sdk/client-s3";
import { getSignedUrl as s3GetSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { StorageProvider, StorageStats } from "./types.js";

export interface S3ProviderConfig {
  /** S3-compatible endpoint URL. Omit for AWS (uses SDK default). */
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * Use path-style URLs (`<endpoint>/<bucket>/key`) instead of virtual-hosted-style.
   * Required for MinIO and Supabase Storage's S3 endpoint; set false for AWS.
   */
  forcePathStyle: boolean;
  /** Default presigned-URL TTL in seconds. */
  signedUrlTtl: number;
}

export class S3Provider implements StorageProvider {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly signedUrlTtl: number;

  constructor(config: S3ProviderConfig) {
    this.bucket = config.bucket;
    this.signedUrlTtl = config.signedUrlTtl;
    this.client = new S3Client({
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: config.forcePathStyle,
    });
  }

  async put(
    key: string,
    body: Buffer | Readable,
    meta: { mimeType: string; originalFilename?: string },
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: meta.mimeType,
        ...(meta.originalFilename
          ? {
              ContentDisposition: `attachment; filename="${meta.originalFilename}"`,
            }
          : {}),
      }),
    );
  }

  async getSignedUrl(key: string, expiresInSeconds?: number): Promise<string> {
    return s3GetSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: expiresInSeconds ?? this.signedUrlTtl },
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch (err: unknown) {
      // S3 / MinIO throw a 404-shaped error under several names depending on SDK version
      // and backend. Match on the error name and the HTTP status.
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  /**
   * Usage statistics: paginated scan of the bucket, summing object count + total bytes.
   * S3 has no capacity concept, so `freeBytes`/`diskTotalBytes` are not returned.
   * Performs O(objects / 1000) ListObjectsV2 requests — suitable for admin-only calls.
   */
  async stats(): Promise<StorageStats> {
    let objectCount = 0;
    let totalBytes = 0;
    let continuationToken: string | undefined;
    do {
      const resp = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          ContinuationToken: continuationToken,
        }),
      );
      for (const obj of resp.Contents ?? []) {
        objectCount++;
        totalBytes += obj.Size ?? 0;
      }
      continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (continuationToken);
    return { objectCount, totalBytes };
  }

  /**
   * Attempt to create the configured bucket if it does not exist.
   * Called once at startup so local MinIO works without manual bucket setup.
   * Errors are non-fatal: production backends (Supabase) may reject CreateBucket
   * even when the bucket exists, and that should not abort boot.
   */
  async ensureBucket(): Promise<boolean> {
    try {
      await this.client.send(
        new HeadBucketCommand({ Bucket: this.bucket }),
      );
      return false; // already exists
    } catch (err: unknown) {
      if (isNotFound(err) || isNoSuchBucket(err)) {
        await this.client.send(
          new CreateBucketCommand({ Bucket: this.bucket }),
        );
        return true; // created
      }
      throw err;
    }
  }
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as Record<string, unknown>;
  // AWS SDK v3: NotFound, HeadObject NotFound, 404 response
  if (e["name"] === "NotFound" || e["name"] === "NoSuchKey") return true;
  if (typeof e["$metadata"] === "object" && e["$metadata"] !== null) {
    const meta = e["$metadata"] as Record<string, unknown>;
    if (meta["httpStatusCode"] === 404) return true;
  }
  return false;
}

function isNoSuchBucket(err: unknown): boolean {
  if (err instanceof NoSuchBucket) return true;
  if (typeof err === "object" && err !== null) {
    const e = err as Record<string, unknown>;
    if (e["name"] === "NoSuchBucket") return true;
  }
  return false;
}
