# Pocket design-sync notes

Syncs `apps/web/src/components/ui/` (shadcn/ui + Radix primitives) — not a standalone
package. There is no dedicated design-system repo; this scopes the sync into the
Pocket app itself via `cfg.srcDir` + the npm-workspace symlink.

## Repo-specific setup, not covered by the base skill

- **No dist, no package.json for the UI folder.** `cfg.pkg = "@portfolio/web"` with
  NO `cfg.entry` — `PKG_DIR` resolves via the npm workspace symlink
  (`node_modules/@portfolio/web` → `apps/web`, created by `npm install` at the repo
  root). **Never add `cfg.entry`/`--entry`** — that disables synth-entry mode and the
  build silently produces a tokens-only DS with zero component cards (confirmed via
  advisor during the first sync). `cfg.srcDir = "src/components/ui"` scopes discovery
  to just that folder, not the whole app.
- **Tailwind v4 CSS is compiled by a custom script**, `.ds-sync/tailwind-compile.mjs`
  (not part of the base skill — this repo has no build step that emits a static
  stylesheet; Next compiles Tailwind v4's CSS-first `@theme` at app-build time only).
  It processes `apps/web/src/app/globals.css` through `@tailwindcss/postcss` with
  explicit `@source` directives for `components/ui/**` and
  `.design-sync/previews/**`, writes to `apps/web/.ds-sync-css/compiled.css`
  (`cfg.cssEntry`), and prepends a Google Fonts `@import` + `--font-jakarta`/
  `--font-dm-mono` var definitions (see Fonts below). **Re-run
  `node .ds-sync/tailwind-compile.mjs` before every `package-build.mjs`/driver run**
  — content-detection only sees classes used in files that exist at compile time, so
  newly-authored preview `.tsx` files need a recompile before their utility classes
  land in the shipped CSS. `resync.mjs` does NOT call this script automatically.
- **Fonts**: the app loads Plus Jakarta Sans / DM Mono via `next/font/google`
  (self-hosted at Next.js build time — no static font file exists to scrape).
  `tailwind-compile.mjs` resolves both from Google Fonts' CDN via a remote `@import`
  instead (`[FONT_REMOTE]`, non-blocking) — same real families, just loaded at
  runtime from Google rather than self-hosted. Depends on an external CDN being
  reachable wherever designs render; if that ever needs to change to a self-hosted
  copy, source the actual `.woff2` files and wire them via `cfg.extraFonts`.
- **Preview imports MUST use the bare package specifier**, `import { X } from
"@portfolio/web"` — never `@/components/ui/x` or any relative/aliased path. This
  repo's filenames are lowercase-kebab (`button.tsx`) while exports are PascalCase
  (`Button`); the design-sync tooling's auto-shim heuristic
  (`lib/story-imports.mjs`'s `exportedComponentFor`) matches on filename-equals-export
  and silently misses here, which would bundle a second source copy instead of
  rendering the real `window.PocketUI` bundle. The bare-specifier import (rule 1,
  always correct) is what every authored preview in this repo uses — verified working
  for all 13 authored components.
- **`componentSrcMap` nulls ~39 known subcomponent exports** (`Card{Header,Title,
Description,Content,Footer}`, `Command{Dialog,Input,List,Empty,Group,Item,Separator,
Shortcut}`, `Dialog{Trigger,Close,Content,Header,Footer,Title,Description}`,
  `DropdownMenu{Trigger,Content,Item,Label,Separator}`, `Sheet{Trigger,Close,Content,
Header,Title}`, `Table{Header,Body,Footer,Row,Head,Cell}`,
  `Tabs{List,Trigger,Content}`) so they don't become standalone root cards — there's
  no `.d.ts` compound-detection signal (`Card.Header = ...`) since this repo uses
  flat named exports, so the converter's automatic subcomponent grouping never fires.
  **If a new compound component is added to `ui/`** (or an existing one gains new
  sub-exports), its subcomponents will show up as new standalone root cards on the
  next re-sync unless added to this null-map by hand.

## Current scope

- 22 components in the bundle (all of `apps/web/src/components/ui/*.tsx`, one file =
  `use-chart-tooltip.ts`, a hook, correctly excluded).
- 13 authored with real preview stories (Badge, Button, Card, Dialog, DropdownMenu,
  FormField, Input, Select, Sheet, SortableTableHead, Switch, Table, Tabs) — user
  chose "core ~12" scope (SortableTableHead was added because its unauthored render
  came up broken, not cleanly floor-carded).
- 9 on the floor card by choice (ChartTooltipPanel, Command, DatePicker, ErrorBanner,
  Label, Separator, Skeleton, Spinner, Toaster) — all fully importable/functional,
  just no authored story yet. Authorable incrementally on any future re-sync.
- **Known render warn**: `Spinner` — `[RENDER_THIN]`. Legitimate: it's a small icon,
  correctly tiny, not broken. Triaged, not a bug.
- **If DatePicker is ever authored**: it reads `next-intl` context and throws outside
  it — wrap its preview in `NextIntlClientProvider` (see `conventions.md`).

## Re-sync risks

- `apps/web/.ds-sync-css/compiled.css` is a generated artifact (gitignored via
  `.ds-sync-css` not being tracked — verify it's covered by `apps/web/.gitignore` or
  add an entry) tied to whatever classes exist in `components/ui/` +
  `.design-sync/previews/` at compile time. Stale if `tailwind-compile.mjs` isn't
  re-run before a build — a rebuilt bundle with unstyled new-preview classes is the
  silent failure mode to watch for.
- The Google Fonts remote `@import` is an external dependency the base skill's
  `[FONT_REMOTE]` tag treats as informational/non-blocking — fine as long as
  fonts.googleapis.com stays reachable at design-render time.
- `cfg.componentSrcMap`'s subcomponent null-list is hand-maintained (see above) — it
  will drift if `ui/` grows new compound components.

## App-side token count (Tailwind internals) — expected, not a bug

After the first sync landed, claude.ai/design's ingestion reported ~42 "unclassified"
tokens (`:root`-level) and ~38 "props under component selectors" — both are Tailwind
compiler internals (`--tw-translate-x`, `--tw-pan-y`, `--animate-spin`,
`--default-transition-duration`, …), not real design tokens. This is **expected and
irreducible**, confirmed by reading the design-sync skill source directly:

- The counts come from claude.ai/design's own server-side scope filter, not this
  repo's tooling — the skill emits no such warning locally, and token "kinds" there
  are only a cosmetic README grouping (`lib/emit.mjs`'s color/spacing/typography/
  radius/shadow/`other` name-regex).
- **There is no `@kind` annotation convention, no config token-filter field, and no
  ignore-list for `--tw-*`** — config keys are strictly validated and unknown keys are
  rejected. (An earlier note here suggested adding `/* @kind other */` comments to fix
  this — that convention does not exist anywhere in the skill; disregard it.)
- The app scrapes the whole `styles.css` `@import` closure, which **unconditionally**
  includes `_ds_bundle.css` (`emit.mjs`'s `writeStylesCss`). `cfg.tokensPkg`/
  `cfg.tokensGlob` only affect the **README** token inventory (a separate, cosmetic
  list) — they never touch `_ds_bundle.css` or what the app ingests.
  `_ds_bundle.css` ships the compiled Tailwind CSS **verbatim** (only `@font-face
url()`s get rewritten), so whatever custom properties Tailwind emits are in there.
- The `--tw-*` declarations are **functionally required**: e.g.
  `.-translate-x-1\/2 { --tw-translate-x: 50% }` is the payload a composed
  `translate: var(--tw-translate-x) …` reads — stripping it breaks the utility.
  Tailwind only emits a `--tw-*` var when something in the shipped CSS actually
  references it, so every one present is load-bearing (concretely: Dialog/Sheet
  centering and the Spinner animation in these previews depend on this).

**Net: don't chase this on a future re-sync.** The only way to zero the app-side count
would be a custom PostCSS pass that inlines every `var(--tw-*)` and deletes the
declarations from the shipped bundle — Tailwind-version-coupled, fragile, and risks
silently breaking overlay/animation previews, all to clean up a cosmetic counter that
doesn't affect anything a design consumer sees or uses.
