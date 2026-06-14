"use client";

import { useTranslations } from "next-intl";
import { signIn } from "next-auth/react";

const ASSET_KEYS = ["stocks", "gold", "bonds", "funds", "cash"] as const;

export function Landing() {
  const t = useTranslations("Landing");

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-8 px-6">
      <div className="space-y-4">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          {t("title")}
        </h1>
        <p className="text-lg text-neutral-400">{t("tagline")}</p>
      </div>

      <ul className="flex flex-wrap gap-2">
        {ASSET_KEYS.map((key) => (
          <li
            key={key}
            className="rounded-full border border-neutral-800 bg-neutral-900 px-3 py-1 text-sm text-neutral-300"
          >
            {t(`assets.${key}`)}
          </li>
        ))}
      </ul>

      <div>
        <button
          onClick={() => signIn("authentik", { callbackUrl: "/dashboard" })}
          className="rounded-lg bg-emerald-500 px-5 py-2.5 font-medium text-neutral-950 transition hover:bg-emerald-400"
        >
          {t("cta")}
        </button>
      </div>
    </main>
  );
}
