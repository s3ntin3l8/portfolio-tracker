import type { User, UserPreferences, ApiToken } from "@portfolio/api-client";
import { getServerApi, meCached } from "./_shared.js";

export async function loadPreferences(): Promise<UserPreferences | null> {
  const api = await getServerApi();
  if (!api) return null;
  try {
    return await api.getPreferences();
  } catch {
    return null;
  }
}

export async function loadMe(): Promise<User | null> {
  const api = await getServerApi();
  if (!api) return null;
  try {
    return await meCached();
  } catch {
    return null;
  }
}

export async function loadApiTokens(): Promise<ApiToken[]> {
  const api = await getServerApi();
  if (!api) return [];
  try {
    return await api.listApiTokens();
  } catch {
    return [];
  }
}
