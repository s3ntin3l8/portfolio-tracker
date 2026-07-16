import type { TrConnection, IbkrConnection } from "@portfolio/api-client";
import { getServerApi } from "./_shared.js";

export async function loadTrConnection(): Promise<TrConnection | null> {
  const api = await getServerApi();
  if (!api) return null;
  try {
    return await api.getTrConnection();
  } catch {
    return null;
  }
}

export async function loadIbkrConnection(): Promise<IbkrConnection | null> {
  const api = await getServerApi();
  if (!api) return null;
  try {
    return await api.getIbkrConnection();
  } catch {
    return null;
  }
}
