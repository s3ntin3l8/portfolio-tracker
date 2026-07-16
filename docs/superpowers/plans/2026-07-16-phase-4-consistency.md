# Phase 4 — Deeper Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Standardize 6 remaining consistency gaps across the codebase per #550 Phase 4.

**Architecture:** Each item is independent — different packages, no shared state. One commit per item, single PR.

**Tech Stack:** TypeScript, React, Zod, Drizzle ORM, Fastify

---

### Task 1: Extract `useApiCall` + `useAsyncEffect` hooks

**Files:**

- Create: `apps/web/src/lib/use-api-call.ts`
- Create: `apps/web/src/lib/use-async-effect.ts`
- Modify: ~15 form/action handler sites across web components

**Pattern being extracted:**

Every form handler follows this pattern:

```tsx
const [busy, setBusy] = useState(false);
const [error, setError] = useState<string | null>(null);

async function handleSubmit() {
  setBusy(true);
  setError(null);
  try {
    await doSomething();
  } catch (err) {
    setError(err instanceof Error ? err.message : "Something went wrong");
  } finally {
    setBusy(false);
  }
}
```

- [ ] **Step 1: Create `use-api-call.ts`**

```ts
import { useCallback, useState } from "react";

export interface ApiCallState {
  busy: boolean;
  error: string | null;
}

export function useApiCall<T extends (...args: never[]) => Promise<unknown>>(
  fn: T,
): [
  { busy: boolean; error: string | null },
  (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>> | undefined>,
] {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const call = useCallback(
    async (...args: Parameters<T>): Promise<Awaited<ReturnType<T>> | undefined> => {
      setBusy(true);
      setError(null);
      try {
        return await fn(...args);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong");
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [fn],
  );

  return [{ busy, error }, call];
}
```

- [ ] **Step 2: Create `use-async-effect.ts`**

```ts
import { useEffect } from "react";

export function useAsyncEffect(effect: () => Promise<void>, deps: unknown[]): void {
  useEffect(() => {
    let cancelled = false;
    void effect().catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
```

- [ ] **Step 3: Migrate form handlers**

Replace inline `busy`/`error` state + try/catch in ~15 sites. Each migration follows this pattern:

```tsx
// Before:
const [busy, setBusy] = useState(false);
const [error, setError] = useState<string | null>(null);
async function handleSubmit() {
  setBusy(true);
  setError(null);
  try {
    await api.doSomething();
  } catch {
    setError("failed");
  } finally {
    setBusy(false);
  }
}

// After:
const [{ busy, error }, submit] = useApiCall(async () => {
  await api.doSomething();
});
```

Sites to migrate (search for `setBusy` + `setError` pattern in `apps/web/src/components/`):

- All form submit handlers matching the pattern
- Migrate only the most obvious cases — if the error handling is custom (e.g. per-field errors), skip it

- [ ] **Step 4: Run tests and type-check**

```
npm run typecheck --workspace @portfolio/web && npm test --workspace @portfolio/web
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/use-api-call.ts apps/web/src/lib/use-async-effect.ts
git commit -m "feat: add useApiCall + useAsyncEffect hooks, migrate form handlers"
```

---

### Task 2: Input/Patch schema composition (packages/schema)

**Files:**

- Modify: `packages/schema/src/index.ts` or related schema files

**Pattern being extracted:**

Schemas like `accountHolderInputSchema` and `accountHolderPatchSchema` duplicate every field:

- Input: `.default()` with required fields
- Patch: `.optional()` with same fields

**Approach:** Use a shared base schema + `.partial()` for patches.

- [ ] **Step 1: Find all Input/Patch schema pairs**

Search for `Schema` and `PatchSchema` export pairs in `packages/schema/src/`.

- [ ] **Step 2: Create composable pattern**

For each pair, define the fields once as a base object, then compose:

```ts
const accountHolderFields = {
  name: z.string().min(1),
  type: z.enum(["self", "child", "other"]),
  birthYear: z.number().int().optional(),
  // ...
};

export const accountHolderInputSchema = z.object(accountHolderFields);
export const accountHolderPatchSchema = z.object(
  Object.fromEntries(Object.entries(accountHolderFields).map(([k, v]) => [k, v.optional()])),
);
```

Or simpler where possible — use `.partial()`:

```ts
export const accountHolderBaseSchema = z.object({ ... });
export const accountHolderInputSchema = accountHolderBaseSchema;
export const accountHolderPatchSchema = accountHolderBaseSchema.partial();
```

Apply to: `accountHolder`, `portfolio`, `providerSettings`/`providerCredential`, and any other input/patch pairs.

- [ ] **Step 3: Type-check and test**

```
npm run typecheck --workspace @portfolio/schema && npm test
```

- [ ] **Step 4: Commit**

```bash
git add packages/schema/
git commit -m "refactor: compose Input/Patch schemas from shared base"
```

---

### Task 3: Transaction type predicates in `packages/core/src/categorization.ts`

**Files:**

- Create: `packages/core/src/categorization.ts`
- Modify: `packages/core/src/index.ts` — add re-exports
- Modify: 6+ consumer files that currently re-derive these predicates

**Pattern being extracted:**

Files like `cash.ts`, `holdings.ts`, `contributions.ts`, `pytr/mapper.ts`, `tr-csv.ts`, `tax.ts` each independently define:

```ts
const INCOME_TYPES = ["dividend", "coupon", "interest", "bonus_cash"];
function isIncomeType(type: string) {
  return INCOME_TYPES.includes(type);
}
function isTradeType(type: string) {
  return ["buy", "sell"].includes(type);
}
```

- [ ] **Step 1: Identify all predicate re-definitions**

Search for `isTradeType`, `isIncomeType`, `isCashFlowType`, `isTaxExempt`, and similar inline arrays across the codebase. List every location.

- [ ] **Step 2: Create `categorization.ts`**

```ts
/** Transaction types that represent share/unit acquisitions (contribute to holdings). */
const ACQUISITION_TYPES = ["buy", "savings_plan"] as const;
/** Transaction types that represent disposals. */
const DISPOSAL_TYPES = ["sell"] as const;
/** Income events — dividends, coupons, interest, cash bonuses. */
const INCOME_TYPES = ["dividend", "coupon", "interest", "bonus_cash"] as const;
/** Pure cash movements — deposits, withdrawals, fees, tax debits. */
const CASH_FLOW_TYPES = ["deposit", "withdrawal", "fee", "tax", "adjustment"] as const;
/** Cash-neutral share-receipt events (corporate actions). */
const SHARE_RECEIPT_TYPES = ["bonus", "split", "rights"] as const;
/** Depot-to-depot transfer types. */
const TRANSFER_TYPES = ["transfer_in", "transfer_out"] as const;

export function isTradeType(type: string): boolean {
  return [...ACQUISITION_TYPES, ...DISPOSAL_TYPES].includes(type as any);
}

export function isAcquisitionType(type: string): boolean {
  return (ACQUISITION_TYPES as readonly string[]).includes(type);
}

export function isDisposalType(type: string): boolean {
  return (DISPOSAL_TYPES as readonly string[]).includes(type);
}

export function isIncomeType(type: string): boolean {
  return (INCOME_TYPES as readonly string[]).includes(type);
}

export function isCashFlowType(type: string): boolean {
  return (CASH_FLOW_TYPES as readonly string[]).includes(type);
}

export function isShareReceiptType(type: string): boolean {
  return (SHARE_RECEIPT_TYPES as readonly string[]).includes(type);
}

export function isTransferType(type: string): boolean {
  return (TRANSFER_TYPES as readonly string[]).includes(type);
}
```

- [ ] **Step 3: Migrate all 6+ consumer sites**

Replace inline definitions with `import { isIncomeType, isTradeType } from "@portfolio/core"`.

- [ ] **Step 4: Type-check and test**

```
npm run typecheck && npm test
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/categorization.ts
git commit -m "refactor: consolidate transaction type predicates into categorization.ts"
```

---

### Task 4: `tryAddDraft()` parser validation helper

**Files:**

- Create or modify: `services/api/src/services/parsers/shared.ts`
- Modify: 5+ parser files (screenshot, CSV, PDF, pytr/mapper, etc.)

**Pattern being extracted:**

Every parser repeats:

```ts
const parsed = schema.safeParse(row);
if (parsed.success) {
  drafts.push(parsed.data);
} else {
  errors.push({ row, issues: parsed.error.issues });
}
```

- [ ] **Step 1: Read existing parsers**

Check `services/api/src/services/parsers/` for the pattern in each parser file. Identify the exact schema types and error shapes used.

- [ ] **Step 2: Add `tryAddDraft` to `shared.ts`**

```ts
import type { ZodSchema, ZodError } from "zod";

export interface ParseError {
  row: Record<string, unknown>;
  issues: { path: string; message: string }[];
}

export function tryAddDraft<T>(
  schema: ZodSchema<T>,
  row: Record<string, unknown>,
  drafts: T[],
  errors: ParseError[],
): void {
  const parsed = schema.safeParse(row);
  if (parsed.success) {
    drafts.push(parsed.data);
  } else {
    errors.push({
      row,
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
}
```

- [ ] **Step 3: Migrate all parser sites**

Replace inline `safeParse` blocks with `tryAddDraft(schema, row, drafts, errors)`.

- [ ] **Step 4: Type-check and test**

```
npm run typecheck --workspace @portfolio/api && npm test --workspace @portfolio/api
```

- [ ] **Step 5: Commit**

```bash
git add services/api/src/services/parsers/
git commit -m "refactor: extract tryAddDraft parser validation helper"
```

---

### Task 5: Standardize dialog patterns (controlled open/onOpenChange)

**Files:**

- Modify: All dialog components in `apps/web/src/components/`

**Goal:** Every dialog uses the controlled `open`/`onOpenChange` pattern. Replace `DeleteHolderDialog` and `DeletePortfolioDialog` (which are ~80% identical) with a generic `ConfirmActionDialog`.

- [ ] **Step 1: Create `ConfirmActionDialog`**

```tsx
// apps/web/src/components/ui/confirm-action-dialog.tsx
"use client";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

interface ConfirmActionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  variant?: "destructive" | "default";
  busy?: boolean;
  onConfirm: () => void;
}

export function ConfirmActionDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  variant = "destructive",
  busy,
  onConfirm,
}: ConfirmActionDialogProps) {
  const t = useTranslations("Common");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button variant={variant} onClick={onConfirm} disabled={busy}>
            {busy && <Spinner className="mr-2" />}
            {confirmLabel ?? t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Replace `DeleteHolderDialog` and `DeletePortfolioDialog`**

Both are nearly identical — swap their internals for `ConfirmActionDialog`. Keep the wrapper component for backward compat but have it render `ConfirmActionDialog`.

- [ ] **Step 3: Audit all other dialogs**

Check every `<Dialog>` in the web app. Ensure they use controlled `open`/`onOpenChange` (not internal `useState` inside the dialog). Migrate any that don't.

- [ ] **Step 4: Type-check and test**

```
npm run typecheck --workspace @portfolio/web && npm test --workspace @portfolio/web
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ui/confirm-action-dialog.tsx
git commit -m "refactor: add ConfirmActionDialog, standardize dialog patterns"
```

---

### Task 6: Extract Eyebrow/ToggleRow inline components

**Files:**

- Create: `apps/web/src/components/ui/eyebrow.tsx`
- Create: `apps/web/src/components/ui/toggle-row.tsx`
- Modify: Files that currently define these inline

**Pattern being extracted:**

Search the web components for repeated patterns:

- `Eyebrow`: A small uppercase label/heading that appears above sections
- `ToggleRow`: A row with a label and a toggle switch

- [ ] **Step 1: Find all inline `Eyebrow` and `ToggleRow` definitions**

Search for these patterns:

- `<span className="text-xs uppercase tracking-wider text-muted-foreground">` (Eyebrow)
- `<div className="flex items-center justify-between"><span>...` + `<Switch />` (ToggleRow)

- [ ] **Step 2: Create extracted components**

```tsx
// apps/web/src/components/ui/eyebrow.tsx
import { cn } from "@/lib/utils";

export function Eyebrow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("text-xs uppercase tracking-wider text-muted-foreground", className)}>
      {children}
    </span>
  );
}
```

```tsx
// apps/web/src/components/ui/toggle-row.tsx
"use client";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export function ToggleRow({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <Label>{label}</Label>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}
```

- [ ] **Step 3: Replace all inline usages**

Swap each inline occurrence with `<Eyebrow>` / `<ToggleRow>`.

- [ ] **Step 4: Type-check and test**

```
npm run typecheck --workspace @portfolio/web && npm test --workspace @portfolio/web
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/ui/eyebrow.tsx apps/web/src/components/ui/toggle-row.tsx
git commit -m "refactor: extract Eyebrow and ToggleRow inline components"
```

---

### Final: Create PR

- [ ] **Create PR from `refactor/phase-4-consistency` → `main`**

```bash
git push origin refactor/phase-4-consistency
gh pr create --title "refactor: Phase 4 consistency — hooks, schemas, predicates, dialogs" --body "Standardizes 6 consistency gaps per #550 Phase 4.

### Changes
- **useApiCall + useAsyncEffect hooks** — eliminates inline busy/error boilerplate in 15+ form handlers
- **Input/Patch schema composition** — share base fields, use .partial() for patches
- **Transaction type predicates** — consolidate 6+ re-definitions into categorization.ts
- **tryAddDraft parser helper** — extracts safeParse pattern from 5 parsers
- **ConfirmActionDialog** — generic replacement for DeleteHolderDialog/DeletePortfolioDialog
- **Eyebrow/ToggleRow** — extract inline UI patterns to shared components

### Verification
- [ ] TypeScript passes across all workspaces
- [ ] All tests pass"
```
