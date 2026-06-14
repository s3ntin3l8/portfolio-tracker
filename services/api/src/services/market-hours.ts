// Market trading hours, evaluated in UTC. Used to skip pointless price refreshes
// when a market is closed.

/**
 * IDX regular session ≈ 09:00–16:00 WIB (UTC+7), Mon–Fri → 02:00–09:00 UTC.
 * (The midday break is ignored — refreshing through it is harmless.)
 */
export function isIdxOpen(now: Date): boolean {
  const day = now.getUTCDay(); // 0=Sun … 6=Sat
  if (day === 0 || day === 6) return false;
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  return minutes >= 2 * 60 && minutes < 9 * 60;
}

/**
 * Spot gold (XAU) trades ~24/5: Sunday 22:00 UTC through Friday 22:00 UTC.
 */
export function isGoldOpen(now: Date): boolean {
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  if (day === 6) return false; // Saturday
  if (day === 0 && hour < 22) return false; // Sunday before the open
  if (day === 5 && hour >= 22) return false; // Friday after the close
  return true;
}

/** Whether the given instrument market is currently trading. */
export function isMarketOpen(market: string, now: Date): boolean {
  if (market === "XAU") return isGoldOpen(now);
  if (market === "IDX") return isIdxOpen(now);
  return true; // unknown markets: refresh best-effort
}
