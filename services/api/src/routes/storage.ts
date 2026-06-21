import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { FolderProvider } from "../storage/folder-provider.js";
import { getStorageProvider } from "../storage/index.js";

/**
 * Public file-serving route for the folder storage provider.
 *
 * `GET /storage/*` — authenticated by a short-lived HMAC-signed token
 * (`?exp=<unix>&sig=<base64url>`) issued by `FolderProvider.getSignedUrl()`.
 *
 * This route is registered WITHOUT the `authenticate` preHandler so it works for any
 * client that has the signed URL (browser, mobile, etc.) — exactly like an S3 presigned
 * URL. Token validity is checked by the provider itself (constant-time HMAC compare +
 * expiry check), so auth is equivalent to S3's SigV4-signed URLs.
 *
 * Only meaningful when the folder provider is active. When the active provider is S3,
 * signed URLs point directly at the bucket and this route is never invoked.
 *
 * Implementation note: to support both the test-injection seam (`buildApp({ storage })`)
 * and the production facade, we first check if `app.storage` itself is a FolderProvider
 * (injection case), then fall back to resolving the underlying cached provider.
 */
export const storageRoute = fp(async (app: FastifyInstance) => {
  app.get<{
    Params: { "*": string };
    Querystring: { exp?: string; sig?: string };
  }>(
    "/storage/*",
    {
      // Explicit per-route rate limit: public unauthenticated route deserves a tighter
      // ceiling than the global default. The global @fastify/rate-limit (fp-hoisted from
      // securityPlugin) is also in effect as a backstop.
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: {
        // No auth preHandler — token is in the query string
        params: {
          type: "object",
          properties: { "*": { type: "string" } },
        },
        querystring: {
          type: "object",
          properties: {
            exp: { type: "string" },
            sig: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const key = request.params["*"];
      const { exp: expStr, sig } = request.query;

      // Resolve the folder provider, supporting both:
      // (a) direct injection in tests: app.storage IS the FolderProvider
      // (b) production: app.storage is the facade → resolve the underlying provider
      let folderProvider: FolderProvider | null = null;
      if (app.storage instanceof FolderProvider) {
        folderProvider = app.storage;
      } else {
        const underlying = await getStorageProvider(app);
        if (underlying instanceof FolderProvider) {
          folderProvider = underlying;
        }
      }

      if (!folderProvider) {
        // S3 is active — signed URLs go directly to the bucket; this route is not used
        return reply.code(404).send({ error: "not_found" });
      }

      if (!expStr || !sig) {
        return reply.code(403).send({ error: "missing_token" });
      }

      const exp = parseInt(expStr, 10);
      if (isNaN(exp)) {
        return reply.code(403).send({ error: "invalid_token" });
      }

      if (!folderProvider.verifyToken(key, exp, sig)) {
        return reply.code(403).send({ error: "invalid_or_expired_token" });
      }

      try {
        const { data, meta } = await folderProvider.readFile(key);
        void reply.header("Content-Type", meta.mimeType);
        void reply.header("Content-Length", String(data.length));
        if (meta.originalFilename) {
          void reply.header(
            "Content-Disposition",
            `attachment; filename="${meta.originalFilename}"`,
          );
        }
        // Browsers may cache signed files for a short time but should revalidate.
        void reply.header("Cache-Control", "private, max-age=60");
        return reply.code(200).send(data);
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "ENOENT") {
          return reply.code(404).send({ error: "not_found" });
        }
        throw err;
      }
    },
  );
});
