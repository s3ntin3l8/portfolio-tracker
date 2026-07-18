/** Static ambient brand backdrop behind the mobile content panel (`isMobileDark` /
 *  `isMobileLight`) — shown once the intro carousel is dismissed. Verbatim from the
 *  design; no animation here (only the intro overlay's wave sways). */
export function MobileBackdrop({ isDark }: { isDark: boolean }) {
  const glow = isDark ? "rgba(14,159,110,.4)" : "rgba(14,159,110,.12)";
  const fill = isDark ? "#38E1A4" : "#0E9F6E";
  const fillOpA = isDark ? ".05" : ".04";
  const fillOpB = isDark ? ".08" : ".06";
  const strokeOp = isDark ? ".35" : ".16";
  const fillA = isDark ? "#fff" : "#0E9F6E";

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          right: "-90px",
          top: "-70px",
          width: 280,
          height: 280,
          borderRadius: "50%",
          background: `radial-gradient(circle,${glow},transparent 70%)`,
        }}
      />
      <svg
        width="100%"
        height="100%"
        viewBox="0 0 400 800"
        preserveAspectRatio="none"
        style={{ position: "absolute", inset: 0 }}
        aria-hidden
      >
        <path
          d="M0,420 C55,370 110,450 165,360 C220,270 275,370 330,290 C365,235 400,270 400,240 L400,800 L0,800 Z"
          fill={fillA}
          fillOpacity={fillOpA}
        />
        <path
          d="M0,500 C65,450 130,530 195,440 C260,350 315,430 370,350 C388,325 400,335 400,315 L400,800 L0,800 Z"
          fill={fill}
          fillOpacity={fillOpB}
        />
        <path
          d="M0,590 C65,540 130,610 195,530 C260,450 315,530 370,470 C388,445 400,460 400,430"
          fill="none"
          stroke={fill}
          strokeWidth={isDark ? 1.6 : 1.6}
          strokeOpacity={strokeOp}
        />
      </svg>
    </div>
  );
}
