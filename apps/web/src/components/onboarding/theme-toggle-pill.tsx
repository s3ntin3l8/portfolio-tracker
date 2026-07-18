import type { CSSProperties } from "react";
import { Icon, ICONS } from "./icon";
import type { OnboardingTheme } from "./theme";

/** The onboarding flow's own theme toggle pill (distinct from the app-wide
 *  `theme-toggle.tsx` — this one is styled entirely from the `th` object to match
 *  the design, and is rendered both fixed-desktop and inline-mobile). */
export function ThemeTogglePill({
  th,
  isDark,
  label,
  onToggle,
  style,
}: {
  th: OnboardingTheme;
  isDark: boolean;
  /** The action label — i.e. the opposite of the current theme ("Light" while dark,
   *  "Dark" while light). Passed in already-translated so this component stays
   *  i18n-agnostic. */
  label: string;
  onToggle: () => void;
  style?: CSSProperties;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        background: th.toggleBg,
        border: `1px solid ${th.toggleBorder}`,
        borderRadius: 999,
        padding: "7px 12px",
        cursor: "pointer",
        font: "700 12px 'Plus Jakarta Sans'",
        color: th.toggleText,
        ...style,
      }}
    >
      {!isDark && <Icon d={ICONS.sun} size={15} />}
      {isDark && (
        <svg
          width={15}
          height={15}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <circle cx="12" cy="12" r="4" />
          <path d={ICONS.moonPath} />
        </svg>
      )}
      {label}
    </button>
  );
}
