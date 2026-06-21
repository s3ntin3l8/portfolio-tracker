import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";
import type { Readable } from "stream";
import type { StorageProvider, StorageStats } from "./types.js";

export interface FolderProviderConfig {
  /** Absolute (or cwd-relative) base directory for stored files. */
  basePath: string;
  /**
   * External origin prepended to signed URLs (e.g. `https://api.example.com`).
   * Empty string ⇒ root-relative path (`/storage/…`).
   */
  publicUrl: string;
  /**
   * 32-byte-capable secret used to compute the HMAC-SHA256 token on getSignedUrl.
   * Should be the same value as `DB_ENCRYPTION_KEY`. Required for getSignedUrl to work;
   * methods other than getSignedUrl work even when empty.
   */
  signingSecret: string;
  /** Default signed-URL TTL in seconds. */
  signedUrlTtl: number;
}

interface FileMeta {
  mimeType: string;
  originalFilename?: string;
}

export class FolderProvider implements StorageProvider {
  private readonly basePath: string;
  private readonly publicUrl: string;
  private readonly signingSecret: string;
  private readonly signedUrlTtl: number;

  constructor(config: FolderProviderConfig) {
    this.basePath = path.resolve(config.basePath);
    this.publicUrl = config.publicUrl.replace(/\/$/, "");
    this.signingSecret = config.signingSecret;
    this.signedUrlTtl = config.signedUrlTtl;
  }

  /**
   * Resolve a storage key to a filesystem path, rejecting any attempt to escape
   * the base directory (path traversal). Throws if the key is absolute or would
   * resolve outside `basePath`.
   */
  private resolveSafe(key: string): string {
    // Disallow absolute keys
    if (path.isAbsolute(key)) {
      throw new Error(`Storage key must be relative, got: ${key}`);
    }
    const resolved = path.resolve(this.basePath, key);
    // Use path.relative so the containment check is structurally unambiguous: if the
    // relative path from basePath to the resolved value starts with ".." (or is itself
    // absolute), the key has escaped the base directory.
    const rel = path.relative(this.basePath, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Storage key escapes base directory: ${key}`);
    }
    return resolved;
  }

  private metaPath(filePath: string): string {
    return `${filePath}.meta.json`;
  }

  async put(
    key: string,
    body: Buffer | Readable,
    meta: { mimeType: string; originalFilename?: string },
  ): Promise<void> {
    const filePath = this.resolveSafe(key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    if (Buffer.isBuffer(body)) {
      await fs.writeFile(filePath, body);
    } else {
      // Readable stream — collect into buffer
      const chunks: Buffer[] = [];
      for await (const chunk of body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      }
      await fs.writeFile(filePath, Buffer.concat(chunks));
    }

    const fileMeta: FileMeta = { mimeType: meta.mimeType };
    if (meta.originalFilename) fileMeta.originalFilename = meta.originalFilename;
    await fs.writeFile(
      this.metaPath(filePath),
      JSON.stringify(fileMeta),
      "utf8",
    );
  }

  async getSignedUrl(key: string, expiresInSeconds?: number): Promise<string> {
    if (!this.signingSecret) {
      throw new Error(
        "FolderProvider: getSignedUrl requires a signing secret (set DB_ENCRYPTION_KEY or configure via admin UI)",
      );
    }
    const ttl = expiresInSeconds ?? this.signedUrlTtl;
    const exp = Math.floor(Date.now() / 1000) + ttl;
    const sig = sign(this.signingSecret, key, exp);
    const encodedKey = key.split("/").map(encodeURIComponent).join("/");
    return `${this.publicUrl}/storage/${encodedKey}?exp=${exp}&sig=${sig}`;
  }

  async delete(key: string): Promise<void> {
    const filePath = this.resolveSafe(key);
    await Promise.all([
      fs.unlink(filePath).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
      }),
      fs.unlink(this.metaPath(filePath)).catch(() => {
        // Sidecar may not exist; ignore
      }),
    ]);
  }

  async exists(key: string): Promise<boolean> {
    const filePath = this.resolveSafe(key);
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async stats(): Promise<StorageStats> {
    let objectCount = 0;
    let totalBytes = 0;

    async function walk(dir: string): Promise<void> {
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return; // Directory may not exist yet
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile() && !entry.name.endsWith(".meta.json")) {
          objectCount++;
          try {
            const stat = await fs.stat(full);
            totalBytes += stat.size;
          } catch {
            // ignore stat errors on individual files
          }
        }
      }
    }

    await walk(this.basePath);

    // Disk free space via statfs (available in Node ≥ 19)
    let freeBytes: number | undefined;
    let diskTotalBytes: number | undefined;
    try {
      const sf = await fs.statfs(this.basePath);
      freeBytes = sf.bavail * sf.bsize;
      diskTotalBytes = sf.blocks * sf.bsize;
    } catch {
      // statfs unavailable or base dir doesn't exist yet
    }

    return { objectCount, totalBytes, freeBytes, diskTotalBytes };
  }

  /**
   * Verify a signed token from `getSignedUrl`. Used by the serving route to authenticate
   * file requests without a session.
   *
   * @returns `true` if the signature is valid and the token has not expired.
   */
  verifyToken(key: string, exp: number, sig: string): boolean {
    if (!this.signingSecret) return false;
    const now = Math.floor(Date.now() / 1000);
    if (exp <= now) return false;
    const expected = sign(this.signingSecret, key, exp);
    try {
      return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  /**
   * Read the file at `key` and its sidecar metadata.
   * Throws with code `ENOENT` if the file does not exist.
   */
  async readFile(key: string): Promise<{ data: Buffer; meta: FileMeta }> {
    const filePath = this.resolveSafe(key);
    const [data, metaRaw] = await Promise.all([
      fs.readFile(filePath),
      fs.readFile(this.metaPath(filePath), "utf8").catch(() => "{}"),
    ]);
    let meta: FileMeta = { mimeType: "application/octet-stream" };
    try {
      const parsed = JSON.parse(metaRaw) as Partial<FileMeta>;
      if (parsed.mimeType) meta = parsed as FileMeta;
    } catch {
      // ignore malformed sidecar
    }
    return { data, meta };
  }
}

/** Compute HMAC-SHA256(secret, `${key}:${exp}`) as base64url. */
function sign(secret: string, key: string, exp: number): string {
  return createHmac("sha256", secret)
    .update(`${key}:${exp}`)
    .digest("base64url");
}
