import { describe, it, expect } from "vitest";
import { EncryptionService, DecryptionError } from "../../src/services/encryption.js";
import crypto from "node:crypto";

describe("EncryptionService", () => {
  const key = crypto.randomBytes(32).toString("base64url");

  describe("when encryption is enabled", () => {
    const svc = new EncryptionService({ key });

    it("encrypts and decrypts a string round-trip", () => {
      const token = svc.encryptString("hunter2");
      expect(token).not.toBe("hunter2");
      expect(svc.decryptString(token)).toBe("hunter2");
    });

    it("encrypts and decrypts JSON round-trip", () => {
      const data = { a: 1, b: ["x", "y"] };
      expect(svc.decryptJson(svc.encryptJson(data))).toEqual(data);
    });

    it("isEnabled returns true", () => {
      expect(svc.isEnabled).toBe(true);
    });

    it("throws DecryptionError for malformed ciphertext with valid prefix", () => {
      expect(() => svc.decryptString("enc:AAAA:BBBB:CCCC")).toThrow(DecryptionError);
    });

    it("returns legacy plaintext unchanged if it lacks the prefix", () => {
      expect(svc.decryptString("legacy-plaintext")).toBe("legacy-plaintext");
    });
  });

  describe("when encryption is disabled (empty key)", () => {
    const svc = new EncryptionService({ key: "" });

    it("isEnabled returns false", () => {
      expect(svc.isEnabled).toBe(false);
    });

    it("passes strings through unchanged", () => {
      expect(svc.encryptString("plain")).toBe("plain");
      expect(svc.decryptString("plain")).toBe("plain");
    });
  });
});
