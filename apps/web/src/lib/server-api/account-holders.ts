import type { AccountHolder } from "@portfolio/api-client";
import { getServerApi, listAccountHoldersCached } from "./_shared.js";

export async function loadAccountHolders(): Promise<AccountHolder[]> {
  const api = await getServerApi();
  if (!api) return [];
  try {
    return await listAccountHoldersCached();
  } catch {
    return [];
  }
}
