import type { CSSProperties } from "react";

/**
 * Verbatim from `Onboarding.dc.html`'s `darkTh`/`lightTh` — do not restyle. Every
 * hex/rgba value here is load-bearing for pixel parity with the design source.
 */
export interface OnboardingTheme {
  pageBg: string;
  panelBg: string;
  kicker: string;
  headColor: string;
  subColor: string;
  dividerLine: string;
  dividerText: string;
  labelColor: string;
  /** CSS-module class name for the themed text input (`in-d` / `in-l` / `in-a`). */
  inputClass: string;
  toggleBg: string;
  toggleBorder: string;
  toggleText: string;
  cardBg: string;
  cardBorder: string;
  cardBgSel: string;
  chipBg: string;
  chipText: string;
  dotOff: string;
  dotOn: string;
  brandGrad: string;
}

export const darkTh: OnboardingTheme = {
  pageBg: "#0E1512",
  panelBg: "#121915",
  kicker: "#12B981",
  headColor: "#E7EDE9",
  subColor: "#8A988F",
  dividerLine: "#222A26",
  dividerText: "#66746B",
  labelColor: "#AEBBB2",
  inputClass: "inD",
  toggleBg: "rgba(255,255,255,.06)",
  toggleBorder: "#2A342E",
  toggleText: "#AEBBB2",
  cardBg: "#141B17",
  cardBorder: "#2A342E",
  cardBgSel: "rgba(14,159,110,.14)",
  chipBg: "rgba(255,255,255,.06)",
  chipText: "#8A988F",
  dotOff: "#2A342E",
  dotOn: "#0E9F6E",
  brandGrad: "linear-gradient(150deg,#0c1a13 0%,#0f2419 46%,#0b2e21 100%)",
};

export const lightTh: OnboardingTheme = {
  pageBg: "#fff",
  panelBg: "#fff",
  kicker: "#0E9F6E",
  headColor: "#11211a",
  subColor: "#7C8A82",
  dividerLine: "#EAEFEC",
  dividerText: "#9AA8A0",
  labelColor: "#5B6B62",
  inputClass: "inL",
  toggleBg: "#F1F4F2",
  toggleBorder: "#E7EDEA",
  toggleText: "#5B6B62",
  cardBg: "#fff",
  cardBorder: "#E1E8E4",
  cardBgSel: "rgba(14,159,110,.06)",
  chipBg: "#F1F4F2",
  chipText: "#5B6B62",
  dotOff: "#E1E8E4",
  dotOn: "#0E9F6E",
  brandGrad: "linear-gradient(150deg,#11211a 0%,#12271c 46%,#0e3123 100%)",
};

/**
 * Resolve the active theme object given dark/light + desktop/mobile. Mobile+dark
 * swaps in the translucent `in-a` input variant (the content panel sits directly on
 * the brand gradient there, so an opaque `in-d` input would look wrong) — everything
 * else about `darkTh` is unchanged.
 */
export function resolveTheme(isDark: boolean, isDesktop: boolean): OnboardingTheme {
  const base = isDark ? darkTh : lightTh;
  if (!isDesktop && isDark) return { ...darkTh, inputClass: "inA" };
  return base;
}

/** Verbatim `cardStyle(th, selected)` from the source — selectable option cards
 *  (tax regime, cash-counting choice) share this exact treatment. */
export function cardStyle(th: OnboardingTheme, selected: boolean): CSSProperties {
  return {
    display: "block",
    width: "100%",
    textAlign: "left",
    border: `1.5px solid ${selected ? "#0E9F6E" : th.dividerLine}`,
    borderRadius: "14px",
    padding: "15px 16px",
    cursor: "pointer",
    background: selected ? th.cardBgSel : th.cardBg,
    transition: "border-color .15s,background .15s",
  };
}
