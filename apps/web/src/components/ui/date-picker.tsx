"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { Calendar, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

type DatePickerProps = Omit<
  React.ComponentProps<"input">,
  "type" | "value" | "onChange" | "aria-label"
> & {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  /** Field label, announced as the button's accessible name prefix (e.g. "Ex-date, Feb 3, 2026"). */
  label?: string;
};

/**
 * App-styled date picker. Renders a button trigger that opens the OS's native
 * <input type="date"> picker via showPicker() (Chrome/Edge/Safari 16+), falling
 * back to focus() for older browsers. The hidden input is the real form field,
 * so existing getByLabelText + fireEvent.change tests keep working unchanged.
 */
export const DatePicker = React.forwardRef<HTMLInputElement, DatePickerProps>(
  function DatePicker(
    { value, onChange, className, id, disabled, label, ...rest },
    ref,
  ) {
    const t = useTranslations("Common");
    const locale = useLocale();
    const inputRef = React.useRef<HTMLInputElement | null>(null);
    const setRefs = React.useCallback(
      (node: HTMLInputElement | null) => {
        inputRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      },
      [ref],
    );

    const formatted = React.useMemo(() => {
      if (!value) return null;
      const d = new Date(`${value}T00:00:00`);
      if (Number.isNaN(d.getTime())) return null;
      return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(d);
    }, [value, locale]);

    const open = React.useCallback(() => {
      const el = inputRef.current;
      if (!el) return;
      if (typeof el.showPicker === "function") {
        el.showPicker();
      } else {
        el.focus();
      }
    }, []);

    // The button is the sole tabbable element; its accessible name carries the
    // field label (when provided) followed by the current value or placeholder,
    // so screen-reader users hear the field name — not just the date.
    const buttonAriaLabel =
      label && formatted ? `${label}, ${formatted}`
      : label ? label
      : formatted ?? t("pickDate");

    return (
      <div className="relative">
        <button
          type="button"
          aria-label={buttonAriaLabel}
          disabled={disabled}
          onClick={open}
          className={cn(
            // text-base (16px) on mobile avoids iOS/Android zoom-on-focus; text-sm from sm: up.
            "flex w-full items-center justify-between gap-2 rounded-[13px] border border-border bg-card px-3.5 py-[13px] text-base font-medium transition-colors focus-visible:outline-none focus-visible:border-primary disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm",
            !formatted && "text-text-3",
            className,
          )}
        >
          <span className="flex min-w-0 items-center gap-2 truncate">
            <Calendar
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <span className="truncate">{formatted ?? t("pickDate")}</span>
          </span>
          <ChevronDown
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden
          />
        </button>
        {/* Real form field, intentionally out of the tab order but kept in the
            a11y tree so a caller's <label htmlFor=id> (or implicit label
            association) still announces the field name if this input is
            focused programmatically (e.g. via the showPicker fallback). */}
        <input
          ref={setRefs}
          id={id}
          type="date"
          value={value}
          onChange={onChange}
          disabled={disabled}
          tabIndex={-1}
          className="sr-only"
          {...rest}
        />
      </div>
    );
  },
);
