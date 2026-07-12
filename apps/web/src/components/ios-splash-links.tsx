/**
 * iOS Safari doesn't auto-generate a launch/splash screen for installed PWAs (unlike
 * Android/Chrome), so without these `<link>` tags the app opens to a blank white flash
 * before first paint — jarring against the dark theme. Closes issue #99.
 *
 * A curated subset of current common devices, extendable later. Keep this list in sync
 * with `SPLASH_DEVICES` in `scripts/generate-icons.mjs`, which renders the matching PNGs
 * (`npm run generate-icons --workspace @portfolio/web`).
 *
 * Next's Metadata API has no field for `apple-touch-startup-image`, so these are rendered
 * as plain `<link>` elements — React 19 hoists `<link>`/`<meta>`/`<title>` it renders
 * anywhere in the tree up into `<head>`, regardless of where this component is mounted.
 */
const SPLASH_DEVICES = [
  { name: "iphone-se", width: 375, height: 667, dpr: 2 },
  { name: "iphone-pro", width: 393, height: 852, dpr: 3 },
  { name: "iphone-pro-max", width: 430, height: 932, dpr: 3 },
  { name: "ipad-11", width: 834, height: 1194, dpr: 2 },
  { name: "ipad-12-9", width: 1024, height: 1366, dpr: 2 },
] as const;

function mediaQuery(
  width: number,
  height: number,
  dpr: number,
  orientation: "portrait" | "landscape",
) {
  return `(device-width: ${width}px) and (device-height: ${height}px) and (-webkit-device-pixel-ratio: ${dpr}) and (orientation: ${orientation})`;
}

export function IosSplashLinks() {
  return (
    <>
      {SPLASH_DEVICES.flatMap(({ name, width, height, dpr }) => [
        <link
          key={`${name}-portrait`}
          rel="apple-touch-startup-image"
          href={`/icons/splash/${name}-portrait.png`}
          media={mediaQuery(width, height, dpr, "portrait")}
        />,
        <link
          key={`${name}-landscape`}
          rel="apple-touch-startup-image"
          href={`/icons/splash/${name}-landscape.png`}
          media={mediaQuery(width, height, dpr, "landscape")}
        />,
      ])}
    </>
  );
}
