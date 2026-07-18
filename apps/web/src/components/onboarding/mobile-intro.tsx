"use client";

import { useEffect, useRef } from "react";
import { Icon, ICONS } from "./icon";
import styles from "./onboarding.module.css";

export type MobileSlideKind = "card" | "glyph";

export interface MobileSlideCopy {
  h: string;
  s: string;
  kind: MobileSlideKind;
  bullets: string[];
}

// Glyph path per slide index 1–3 (slide 0 shows the net-worth card instead) —
// verbatim from the design's `mSlides()`; copy itself comes from `next-intl` via props.
const SLIDE_GLYPHS = [
  null,
  ICONS.mobileIntro.holders,
  ICONS.mobileIntro.tax,
  ICONS.mobileIntro.data,
];

const AUTO_ADVANCE_MS = 4600;

export interface MobileIntroCopy {
  skip: string;
  getStarted: string;
  haveAccount: string;
  netWorthLabel: string;
  netWorthValue: string;
  netWorthPill: string;
  slides: MobileSlideCopy[];
}

/** Full-screen branded intro overlay shown first on mobile (`isMobileIntro`), before
 *  the step flow. Auto-advances every 4.6s (paused once dismissed); dots, left/right
 *  tap zones, Skip and Get started all dismiss it into the step flow. */
export function MobileIntro({
  copy,
  slide,
  onGoToSlide,
  onEnter,
}: {
  copy: MobileIntroCopy;
  slide: number;
  onGoToSlide: (index: number) => void;
  onEnter: () => void;
}) {
  // Latest callback/slide in a ref so the interval effect only depends on `slide`
  // itself — re-arming (clearInterval + setInterval) exactly on a real slide change,
  // mirroring the design's `armM()`/`goM()`, not on unrelated parent re-renders.
  const onGoToSlideRef = useRef(onGoToSlide);
  useEffect(() => {
    onGoToSlideRef.current = onGoToSlide;
  });

  useEffect(() => {
    const timer = setInterval(() => {
      onGoToSlideRef.current(slide + 1);
    }, AUTO_ADVANCE_MS);
    return () => clearInterval(timer);
  }, [slide]);

  const slides = copy.slides;
  const cur = slides[slide];
  const curGlyph = SLIDE_GLYPHS[slide];

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        background: "linear-gradient(155deg,#0c1a13 0%,#0f2419 44%,#0b2e21 100%)",
        color: "#fff",
        display: "flex",
        flexDirection: "column",
        padding: "56px 28px 34px",
        fontFamily: "'Plus Jakarta Sans',sans-serif",
        overflow: "hidden",
      }}
    >
      <div
        className={styles.driftGlowIntro}
        style={{
          position: "absolute",
          right: "-110px",
          top: "-90px",
          width: 320,
          height: 320,
          borderRadius: "50%",
          background: "radial-gradient(circle,rgba(14,159,110,.34),transparent 70%)",
          pointerEvents: "none",
        }}
      />
      <div
        className={styles.driftGlowIntroReverse}
        style={{
          position: "absolute",
          left: "-120px",
          bottom: "-140px",
          width: 340,
          height: 340,
          borderRadius: "50%",
          background: "radial-gradient(circle,rgba(56,225,164,.12),transparent 70%)",
          pointerEvents: "none",
        }}
      />
      <svg
        width="100%"
        height="100%"
        viewBox="0 0 400 844"
        preserveAspectRatio="none"
        className={styles.swayWaveIntro}
        style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
        aria-hidden
      >
        <path
          d="M0,430 C55,375 110,455 165,365 C220,275 275,375 330,295 C365,240 400,275 400,245 L400,844 L0,844 Z"
          fill="#fff"
          fillOpacity=".06"
        />
        <path
          d="M0,520 C65,465 130,545 195,455 C260,365 315,445 370,365 C388,340 400,350 400,330 L400,844 L0,844 Z"
          fill="#38E1A4"
          fillOpacity=".10"
        />
        <path
          d="M0,610 C65,560 130,630 195,550 C260,470 315,550 370,490 C388,465 400,480 400,450 L400,844 L0,844 Z"
          fill="#0E9F6E"
          fillOpacity=".18"
        />
        <path
          d="M0,610 C65,560 130,630 195,550 C260,470 315,550 370,490 C388,465 400,480 400,450"
          fill="none"
          stroke="#38E1A4"
          strokeWidth="2"
          strokeOpacity=".45"
        />
      </svg>

      <button
        type="button"
        onClick={() => onGoToSlide(slide - 1)}
        aria-label="Previous"
        style={{
          position: "absolute",
          left: 0,
          top: 120,
          bottom: 210,
          width: "40%",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          zIndex: 2,
        }}
      />
      <button
        type="button"
        onClick={() => onGoToSlide(slide + 1)}
        aria-label="Next"
        style={{
          position: "absolute",
          right: 0,
          top: 120,
          bottom: 210,
          width: "40%",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          zIndex: 2,
        }}
      />

      <div style={{ display: "flex", alignItems: "center", position: "relative", zIndex: 3 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
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
        <button
          type="button"
          onClick={onEnter}
          style={{
            marginLeft: "auto",
            background: "none",
            border: "none",
            padding: "6px 4px",
            cursor: "pointer",
            font: "600 13px 'Plus Jakarta Sans'",
            color: "rgba(255,255,255,.6)",
          }}
        >
          {copy.skip}
        </button>
      </div>

      <div
        key={`m-${slide}`}
        className={styles.fadeStep}
        style={{
          position: "relative",
          zIndex: 1,
          display: "flex",
          flexDirection: "column",
          flex: 1,
        }}
      >
        {cur.kind === "card" && (
          <div style={{ marginTop: 38 }}>
            <div
              className={styles.floaty}
              style={{
                background: "linear-gradient(160deg,rgba(14,159,110,.92),rgba(11,125,88,.92))",
                border: "1px solid rgba(255,255,255,.14)",
                borderRadius: 20,
                padding: "18px 20px",
                boxShadow: "0 22px 48px rgba(0,0,0,.4)",
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
                <div>
                  <div
                    style={{ font: "600 11px 'Plus Jakarta Sans'", color: "rgba(255,255,255,.78)" }}
                  >
                    {copy.netWorthLabel}
                  </div>
                  <div
                    className="tabular-nums"
                    style={{ font: "800 24px 'Plus Jakarta Sans'", color: "#fff", marginTop: 5 }}
                  >
                    {copy.netWorthValue}
                  </div>
                </div>
                <span
                  style={{
                    font: "700 11px 'Plus Jakarta Sans'",
                    color: "#fff",
                    background: "rgba(255,255,255,.2)",
                    borderRadius: 999,
                    padding: "5px 9px",
                    whiteSpace: "nowrap",
                  }}
                >
                  {copy.netWorthPill}
                </span>
              </div>
              <svg
                viewBox="0 0 70 24"
                width="100%"
                height={34}
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
            </div>
          </div>
        )}
        {cur.kind === "glyph" && (
          <div style={{ marginTop: 44, display: "flex" }}>
            <span
              className={styles.floaty}
              style={{
                width: 78,
                height: 78,
                borderRadius: 22,
                background: "linear-gradient(160deg,rgba(14,159,110,.9),rgba(11,125,88,.9))",
                border: "1px solid rgba(255,255,255,.16)",
                boxShadow: "0 20px 44px rgba(0,0,0,.4)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {curGlyph && <Icon d={curGlyph} size={38} stroke="#fff" strokeWidth={1.9} />}
            </span>
          </div>
        )}
        <div style={{ marginTop: "auto" }}>
          <h1
            style={{
              font: "800 32px/1.15 'Plus Jakarta Sans'",
              margin: 0,
              letterSpacing: "-.02em",
            }}
          >
            {cur.h}
          </h1>
          <p
            style={{
              font: "500 15px/1.6 'Plus Jakarta Sans'",
              color: "rgba(255,255,255,.66)",
              margin: "15px 0 0",
            }}
          >
            {cur.s}
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 20 }}>
            {cur.bullets.map((text, i) => (
              <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                <span
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: "50%",
                    background: "#38E1A4",
                    marginTop: 8,
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{
                    font: "500 13px/1.5 'Plus Jakarta Sans'",
                    color: "rgba(255,255,255,.74)",
                  }}
                >
                  {text}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ position: "relative", zIndex: 3, marginTop: 26 }}>
        <div style={{ display: "flex", gap: 7, marginBottom: 20 }}>
          {slides.map((_, k) => (
            <button
              key={k}
              type="button"
              onClick={() => onGoToSlide(k)}
              aria-label="Go to slide"
              style={{
                width: k === slide ? 22 : 7,
                height: 7,
                borderRadius: 999,
                border: "none",
                padding: 0,
                cursor: "pointer",
                background: k === slide ? "#38E1A4" : "rgba(255,255,255,.24)",
                transition: "width .25s, background .25s",
              }}
            />
          ))}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
          <button
            type="button"
            onClick={onEnter}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              font: "700 16px 'Plus Jakarta Sans'",
              color: "#fff",
              background: "#0E9F6E",
              border: "none",
              borderRadius: 14,
              padding: 16,
              cursor: "pointer",
              boxShadow: "0 12px 28px rgba(14,159,110,.4)",
            }}
          >
            {copy.getStarted}
            <Icon d={ICONS.arrowRight} size={17} strokeWidth={2.2} />
          </button>
          {/* "I already have an account" has no handler in the source design (a dead
              button) — routed to the same dismiss-intro action since there's no
              separate sign-in surface inside onboarding (flagged as ambiguous). */}
          <button
            type="button"
            onClick={onEnter}
            style={{
              width: "100%",
              font: "700 14px 'Plus Jakarta Sans'",
              color: "rgba(255,255,255,.82)",
              background: "transparent",
              border: "none",
              padding: 6,
              cursor: "pointer",
            }}
          >
            {copy.haveAccount}
          </button>
        </div>
      </div>
    </div>
  );
}
