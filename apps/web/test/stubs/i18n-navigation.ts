import * as React from "react";

// Minimal stub for @/i18n/navigation in jsdom tests.
// The real module calls next-intl/navigation → next/navigation which fails in Vitest.
export const Link = React.forwardRef<
  HTMLAnchorElement,
  React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }
>(function Link({ href, children, ...props }, ref) {
  return React.createElement("a", { href, ref, ...props }, children);
});

export const redirect = (_url: string) => {};
export const usePathname = () => "/";
export const useRouter = () => ({ push: () => {}, replace: () => {}, back: () => {} });
export const getPathname = () => "/";
