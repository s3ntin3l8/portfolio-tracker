import type {
  AdminProvider,
  AdminVisionProvider,
  AdminStats,
  AdminUser,
  AdminJobsResponse,
  ImportStrategy,
  AdminStorageResponse,
} from "@portfolio/api-client";
import { getServerApi } from "./_shared.js";

export async function loadAdminProviders(): Promise<
  | { status: "ok"; providers: AdminProvider[]; encryptionEnabled: boolean }
  | { status: "unavailable" }
> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable" };
  try {
    const { providers, encryptionEnabled } = await api.getAdminProviders();
    return { status: "ok", providers, encryptionEnabled };
  } catch {
    return { status: "unavailable" };
  }
}

export async function loadAdminStats(): Promise<
  { status: "ok"; stats: AdminStats } | { status: "unavailable" }
> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable" };
  try {
    const stats = await api.getAdminStats();
    return { status: "ok", stats };
  } catch {
    return { status: "unavailable" };
  }
}

export async function loadAdminUsers(): Promise<
  { status: "ok"; users: AdminUser[] } | { status: "unavailable" }
> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable" };
  try {
    const users = await api.getAdminUsers();
    return { status: "ok", users };
  } catch {
    return { status: "unavailable" };
  }
}

export async function loadAdminStorageProviders(): Promise<
  { status: "ok"; storage: AdminStorageResponse } | { status: "unavailable" }
> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable" };
  try {
    const storage = await api.getAdminStorageProviders();
    return { status: "ok", storage };
  } catch {
    return { status: "unavailable" };
  }
}

export async function loadAdminJobs(): Promise<
  ({ status: "ok" } & AdminJobsResponse) | { status: "unavailable" }
> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable" };
  try {
    const data = await api.getAdminJobs();
    return { status: "ok", ...data };
  } catch {
    return { status: "unavailable" };
  }
}

export async function loadAdminVisionProviders(): Promise<
  | { status: "ok"; providers: AdminVisionProvider[]; encryptionEnabled: boolean }
  | { status: "unavailable" }
> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable" };
  try {
    const { providers, encryptionEnabled } = await api.getAdminVisionProviders();
    return { status: "ok", providers, encryptionEnabled };
  } catch {
    return { status: "unavailable" };
  }
}

export async function loadAdminImportSettings(): Promise<
  { status: "ok"; strategy: ImportStrategy } | { status: "unavailable" }
> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable" };
  try {
    const { strategy } = await api.getAdminImportSettings();
    return { status: "ok", strategy };
  } catch {
    return { status: "unavailable" };
  }
}
