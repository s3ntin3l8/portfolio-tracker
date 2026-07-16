import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

// eslint-config-next 16 ships native ESLint flat config arrays under these subpaths,
// so we spread them directly instead of bridging legacy configs via FlatCompat.
const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    // eslint-plugin-react (bundled by eslint-config-next 16) auto-detects the React
    // version via an ESLint-10-removed API; pin it so detection is skipped.
    settings: { react: { version: "19" } },
  },
  {
    // eslint-config-next ships its own @typescript-eslint/no-unused-vars ("warn", no
    // ignore pattern) — this config array doesn't extend the root eslint.config.js, so
    // it doesn't inherit that config's `^_` ignore pattern. Restore it here so the
    // leading-underscore "intentionally unused" convention (used throughout the rest of
    // the monorepo) is honored in apps/web too, instead of silently warning on it.
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // public/ holds static assets + serwist's generated service worker (public/sw.js);
    // coverage/ is a generated (gitignored) Vitest artifact, not source.
    ignores: [".next/**", "node_modules/**", "next-env.d.ts", "public/**", "coverage/**"],
  },
];

export default eslintConfig;
