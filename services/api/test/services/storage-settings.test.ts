import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import { ensureDb, getDb, closeDb } from "../../src/db/client.js";
import { EncryptionService } from "../../src/services/encryption.js";
import {
  resolveStorageSettings,
  getStorageSettingsResponse,
  updateStorageSettings,
  setStorageSecret,
  clearStorageSecret,
} from "../../src/services/storage-settings.js";

const ENV_DEFAULTS = {
  STORAGE_ENDPOINT: "http://localhost:9000",
  STORAGE_REGION: "us-east-1",
  STORAGE_BUCKET: "screenshots",
  STORAGE_ACCESS_KEY: "minioadmin",
  STORAGE_SECRET_KEY: "minioadmin",
  STORAGE_FORCE_PATH_STYLE: true as const,
  STORAGE_SIGNED_URL_TTL: 3600,
  STORAGE_FOLDER_PATH: "./.storage",
};

const TEST_ENC_KEY = crypto.randomBytes(32).toString("base64url");
const encryptionEnabled = new EncryptionService({ key: TEST_ENC_KEY });
const encryptionDisabled = new EncryptionService({ key: "" });

beforeAll(async () => {
  await ensureDb();
});

afterAll(async () => {
  await closeDb();
});

describe("resolveStorageSettings", () => {
  it("returns env defaults when no DB row exists", async () => {
    const db = getDb();
    const settings = await resolveStorageSettings(db, ENV_DEFAULTS, encryptionDisabled);
    expect(settings.activeProvider).toBe("s3");
    expect(settings.s3.region).toBe("us-east-1");
    expect(settings.s3.bucket).toBe("screenshots");
    expect(settings.s3.secretAccessKey).toBe("minioadmin");
    expect(settings.folder.folderPath).toBe("./.storage");
  });

  it("DB values override env defaults", async () => {
    const db = getDb();
    await updateStorageSettings(db, {
      activeProvider: "s3",
      s3Bucket: "prod-bucket",
      s3Region: "eu-central-1",
    });

    const settings = await resolveStorageSettings(db, ENV_DEFAULTS, encryptionDisabled);
    expect(settings.s3.bucket).toBe("prod-bucket");
    expect(settings.s3.region).toBe("eu-central-1");
    // env fallback for unset fields
    expect(settings.s3.accessKeyId).toBe("minioadmin");
  });

  it("decrypts the stored S3 secret and returns it as plaintext", async () => {
    const db = getDb();
    await setStorageSecret(db, encryptionEnabled, "super-secret-key");
    const settings = await resolveStorageSettings(db, ENV_DEFAULTS, encryptionEnabled);
    expect(settings.s3.secretAccessKey).toBe("super-secret-key");
  });

  it("falls back to env secret when no DB secret is stored", async () => {
    const db = getDb();
    await clearStorageSecret(db);
    const settings = await resolveStorageSettings(db, ENV_DEFAULTS, encryptionEnabled);
    expect(settings.s3.secretAccessKey).toBe(ENV_DEFAULTS.STORAGE_SECRET_KEY);
  });

  it("resolves activeProvider folder", async () => {
    const db = getDb();
    await updateStorageSettings(db, {
      activeProvider: "folder",
      folderPath: "/tmp/test-storage",
    });
    const settings = await resolveStorageSettings(db, ENV_DEFAULTS, encryptionDisabled);
    expect(settings.activeProvider).toBe("folder");
    expect(settings.folder.folderPath).toBe("/tmp/test-storage");
  });
});

describe("getStorageSettingsResponse", () => {
  it("masks the DB secret (only hint, never plaintext)", async () => {
    const db = getDb();
    await setStorageSecret(db, encryptionEnabled, "mysupersecret");

    const resp = await getStorageSettingsResponse(db, ENV_DEFAULTS, encryptionEnabled);
    expect(resp.s3.hasSecret).toBe(true);
    expect(resp.s3.secretHint).toBe("••••cret");
    expect(resp.s3.secretSource).toBe("db");
    // Must NOT contain the plaintext
    expect(JSON.stringify(resp)).not.toContain("mysupersecret");
  });

  it("shows env hint when no DB secret is set", async () => {
    const db = getDb();
    await clearStorageSecret(db);
    const resp = await getStorageSettingsResponse(db, ENV_DEFAULTS, encryptionEnabled);
    expect(resp.s3.hasSecret).toBe(true);
    expect(resp.s3.secretSource).toBe("env");
    expect(resp.s3.secretHint).toBe("••••dmin"); // last 4 of "minioadmin"
  });

  it("marks fields with correct source (db vs env)", async () => {
    const db = getDb();
    await updateStorageSettings(db, {
      activeProvider: "s3",
      s3Bucket: "custom-bucket",
      s3Region: null, // explicitly clear → revert to env fallback
    });
    const resp = await getStorageSettingsResponse(db, ENV_DEFAULTS, encryptionEnabled);
    expect(resp.s3.bucketSource).toBe("db");
    expect(resp.s3.regionSource).toBe("env");
  });

  it("returns encryptionEnabled = true when the service has a key", async () => {
    const db = getDb();
    const resp = await getStorageSettingsResponse(db, ENV_DEFAULTS, encryptionEnabled);
    expect(resp.encryptionEnabled).toBe(true);
  });

  it("returns encryptionEnabled = false when no key is set", async () => {
    const db = getDb();
    const resp = await getStorageSettingsResponse(db, ENV_DEFAULTS, encryptionDisabled);
    expect(resp.encryptionEnabled).toBe(false);
  });
});
