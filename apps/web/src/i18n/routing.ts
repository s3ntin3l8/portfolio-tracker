import { defineRouting } from "next-intl/routing";

// Bilingual from day one: English + Indonesian.
export const routing = defineRouting({
  locales: ["en", "id"],
  defaultLocale: "en",
});

export type Locale = (typeof routing.locales)[number];
