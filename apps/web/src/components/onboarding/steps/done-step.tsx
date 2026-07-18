import { Icon, ICONS } from "../icon";
import type { OnboardingTheme } from "../theme";
import styles from "../onboarding.module.css";

export interface DoneCopy {
  heading: string;
  readySub: string;
  skippedSub: string;
  cta: string;
}

/** Step 5 — Done. Copy is skip-aware: if the user skipped portfolio creation
 *  ("Skip setup" before step 3), it must not claim "Your portfolio is ready" — see
 *  `portfolioCreated`. */
export function DoneStep({
  th,
  copy,
  portfolioCreated,
  onFinish,
}: {
  th: OnboardingTheme;
  copy: DoneCopy;
  portfolioCreated: boolean;
  onFinish: () => void;
}) {
  return (
    <div
      className={styles.stepAnim}
      style={{
        minHeight: 420,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
      }}
    >
      <span
        style={{
          width: 62,
          height: 62,
          borderRadius: "50%",
          background: "#0E9F6E",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 14px 30px rgba(14,159,110,.34)",
        }}
      >
        <Icon d={ICONS.check} size={30} stroke="#fff" strokeWidth={2.6} />
      </span>
      <h2
        style={{ font: "800 25px 'Plus Jakarta Sans'", color: th.headColor, margin: "24px 0 7px" }}
      >
        {copy.heading}
      </h2>
      <p
        style={{
          font: "500 14px 'Plus Jakarta Sans'",
          color: th.subColor,
          margin: 0,
          maxWidth: 280,
        }}
      >
        {portfolioCreated ? copy.readySub : copy.skippedSub}
      </p>
      <button
        type="button"
        onClick={onFinish}
        style={{
          marginTop: 26,
          display: "inline-flex",
          alignItems: "center",
          gap: 7,
          font: "700 14px 'Plus Jakarta Sans'",
          color: "#fff",
          background: "#0E9F6E",
          border: "none",
          borderRadius: 12,
          padding: "13px 24px",
          cursor: "pointer",
          boxShadow: "0 8px 20px rgba(14,159,110,.28)",
        }}
      >
        {copy.cta}
        <Icon d={ICONS.arrowRight} size={16} strokeWidth={2.2} />
      </button>
    </div>
  );
}
