---
name: pocket-review-invariants
description: >-
  Pocket (portfolio-tracker)-specific domain invariants for reviewing a PR in this
  repo, expressed as concrete code-shape red flags rather than prose to re-read —
  use this alongside the generic autonomous-pr-review skill (the ai-agent-skills
  plugin) whenever reviewing a PR here, including autonomous @claude-mention CI
  reviews and manual /review or /code-review passes. Covers: cash-boundary
  consistency, money-as-decimal, transaction source-of-truth, transfer_in/out
  semantics, the two-level FSA allocation, import dedup/draft rules, ESM/config
  conventions, and auth scoping. Consult this before writing review findings on a
  Pocket PR, not after.
---

# Pocket domain red flags

These come from this repo's CLAUDE.md, but restated as things to *grep for or notice
in a diff* rather than prose to re-read — the invariant is already documented there;
this is the checklist for spotting violations in code. This skill is a companion to
the generic `autonomous-pr-review` skill (installed via the `ai-agent-skills` plugin
marketplace), which covers verification discipline, PR-description hygiene, restraint,
and posting discipline — none of that is repeated here.

- **Cash boundary consistency.** Any diff touching contribution, net-worth, or
  `cashCounted` logic (`packages/core/src/contributions.ts`, `boundaryFlows`,
  `summarizePortfolio`): confirm the numerator (value) and denominator (contribution)
  use the *same* boundary. A change that reads net worth including cash but computes
  contribution from purchases only (or vice versa) manufactures phantom gains — this
  is the single most common way this codebase produces silently wrong numbers.
- **Money is never a float.** Any new/changed money field should be Postgres
  `numeric`/decimal end-to-end, with an explicit currency alongside it. A JS `number`
  holding an amount, or a currency-less amount field, is a bug here even if the tests
  pass.
- **Transactions are the only source of truth.** Holdings, P&L, cash balance, XIRR,
  net worth must be *derived* in `packages/core`, never written as stored primary
  state. A diff that persists a computed balance/position as a column to "cache" it is
  a red flag — ask whether it can be derived on read instead, and if not, why not.
- **`transfer_in`/`transfer_out` semantics.** `transfer_out` must carry no P&L (not a
  disposal); `transfer_in` lands at carried cost basis inside a boundary, avg cost
  outside it. A diff computing gain/loss on a transfer, or using current market price
  instead of carried cost, is wrong.
- **Freistellungsauftrag (FSA) has two levels — don't conflate them.**
  `accountHolders.taxAllowanceAnnual` is the legal per-person cap;
  `portfolios.taxAllowanceAnnual` is the per-depot allocation of that cap. A diff that
  reads/writes one when it means the other silently breaks tax netting.
  `userPreferences.taxRegime` / `costBasisMode` are separate global switches — changing
  either changes which core tax module and cost-basis convention every portfolio uses;
  a diff should not assume DE-style realization tax logic applies unconditionally.
- **Imports never auto-commit.** A parse/import path (screenshot, CSV, PDF, broker
  sync) must produce a draft the user confirms, never a committed transaction
  directly. Check that new import paths go through the existing draft/confirm flow and
  the three dedup levels (file contentHash, `(portfolioId, source, externalId)`,
  cross-source economic fingerprint) rather than introducing a fourth, inconsistent
  one.
- **ESM specifiers and config.** `.ts` files importing `.ts` siblings must use `.js`
  specifiers (NodeNext resolution) — a missing `.js` extension is a real runtime break
  here, not a style nit. Config reads should go through `app.config`
  (`services/api/src/plugins/env.ts`), not `process.env` directly.
- **Auth scoping.** Every route handler should scope its query to `request.user` (via
  `app.authenticate`) — a new route that queries by an id from the request body/params
  without also filtering on the authenticated user is a cross-account data leak, not a
  minor issue.
- **Migration hygiene.** A `services/api/src/db/schema.ts` change needs a matching
  migration file committed alongside it (`npm run db:generate`) — a schema edit
  without one is a common miss.
- **PR-description hygiene.** This repo's convention is that PR descriptions and
  commit messages stay generic: no personal or account-holder names, no depot/account
  numbers or exact balances. Check the title/body themselves, not just the diff.
