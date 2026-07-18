/** The three per-step desktop brand-panel background variants (`isBgArea` /
 *  `isBgDiagonal` / `isBgBars`), verbatim from the design's inline SVGs. Which one
 *  shows is driven by `bgSequence` in `onboarding-flow.tsx`. */

const BAR_HEIGHTS = [
  220, 380, 160, 480, 280, 620, 340, 440, 200, 560, 300, 420, 180, 520, 360, 240, 460, 300,
];
const BAR_COLORS = ["#fff", "#38E1A4", "#0E9F6E"];

/** `bars` from `renderVals()` — 18 rects, x/y/height/color/opacity all derived. */
export function computeBars() {
  return BAR_HEIGHTS.map((h, i) => ({
    x: 20 + i * 25,
    y: 820 - h,
    h,
    color: BAR_COLORS[i % 3],
    op: i % 3 === 2 ? 0.22 : i % 3 === 1 ? 0.15 : 0.08,
  }));
}

export function AreaBackground() {
  return (
    <svg
      width="100%"
      height="100%"
      viewBox="0 0 460 900"
      preserveAspectRatio="none"
      style={{ position: "absolute", inset: 0 }}
      aria-hidden
    >
      <path
        d="M0,460 C60,400 100,480 150,380 C200,280 250,400 300,300 C350,200 400,300 460,220 L460,900 L0,900 Z"
        fill="#fff"
        fillOpacity=".08"
      />
      <path
        d="M0,520 C50,470 110,550 160,460 C210,370 260,470 310,390 C360,310 410,380 460,300 L460,900 L0,900 Z"
        fill="#38E1A4"
        fillOpacity=".14"
      />
      <path
        d="M0,600 C60,550 120,620 170,540 C220,460 270,540 320,480 C370,420 410,460 460,380 L460,900 L0,900 Z"
        fill="#0E9F6E"
        fillOpacity=".20"
      />
      <path
        d="M0,600 C60,550 120,620 170,540 C220,460 270,540 320,480 C370,420 410,460 460,380"
        fill="none"
        stroke="#38E1A4"
        strokeWidth="2"
        strokeOpacity=".45"
      />
    </svg>
  );
}

export function DiagonalBackground() {
  return (
    <svg
      width="100%"
      height="100%"
      viewBox="0 0 460 900"
      preserveAspectRatio="none"
      style={{ position: "absolute", inset: 0 }}
      aria-hidden
    >
      <line x1="0" y1="140" x2="460" y2="140" stroke="#fff" strokeOpacity=".08" strokeWidth="1" />
      <line x1="0" y1="340" x2="460" y2="340" stroke="#fff" strokeOpacity=".08" strokeWidth="1" />
      <line x1="0" y1="540" x2="460" y2="540" stroke="#fff" strokeOpacity=".08" strokeWidth="1" />
      <line x1="0" y1="740" x2="460" y2="740" stroke="#fff" strokeOpacity=".08" strokeWidth="1" />
      <path
        d="M0,800 C70,760 120,790 170,670 C220,550 260,610 310,470 C360,330 400,380 460,130 L460,900 L0,900 Z"
        fill="#0E9F6E"
        fillOpacity=".18"
      />
      <path
        d="M0,800 C70,760 120,790 170,670 C220,550 260,610 310,470 C360,330 400,380 460,130"
        fill="none"
        stroke="#38E1A4"
        strokeWidth="2.5"
        strokeOpacity=".5"
      />
      <circle cx="170" cy="670" r="5" fill="#38E1A4" fillOpacity=".6" />
      <circle cx="310" cy="470" r="5" fill="#38E1A4" fillOpacity=".6" />
      <circle cx="460" cy="130" r="6" fill="#38E1A4" fillOpacity=".7" />
    </svg>
  );
}

export function BarsBackground() {
  const bars = computeBars();
  return (
    <svg
      width="100%"
      height="100%"
      viewBox="0 0 460 900"
      preserveAspectRatio="none"
      style={{ position: "absolute", inset: 0 }}
      aria-hidden
    >
      {bars.map((b, i) => (
        <rect
          key={i}
          x={b.x}
          y={b.y}
          width={18}
          height={b.h}
          rx={3}
          fill={b.color}
          fillOpacity={b.op}
        />
      ))}
    </svg>
  );
}

/** `bgSequence` from `renderVals()`, indexed by step 0–5. */
export const BG_SEQUENCE = ["area", "diagonal", "bars", "diagonal", "bars", "area"] as const;

export function StepBackground({ variant }: { variant: (typeof BG_SEQUENCE)[number] }) {
  if (variant === "area") return <AreaBackground />;
  if (variant === "diagonal") return <DiagonalBackground />;
  return <BarsBackground />;
}
