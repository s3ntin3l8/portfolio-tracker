import { Icon, ICONS } from "../icon";
import type { OnboardingTheme } from "../theme";

const TOUR_ICONS = [
  ICONS.tour.holdings,
  ICONS.tour.activity,
  ICONS.tour.reports,
  ICONS.tour.insights,
  ICONS.tour.profile,
];

export interface WelcomeCopy {
  previewLabel: string;
  previewValue: string;
  previewPill: string;
  previewCaption: string;
  tourSectionLabel: string;
  /** One entry per `TOUR_ICONS`, in order (holdings/activity/reports/insights/profile). */
  tourItems: { label: string; desc: string }[];
}

/** Step 0 — Welcome + "what you'll find inside" tour. Static preview card + 5 tour rows. */
export function WelcomeStep({ th, copy }: { th: OnboardingTheme; copy: WelcomeCopy }) {
  return (
    <>
      <div
        style={{
          background: "linear-gradient(160deg,#0E9F6E,#0B7D58)",
          borderRadius: 18,
          padding: "18px 20px",
          marginBottom: 22,
          boxShadow: "0 12px 30px rgba(14,159,110,.30)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 10,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ font: "600 11px 'Plus Jakarta Sans'", color: "rgba(255,255,255,.78)" }}>
              {copy.previewLabel}
            </div>
            <div
              className="tabular-nums"
              style={{
                font: "800 22px 'Plus Jakarta Sans'",
                color: "#fff",
                marginTop: 5,
                whiteSpace: "nowrap",
              }}
            >
              {copy.previewValue}
            </div>
          </div>
          <span
            style={{
              flexShrink: 0,
              font: "700 11px 'Plus Jakarta Sans'",
              color: "#fff",
              background: "rgba(255,255,255,.18)",
              borderRadius: 999,
              padding: "5px 9px",
              whiteSpace: "nowrap",
            }}
          >
            {copy.previewPill}
          </span>
        </div>
        <svg
          viewBox="0 0 70 24"
          width="100%"
          height={30}
          preserveAspectRatio="none"
          style={{ marginTop: 14, display: "block" }}
          aria-hidden
        >
          <polyline
            points="0,20 10,16 20,18 30,10 40,13 50,6 60,9 70,2"
            fill="none"
            stroke="#fff"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <div
          style={{
            font: "500 10.5px 'Plus Jakarta Sans'",
            color: "rgba(255,255,255,.55)",
            marginTop: 10,
          }}
        >
          {copy.previewCaption}
        </div>
      </div>
      <div
        style={{
          font: "700 11px 'Plus Jakarta Sans'",
          letterSpacing: ".1em",
          textTransform: "uppercase",
          color: th.dividerText,
          marginBottom: 12,
        }}
      >
        {copy.tourSectionLabel}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 26 }}>
        {copy.tourItems.map((t, i) => (
          <div
            key={t.label}
            style={{ display: "flex", alignItems: "flex-start", gap: 13, padding: "11px 4px" }}
          >
            <span
              style={{
                width: 34,
                height: 34,
                flexShrink: 0,
                borderRadius: 10,
                background: th.chipBg,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Icon d={TOUR_ICONS[i]} size={17} stroke={th.kicker} />
            </span>
            <div>
              <div style={{ font: "700 14px 'Plus Jakarta Sans'", color: th.headColor }}>
                {t.label}
              </div>
              <div
                style={{
                  font: "500 12.5px/1.4 'Plus Jakarta Sans'",
                  color: th.subColor,
                  marginTop: 1,
                }}
              >
                {t.desc}
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
