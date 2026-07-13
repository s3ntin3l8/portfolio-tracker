// Rasterises the brand glyph into the PNG sizes a PWA needs. Run once after changing
// the icon; the outputs in public/icons are committed so production builds need no
// image tooling. Usage: `npm run generate-icons --workspace @portfolio/web`.
import sharp from "sharp";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "public");
const iconsDir = join(publicDir, "icons");

// The in-app brand mark (see src/components/brand.tsx): lucide-react "Layers", white on a
// brand-green tile. Keep in sync with brand.tsx if the glyph ever changes.
const LAYERS_PATHS = [
  "M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z",
  "M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12",
  "M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17",
];

// Emits the Layers glyph as a nested <svg>, centered in a `size`x`size` box at `scale` of
// that box. Default 0.5625 matches the in-app ratio (brand.tsx: 18px glyph / 32px tile).
function layersGlyph(size, scale = 0.5625) {
  const glyphSize = Math.round(size * scale);
  const offset = Math.round((size - glyphSize) / 2);
  return (
    `<svg x="${offset}" y="${offset}" width="${glyphSize}" height="${glyphSize}" viewBox="0 0 24 24" ` +
    `fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    LAYERS_PATHS.map((d) => `<path d="${d}"/>`).join("") +
    `</svg>`
  );
}

// Rounded tile (transparent corners) — fine for "any"-purpose icons + favicon.
const roundedSvg = await readFile(join(publicDir, "icon.svg"));
// Full-bleed opaque square — for maskable (OS applies its own mask) and apple-touch
// (iOS rounds the corners itself). The glyph is sized to sit inside the maskable safe zone.
const squareSvg = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">` +
    `<rect width="64" height="64" fill="#0e9f6e"/>${layersGlyph(64)}</svg>`,
);

await mkdir(iconsDir, { recursive: true });

const render = (input, size, out) =>
  sharp(input, { density: 512 })
    .resize(size, size)
    .png()
    .toFile(join(iconsDir, out));

await Promise.all([
  render(roundedSvg, 192, "icon-192.png"),
  render(roundedSvg, 512, "icon-512.png"),
  render(squareSvg, 512, "maskable-512.png"),
  render(squareSvg, 180, "apple-touch-icon.png"),
]);

console.log("Generated PWA icons → public/icons/");

// --- iOS splash screens (apple-touch-startup-image), issue #99 ---------------------------
// iOS Safari doesn't auto-generate a launch screen for installed PWAs (unlike
// Android/Chrome), so without these the app opens to a blank white flash before first
// paint — jarring against the dark theme. A curated subset of current common devices;
// extendable later. Keep this list in sync with `SPLASH_DEVICES` in
// `src/components/ios-splash-links.tsx`, which renders the matching <link> tags.
const SPLASH_DEVICES = [
  { name: "iphone-se", width: 375, height: 667, dpr: 2 },
  { name: "iphone-pro", width: 393, height: 852, dpr: 3 },
  { name: "iphone-pro-max", width: 430, height: 932, dpr: 3 },
  { name: "ipad-11", width: 834, height: 1194, dpr: 2 },
  { name: "ipad-12-9", width: 1024, height: 1366, dpr: 2 },
];

// Dark bg + centered brand tile (green square + white Layers glyph), sized to the device
// canvas — matches the app's dark default (`defaultTheme="dark"`). Splash can't react to
// the in-app theme toggle any more than the Android manifest's static theme_color can (see
// ThemeColorSync's doc comment).
function splashSvg(width, height) {
  const tileSize = Math.round(Math.min(width, height) * 0.16);
  const x = Math.round((width - tileSize) / 2);
  const y = Math.round((height - tileSize) / 2);
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
      `<rect width="${width}" height="${height}" fill="#0a0a0a"/>` +
      `<svg x="${x}" y="${y}" width="${tileSize}" height="${tileSize}" viewBox="0 0 64 64">` +
      `<rect width="64" height="64" rx="15" fill="#0e9f6e"/>${layersGlyph(64)}</svg>` +
      `</svg>`,
  );
}

const splashDir = join(iconsDir, "splash");
await mkdir(splashDir, { recursive: true });

await Promise.all(
  SPLASH_DEVICES.flatMap(({ name, width, height, dpr }) => [
    sharp(splashSvg(width * dpr, height * dpr))
      .png()
      .toFile(join(splashDir, `${name}-portrait.png`)),
    sharp(splashSvg(height * dpr, width * dpr))
      .png()
      .toFile(join(splashDir, `${name}-landscape.png`)),
  ]),
);

console.log("Generated iOS splash screens → public/icons/splash/");
