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
    // public/ holds static assets + serwist's generated service worker (public/sw.js);
    // coverage/ is a generated (gitignored) Vitest artifact, not source.
    ignores: [".next/**", "node_modules/**", "next-env.d.ts", "public/**", "coverage/**"],
  },
];

export default eslintConfig;
