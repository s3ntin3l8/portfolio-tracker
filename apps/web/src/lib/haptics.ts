/**
 * Thin wrapper over `navigator.vibrate` for tactile feedback on Android (iOS Safari has no
 * Vibration API, so this is a no-op there and anywhere else it's unsupported). Kept to a
 * couple of natural moments — entering multi-select, confirming a destructive bulk action —
 * not wired into general button taps.
 */
function vibrate(pattern: number | number[]): void {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  try {
    navigator.vibrate(pattern);
  } catch {
    // Some browsers throw if called outside a user gesture, or a permissions policy denies
    // it — vibration is a nicety, never worth failing the caller's real action over.
  }
}

export const haptics = {
  /** Long-press entered multi-select mode. */
  selectionStart: () => vibrate(15),
  /** A destructive action (e.g. bulk delete) was just confirmed. */
  destructiveConfirm: () => vibrate([20, 40, 20]),
};
