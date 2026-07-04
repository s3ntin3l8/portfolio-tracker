"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { signIn } from "next-auth/react";
import { Wallet, Shield, Lock, ArrowRight, Eye, EyeOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Pocket "1A — Split Hero" sign-in (the chosen login concept). Brand panel + auth panel;
// stacks to a compact brand band above the form on mobile. Authentik OIDC is the only real
// auth, so both the SSO button and the email form route through it.
export function Landing() {
  const t = useTranslations("Landing");
  const [busy, setBusy] = useState(false);
  const [showPw, setShowPw] = useState(false);

  const start = () => {
    setBusy(true);
    void signIn("authentik", { callbackUrl: "/holdings" });
  };

  return (
    <main className="flex min-h-dvh flex-col md:flex-row">
      {/* Brand / hero panel */}
      <section className="relative flex flex-col justify-between overflow-hidden bg-[linear-gradient(150deg,#11211a_0%,#12271c_46%,#0e3123_100%)] p-8 text-white md:w-[54%] md:p-12 dark:bg-[linear-gradient(150deg,#0c1a13_0%,#0f2419_46%,#0b2e21_100%)]">
        {/* ambient glow */}
        <div
          aria-hidden
          className="pointer-events-none absolute -right-24 -top-24 size-72 rounded-full bg-[radial-gradient(circle,rgba(14,159,110,0.32),transparent_70%)]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-24 -left-24 size-72 rounded-full bg-[radial-gradient(circle,rgba(56,225,164,0.10),transparent_70%)]"
        />

        <div className="relative flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-[11px] bg-primary">
            <Wallet className="size-[18px]" strokeWidth={2} />
          </span>
          <span className="text-lg font-extrabold tracking-tight">Pocket</span>
        </div>

        <div className="relative mt-10 space-y-6 md:mt-auto">
          <div className="space-y-3">
            <h1 className="whitespace-pre-line text-[clamp(2rem,3.4vw,3.1rem)] font-extrabold leading-[1.1] tracking-tight">
              {t("heroHeadline")}
            </h1>
            <p className="max-w-md text-white/70">{t("heroSub")}</p>
          </div>

          {/* portfolio glance card */}
          <div className="max-w-md rounded-[22px] border border-white/15 bg-white/[0.07] p-6 backdrop-blur">
            <div className="text-sm text-white/60">{t("glanceLabel")}</div>
            <div className="mt-1 flex items-center gap-3">
              <span className="font-mono text-3xl font-extrabold tabular-nums">
                Rp 40.650.000
              </span>
              <span className="rounded-full bg-[rgba(56,225,164,0.18)] px-2 py-0.5 text-sm font-semibold text-[#5FEAB6]">
                ▲ 18,2%
              </span>
            </div>
            <svg
              viewBox="0 0 320 56"
              className="mt-4 h-12 w-full"
              fill="none"
              preserveAspectRatio="none"
              aria-hidden
            >
              <path
                d="M0 44 L40 40 L80 42 L120 30 L160 34 L200 22 L240 26 L280 14 L320 10"
                stroke="#38E1A4"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <div className="mt-3 flex flex-wrap items-center gap-1.5 text-sm text-white/60">
              {t("connected")}
              <span className="font-medium text-white/90">
                Trade Republic · IBKR · DKB
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* Auth panel */}
      <section className="flex flex-1 items-center justify-center bg-background p-6 md:p-12">
        <div className="w-full max-w-sm space-y-6">
          <div className="space-y-2">
            <div className="text-[11px] font-extrabold uppercase tracking-[0.14em] text-primary">
              {t("kicker")}
            </div>
            <h2 className="text-3xl font-extrabold tracking-tight">
              {t("signInTitle")}
            </h2>
            <p className="text-sm text-muted-foreground">{t("signInSub")}</p>
          </div>

          <Button onClick={start} disabled={busy} className="w-full gap-2" size="lg">
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Shield className="size-4" />
            )}
            {busy ? t("ssoBusy") : t("sso")}
          </Button>

          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            {t("orEmail")}
            <span className="h-px flex-1 bg-border" />
          </div>

          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              start();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="email">{t("emailLabel")}</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                placeholder={t("emailPlaceholder")}
              />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="password">{t("passwordLabel")}</Label>
                <button
                  type="button"
                  onClick={start}
                  className="text-xs font-medium text-primary hover:underline"
                >
                  {t("forgot")}
                </button>
              </div>
              <div className="relative">
                <Input
                  id="password"
                  type={showPw ? "text" : "password"}
                  autoComplete="current-password"
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPw((v) => !v)}
                  aria-label={showPw ? "Hide password" : "Show password"}
                  className="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground"
                >
                  {showPw ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </div>
            <Button
              type="submit"
              disabled={busy}
              className="w-full gap-2 bg-foreground text-background hover:bg-foreground/90"
            >
              {t("signIn")}
              <ArrowRight className="size-4" />
            </Button>
          </form>

          <div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
            <Lock className="size-3.5" />
            {t("trust")}
          </div>
        </div>
      </section>
    </main>
  );
}
