// @portfolio/api-client — typed wrappers around the Fastify API. The base URL is
// config-driven (keeps the Vercel-migration path open). Filled in during phase 1.
export interface ApiClientConfig {
  baseUrl: string;
  getToken?: () => string | undefined;
}

export const API_CLIENT_PACKAGE = "@portfolio/api-client";

