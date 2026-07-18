/** Renders one of the design's raw SVG path strings verbatim — the source uses inline
 *  hand-drawn icons (not a library), so path data is reproduced exactly rather than
 *  swapped for a lucide equivalent. */
export function Icon({
  d,
  size = 17,
  stroke = "currentColor",
  strokeWidth = 2,
}: {
  d: string;
  size?: number;
  stroke?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={stroke}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}

// Shared icon path constants used across steps/chrome (verbatim from the design).
export const ICONS = {
  wallet:
    "M3 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM16 12.5h3.5M3 10h13",
  sun: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  moonPath:
    "M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  back: "M19 12H5M11 18l-6-6 6-6",
  check: "M5 12.5l4.5 4.5L19 7",
  chevronDown: "M6 9l6 6 6-6",
  arrowRight: "M5 12h14M13 6l6 6-6 6",
  building: "M3 21h18M5 21V9l7-5 7 5v12M9 21v-6h6v6",
  tour: {
    holdings: "M12 2 2 7l10 5 10-5-10-5ZM2 17l10 5 10-5M2 12l10 5 10-5",
    activity: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
    reports:
      "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8",
    insights: "M3 3v18h18M18 17V9M13 17V5M8 17v-3",
    profile: "M20 21a8 8 0 0 0-16 0M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
  },
  addData: {
    connect:
      "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
    import: "M12 3v12M7 8l5-5 5 5M5 21h14",
    manual: "M12 8v8M8 12h8M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
    skip: "M5 12h14M13 6l6 6-6 6",
  },
  mobileIntro: {
    holders:
      "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
    tax: "M9 14l6-6M9.5 8.5h.01M14.5 13.5h.01M6 2h12a2 2 0 0 1 2 2v18l-3-2-2 2-2-2-2 2-2-2-3 2V4a2 2 0 0 1 2-2Z",
    data: "M12 3v12M7 8l5-5 5 5M5 21h14",
  },
} as const;
