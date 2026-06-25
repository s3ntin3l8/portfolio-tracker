import { getTranslations } from "next-intl/server";
import { AlertTriangle } from "lucide-react";
import type { UnmappedEventType } from "@portfolio/api-client";

/**
 * Safety net: warns when a sync source (Trade Republic) emitted event types we don't yet
 * classify — they're excluded from balances until mapped, so a gap is self-announcing rather
 * than buried in an import's errors. Server component; the raw debug payload sits behind a
 * native <details> toggle (no client JS). Renders nothing when there are no unmapped types.
 */
export async function UnmappedTypesAlert({ types }: { types: UnmappedEventType[] }) {
  if (!types.length) return null;
  const t = await getTranslations("unmappedTypes");
  return (
    <div
      role="alert"
      className="rounded-lg border border-amber-400/40 bg-amber-50 p-4 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-5 shrink-0" />
        <div className="min-w-0 space-y-2">
          <p className="font-medium">{t("title", { count: types.length })}</p>
          <p className="text-sm opacity-90">{t("description")}</p>
          <ul className="space-y-1.5 text-sm">
            {types.map((x) => (
              <li key={`${x.code}:${x.eventType ?? x.message}`}>
                <span className="font-mono font-medium">{x.eventType ?? t("unparseable")}</span>{" "}
                <span className="opacity-70">× {x.count}</span>
                <details className="mt-0.5">
                  <summary className="cursor-pointer text-xs opacity-70 hover:opacity-100">
                    {t("debug")}
                  </summary>
                  <pre className="mt-1 overflow-x-auto rounded bg-black/5 p-2 text-xs dark:bg-white/5">
                    {JSON.stringify(
                      { code: x.code, message: x.message, lastSeen: x.lastSeen, sample: x.sample },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
