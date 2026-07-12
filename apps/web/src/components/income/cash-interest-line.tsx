/**
 * Cash-interest subtotal — a compact standalone line under the dividend/coupon hero
 * stats. Deliberately NOT a StatCard: it is a separate figure the user asked to see
 * without folding it into (or visually competing with) the dividend headline above.
 *
 * Pure/presentational: no `useTranslations` — the caller passes already-translated
 * labels and pre-formatted money strings, so this renders identically wherever it's
 * used and needs no i18n provider in tests.
 */
export function CashInterestLine({
  label,
  ytdLabel,
  ttmLabel,
  lifetimeLabel,
  ytd,
  ttm,
  lifetime,
}: {
  label: string;
  ytdLabel: string;
  ttmLabel: string;
  lifetimeLabel: string;
  ytd: string;
  ttm: string;
  lifetime: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-lg border border-line px-3.5 py-2.5 text-xs sm:px-4">
      <span className="font-semibold text-text-2">{label}</span>
      <span className="tabular text-text-mute">
        {ytdLabel}: <span className="font-bold text-foreground">{ytd}</span>
      </span>
      <span className="tabular text-text-mute">
        {ttmLabel}: <span className="font-bold text-foreground">{ttm}</span>
      </span>
      <span className="tabular text-text-mute">
        {lifetimeLabel}: <span className="font-bold text-foreground">{lifetime}</span>
      </span>
    </div>
  );
}
