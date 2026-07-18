"use client";

import { useLayoutEffect, useRef } from "react";
import { Input } from "@/components/ui/input";
import { caretForDigits, digitsBefore, formatGrouped, sanitizeNumericInput } from "./number-format";

interface NumberFieldProps extends Omit<
  React.ComponentProps<typeof Input>,
  "value" | "onChange" | "type"
> {
  /** Raw, comma-free value (what's stored in form state / submitted). */
  value: string;
  onValueChange: (raw: string) => void;
}

/** `Input` with live thousands-grouping (quantity/price/fees/tax) — see `number-format.ts`.
 *  Preserves caret position across reformatting so typing into the middle of a long number
 *  doesn't jump the cursor to the end. */
export function NumberField({ value, onValueChange, ...props }: NumberFieldProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pendingCaret = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (pendingCaret.current != null && inputRef.current) {
      inputRef.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  });

  return (
    <Input
      {...props}
      ref={inputRef}
      inputMode="decimal"
      value={formatGrouped(value)}
      onChange={(e) => {
        const el = e.target;
        const caret = el.selectionStart ?? el.value.length;
        const digits = digitsBefore(el.value, caret);
        const raw = sanitizeNumericInput(el.value);
        pendingCaret.current = caretForDigits(formatGrouped(raw), digits);
        onValueChange(raw);
      }}
    />
  );
}
