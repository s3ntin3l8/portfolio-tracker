import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { S3Provider } from "../../src/storage/s3-provider.js";

const BUCKET = "test-bucket";
const REGION = "us-east-1";

function makeProvider(): S3Provider {
  return new S3Provider({
    endpoint: "http://localhost:9000",
    region: REGION,
    bucket: BUCKET,
    accessKeyId: "minioadmin",
    secretAccessKey: "minioadmin",
    forcePathStyle: true,
    signedUrlTtl: 3600,
  });
}

describe("S3Provider", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let s3Mock: any;

  beforeEach(() => {
    s3Mock = mockClient(S3Client);
  });

  afterEach(() => {
    s3Mock.reset();
  });

  describe("put", () => {
    it("sends a PutObjectCommand with the correct Bucket, Key, and ContentType", async () => {
      s3Mock.on(PutObjectCommand).resolves({});

      const provider = makeProvider();
      await provider.put("receipts/scan.pdf", Buffer.from("fake-pdf"), {
        mimeType: "application/pdf",
        originalFilename: "scan.pdf",
      });

      const calls = s3Mock.commandCalls(PutObjectCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input).toMatchObject({
        Bucket: BUCKET,
        Key: "receipts/scan.pdf",
        ContentType: "application/pdf",
      });
    });

    it("sets ContentDisposition when originalFilename is provided", async () => {
      s3Mock.on(PutObjectCommand).resolves({});

      const provider = makeProvider();
      await provider.put("file.pdf", Buffer.from("x"), {
        mimeType: "application/pdf",
        originalFilename: "original.pdf",
      });

      const calls = s3Mock.commandCalls(PutObjectCommand);
      expect(calls[0].args[0].input.ContentDisposition).toBe('attachment; filename="original.pdf"');
    });

    it("sanitises originalFilename to safe ASCII in ContentDisposition", async () => {
      s3Mock.on(PutObjectCommand).resolves({});

      const provider = makeProvider();
      await provider.put("file.pdf", Buffer.from("x"), {
        mimeType: "application/pdf",
        originalFilename:
          '2024-01-23_DKB_Umbuchungen_Kapitalmaßnahmen_zu_Depot_506740786_"test".pdf',
      });

      const calls = s3Mock.commandCalls(PutObjectCommand);
      expect(calls[0].args[0].input.ContentDisposition).toBe(
        'attachment; filename="2024-01-23_DKB_Umbuchungen_Kapitalma_nahmen_zu_Depot_506740786__test_.pdf"',
      );
    });

    it("strips path components from originalFilename in ContentDisposition", async () => {
      s3Mock.on(PutObjectCommand).resolves({});

      const provider = makeProvider();
      await provider.put("file.pdf", Buffer.from("x"), {
        mimeType: "application/pdf",
        originalFilename: "../../etc/passwd.pdf",
      });

      const calls = s3Mock.commandCalls(PutObjectCommand);
      expect(calls[0].args[0].input.ContentDisposition).toBe('attachment; filename="passwd.pdf"');
    });

    it("omits ContentDisposition when originalFilename is absent", async () => {
      s3Mock.on(PutObjectCommand).resolves({});

      const provider = makeProvider();
      await provider.put("file.txt", Buffer.from("hello"), {
        mimeType: "text/plain",
      });

      const calls = s3Mock.commandCalls(PutObjectCommand);
      expect(calls[0].args[0].input.ContentDisposition).toBeUndefined();
    });
  });

  describe("delete", () => {
    it("sends a DeleteObjectCommand with the correct Bucket and Key", async () => {
      s3Mock.on(DeleteObjectCommand).resolves({});

      const provider = makeProvider();
      await provider.delete("receipts/old.pdf");

      const calls = s3Mock.commandCalls(DeleteObjectCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input).toMatchObject({
        Bucket: BUCKET,
        Key: "receipts/old.pdf",
      });
    });
  });

  describe("exists", () => {
    it("returns true when HeadObjectCommand succeeds", async () => {
      s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 42 });

      const provider = makeProvider();
      const result = await provider.exists("receipts/file.pdf");

      expect(result).toBe(true);
    });

    it("returns false on a NotFound error (404)", async () => {
      const notFound = Object.assign(new Error("Not Found"), {
        name: "NotFound",
        $metadata: { httpStatusCode: 404 },
      });
      s3Mock.on(HeadObjectCommand).rejects(notFound);

      const provider = makeProvider();
      const result = await provider.exists("receipts/missing.pdf");

      expect(result).toBe(false);
    });

    it("returns false on a 404 httpStatusCode error", async () => {
      const err = Object.assign(new Error("Not Found"), {
        name: "UnknownError",
        $metadata: { httpStatusCode: 404 },
      });
      s3Mock.on(HeadObjectCommand).rejects(err);

      const provider = makeProvider();
      expect(await provider.exists("key")).toBe(false);
    });

    it("re-throws non-404 errors", async () => {
      const serverError = Object.assign(new Error("Service Unavailable"), {
        name: "ServiceUnavailable",
        $metadata: { httpStatusCode: 503 },
      });
      s3Mock.on(HeadObjectCommand).rejects(serverError);

      const provider = makeProvider();
      await expect(provider.exists("receipts/file.pdf")).rejects.toThrow("Service Unavailable");
    });
  });

  describe("getSignedUrl", () => {
    it("returns a string containing SigV4 query params", async () => {
      // The real presigner constructs and signs the URL locally; no S3 call is made.
      const provider = makeProvider();
      const url = await provider.getSignedUrl("receipts/scan.pdf", 300);

      expect(typeof url).toBe("string");
      // SigV4 presigned URL always contains X-Amz-Signature
      expect(url).toContain("X-Amz-Signature");
      expect(url).toContain("X-Amz-Expires=300");
    });

    it("uses the configured default TTL when no expiresInSeconds is provided", async () => {
      const provider = makeProvider(); // signedUrlTtl = 3600
      const url = await provider.getSignedUrl("key.pdf");

      expect(url).toContain("X-Amz-Expires=3600");
    });

    it("URL contains the bucket and key", async () => {
      const provider = makeProvider();
      const url = await provider.getSignedUrl("nested/path/file.pdf");

      expect(url).toContain(BUCKET);
      // With forcePathStyle the URL keeps slashes as plain path segments
      expect(url).toContain("nested/path/file.pdf");
    });

    it("sanitises downloadName to safe ASCII in ResponseContentDisposition", async () => {
      const provider = makeProvider();
      const url = await provider.getSignedUrl("nested/path/file.pdf", 300, {
        downloadName: '2024-01-23_DKB_Umbuchungen_Kapitalmaßnahmen_zu_Depot_506740786_"test".pdf',
      });

      const decodedUrl = decodeURIComponent(url);
      expect(decodedUrl).toContain(
        'response-content-disposition=attachment; filename="2024-01-23_DKB_Umbuchungen_Kapitalma_nahmen_zu_Depot_506740786__test_.pdf"',
      );
    });

    it("strips path components from downloadName in ResponseContentDisposition", async () => {
      const provider = makeProvider();
      const url = await provider.getSignedUrl("nested/path/file.pdf", 300, {
        downloadName: "../../etc/passwd.pdf",
      });

      const decodedUrl = decodeURIComponent(url);
      expect(decodedUrl).toContain(
        'response-content-disposition=attachment; filename="passwd.pdf"',
      );
    });
  });

  describe("stats", () => {
    it("returns objectCount and totalBytes from a single page", async () => {
      s3Mock.on(ListObjectsV2Command).resolves({
        Contents: [
          { Key: "a.txt", Size: 100 },
          { Key: "b.txt", Size: 200 },
        ],
        IsTruncated: false,
      });

      const provider = makeProvider();
      const stats = await provider.stats();

      expect(stats.objectCount).toBe(2);
      expect(stats.totalBytes).toBe(300);
      expect(stats.freeBytes).toBeUndefined();
    });

    it("paginates across multiple pages", async () => {
      s3Mock
        .on(ListObjectsV2Command, { ContinuationToken: undefined })
        .resolves({
          Contents: [{ Key: "a.txt", Size: 50 }],
          IsTruncated: true,
          NextContinuationToken: "page2",
        })
        .on(ListObjectsV2Command, { ContinuationToken: "page2" })
        .resolves({
          Contents: [{ Key: "b.txt", Size: 75 }],
          IsTruncated: false,
        });

      const provider = makeProvider();
      const stats = await provider.stats();

      expect(stats.objectCount).toBe(2);
      expect(stats.totalBytes).toBe(125);
    });

    it("handles an empty bucket", async () => {
      s3Mock.on(ListObjectsV2Command).resolves({
        Contents: [],
        IsTruncated: false,
      });

      const provider = makeProvider();
      const stats = await provider.stats();

      expect(stats.objectCount).toBe(0);
      expect(stats.totalBytes).toBe(0);
    });
  });

  describe("ensureBucket", () => {
    it("returns false (no-op) when the bucket already exists", async () => {
      s3Mock.on(HeadBucketCommand).resolves({});

      const provider = makeProvider();
      const created = await provider.ensureBucket();

      expect(created).toBe(false);
      expect(s3Mock.commandCalls(CreateBucketCommand)).toHaveLength(0);
    });

    it("creates the bucket and returns true when it does not exist", async () => {
      const notFound = Object.assign(new Error("NoSuchBucket"), {
        name: "NoSuchBucket",
        $metadata: { httpStatusCode: 404 },
      });
      s3Mock.on(HeadBucketCommand).rejects(notFound);
      s3Mock.on(CreateBucketCommand).resolves({});

      const provider = makeProvider();
      const created = await provider.ensureBucket();

      expect(created).toBe(true);
      const createCalls = s3Mock.commandCalls(CreateBucketCommand);
      expect(createCalls).toHaveLength(1);
      expect(createCalls[0].args[0].input).toMatchObject({ Bucket: BUCKET });
    });

    it("re-throws unexpected errors from HeadBucket", async () => {
      s3Mock.on(HeadBucketCommand).rejects(new Error("Access Denied"));

      const provider = makeProvider();
      await expect(provider.ensureBucket()).rejects.toThrow("Access Denied");
    });
  });
});
