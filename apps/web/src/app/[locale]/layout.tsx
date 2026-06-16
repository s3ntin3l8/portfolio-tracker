import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { NextIntlClientProvider, hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { ThemeProvider } from "@/components/theme-provider";
import { AuthSessionProvider } from "@/components/session-provider";
import "../globals.css";

export const metadata: Metadata = {
  title: "Portfolio Tracker",
  description:
    "Indonesian-first personal portfolio tracker with screenshot import.",
  manifest: "/manifest.webmanifest",
  // iOS: enable standalone "Add to Home Screen". `black-translucent` lets the web
  // content extend under the status bar for an edge-to-edge look (paired with
  // `viewportFit: "cover"` below and the safe-area padding in <AppShell>).
  appleWebApp: {
    capable: true,
    title: "Portfolio",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: "/icon.svg",
    apple: "/icons/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  // Follow the OS scheme so the browser/status-bar chrome matches the rendered
  // background (`--background`: light `#ffffff`, dark `#0a0a0a`). This tracks the
  // system preference, not the in-app theme toggle.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
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
      className={`${GeistSans.variable} ${GeistMono.variable}`}
    >
      <body className="min-h-dvh bg-background font-sans text-foreground antialiased">
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
          <AuthSessionProvider>
            <NextIntlClientProvider>{children}</NextIntlClientProvider>
          </AuthSessionProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
