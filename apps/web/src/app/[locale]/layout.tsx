import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import { Plus_Jakarta_Sans, DM_Mono } from "next/font/google";
import { NextIntlClientProvider, hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeColorSync, STORAGE_KEY } from "@/components/theme-color-sync";
import { IosSplashLinks } from "@/components/ios-splash-links";
import { AuthSessionProvider } from "@/components/session-provider";
import "../globals.css";

// Pocket type system: Plus Jakarta Sans for UI, DM Mono for figures/codes.
const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-jakarta",
  display: "swap",
});
const dmMono = DM_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-dm-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Pocket",
  description:
    "Every asset, one clear number — stocks, funds, gold and cash across every brokerage in a single figure.",
  manifest: "/manifest.webmanifest",
  // iOS: enable standalone "Add to Home Screen". `black-translucent` lets the web
  // content extend under the status bar for an edge-to-edge look (paired with
  // `viewportFit: "cover"` below and the safe-area padding in <AppShell>).
  appleWebApp: {
    capable: true,
    title: "Pocket",
    statusBarStyle: "black-translucent",
  },
  other: {
    // Next 15+ only emits the unprefixed `mobile-web-app-capable` from `appleWebApp`
    // (vercel/next.js#70272) — but iOS Safari itself still only honors the classic
    // Apple-prefixed tag to actually launch a home-screen icon in standalone display
    // mode (no browser chrome) and to show the splash screen (vercel/next.js#74248,
    // #74524). Without this, "Add to Home Screen" silently opens as a plain Safari
    // tab and `display-mode: standalone` never matches. Emit both.
    "apple-mobile-web-app-capable": "yes",
  },
  icons: {
    icon: "/icon.svg",
    apple: "/icons/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  // SSR/pre-hydration default, following the OS scheme so the browser/status-bar chrome
  // matches the rendered background (`--background`: light `#f4f7f5`, dark `#0e1512`)
  // before the in-app theme is known. Once mounted, `<ThemeColorSync>` overwrites this
  // tag's content to track the actual applied theme (which can differ from the OS scheme
  // via the in-app toggle).
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f7f5" },
    { media: "(prefers-color-scheme: dark)", color: "#0e1512" },
  ],
  // Draw into the display cutout / safe areas; insets are reclaimed in the shell.
  viewportFit: "cover",
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);

  return (
    <html
      lang={locale}
      suppressHydrationWarning
      className={`${jakarta.variable} ${dmMono.variable}`}
    >
      {/* React 19 hoists these <link> tags into <head> regardless of position. */}
      <IosSplashLinks />
      {/* `min-h-app-viewport` (globals.css), not `min-h-dvh`: that was its own
          independent `100dvh` utility, completely bypassing (not inheriting)
          `<html>`'s standalone-mode viewport-height fix — a percentage `min-height`
          would have the same problem, since it only resolves against a parent whose
          OWN `height` is non-auto, and `<html>`'s `min-height`-only alternative
          wouldn't count either. Applying the exact same cascade directly here
          sidesteps that entirely (#472). */}
      <body className="min-h-app-viewport bg-background font-sans text-foreground antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          storageKey={STORAGE_KEY}
        >
          <ThemeColorSync />
          <AuthSessionProvider>
            <NextIntlClientProvider>{children}</NextIntlClientProvider>
          </AuthSessionProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
