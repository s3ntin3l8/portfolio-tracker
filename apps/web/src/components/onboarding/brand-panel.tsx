import { Icon, ICONS } from "./icon";
import { StepBackground, BG_SEQUENCE } from "./brand-backgrounds";
import type { OnboardingTheme } from "./theme";
import styles from "./onboarding.module.css";

/** Desktop-only (`isDesktop`) left brand panel: logo, per-step animated background,
 *  and the headline/subcopy/bullets block that syncs to the current step. Ported
 *  verbatim from the design's `isDesktop` brand block. */
export function BrandPanel({
  th,
  step,
  stepTitle,
  brandHeadline,
  brandSub,
  brandBullets,
}: {
  th: OnboardingTheme;
  step: number;
  stepTitle: string;
  brandHeadline: string;
  brandSub: string;
  brandBullets: string[];
}) {
  return (
    <div
      style={{
        flex: "1 1 44%",
        minWidth: 0,
        background: th.brandGrad,
        color: "#fff",
        padding: "56px 60px",
        display: "flex",
        flexDirection: "column",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div
        className={styles.driftGlow}
        style={{
          position: "absolute",
          right: "-140px",
          top: "-120px",
          width: 440,
          height: 440,
          borderRadius: "50%",
          background: "radial-gradient(circle,rgba(14,159,110,.28),transparent 70%)",
          pointerEvents: "none",
        }}
      />
      <div
        className={styles.driftGlowReverse}
        style={{
          position: "absolute",
          left: "-120px",
          bottom: "-160px",
          width: 420,
          height: 420,
          borderRadius: "50%",
          background: "radial-gradient(circle,rgba(56,225,164,.10),transparent 70%)",
          pointerEvents: "none",
        }}
      />

      {/* rotating background, faded in per step — remounted (key) so the
          fadeIn+swayWave animation restarts on every step change */}
      <div
        key={stepTitle}
        className={styles.swayWaveBrand}
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          transformOrigin: "center bottom",
        }}
      >
        <StepBackground variant={BG_SEQUENCE[step]} />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, position: "relative" }}>
        <span
          style={{
            width: 40,
            height: 40,
            borderRadius: 13,
            background: "#0E9F6E",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon d={ICONS.wallet} size={22} stroke="#fff" />
        </span>
        <span style={{ font: "800 20px 'Plus Jakarta Sans'" }}>Pocket</span>
      </div>

      <div style={{ marginTop: "auto", position: "relative", maxWidth: 420 }}>
        <div key={stepTitle} className={styles.stepAnim}>
          <h1
            style={{
              font: "800 clamp(28px,2.6vw,38px)/1.16 'Plus Jakarta Sans'",
              margin: 0,
              letterSpacing: "-.015em",
            }}
          >
            {brandHeadline}
          </h1>
          <p
            style={{
              font: "500 15px/1.6 'Plus Jakarta Sans'",
              color: "rgba(255,255,255,.62)",
              margin: "16px 0 0",
            }}
          >
            {brandSub}
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 22 }}>
            {brandBullets.map((text, i) => (
              <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 9 }}>
                <span
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: "50%",
                    background: "#38E1A4",
                    marginTop: 7,
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{
                    font: "500 12.5px/1.5 'Plus Jakarta Sans'",
                    color: "rgba(255,255,255,.72)",
                  }}
                >
                  {text}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
