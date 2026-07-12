import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { NetworkOnly, Serwist } from "serwist";
import { resolveLocalePrefix } from "./sw-locale";

// `__SW_MANIFEST` is injected by @serwist/next at build time (the app-shell precache
// list). Financial data is NOT cached here: `defaultCache` only matches same-origin
// Next assets/navigations, and the Fastify API is a different origin, so API reads
// always hit the network (fresh online, "unavailable" card offline).
declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

// Cache + key the Web Share Target stashes a shared screenshot under. The transactions
// page (`?shared=1`) reads it back out, then deletes it. See `share_target` in the manifest.
export const SHARE_CACHE = "share-target";
export const SHARE_KEY = "/shared-image";

// Web Share Target: Android delivers a shared image as a multipart POST to
// `/share-target` (no server route can receive it in a static/SSR app, so the SW does).
// Stash the file in the Cache and redirect to /transactions, where the Add-transaction
// menu auto-opens the import sheet and picks it up.
self.addEventListener("fetch", (event: FetchEvent) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "POST" || url.pathname !== "/share-target") return;

  event.respondWith(
    (async () => {
      // Read the active locale from the NEXT_LOCALE cookie (set by next-intl's middleware).
      // The share-target POST comes from the OS, so the cookie should be present on the
      // request.
      const cookieHeader = event.request.headers.get("cookie") ?? "";
      const localePrefix = resolveLocalePrefix(cookieHeader);

      try {
        const form = await event.request.formData();
        const image = form.get("image");
        if (image instanceof Blob && image.size > 0) {
          const cache = await caches.open(SHARE_CACHE);
          await cache.put(
            SHARE_KEY,
            new Response(image, {
              headers: { "content-type": image.type || "image/png" },
            }),
          );
          return Response.redirect(`${localePrefix}/transactions?shared=1`, 303);
        }
      } catch {
        // Fall through to a plain redirect so the user still lands on the transactions page.
      }
      return Response.redirect(`${localePrefix}/transactions`, 303);
    })(),
  );
});

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  // A new SW parks in "waiting" instead of activating immediately, so PwaUpdater can
  // detect it and prompt the user to reload rather than swapping the app out from under
  // them silently. It only activates once `messageSkipWaiting()` is sent (from the
  // toast's "Reload" action) — Serwist's `addEventListeners()` below wires up the
  // `SKIP_WAITING` message listener that triggers `self.skipWaiting()`.
  skipWaiting: false,
  clientsClaim: true,
  navigationPreload: true,
  // Auth + API routes must never be cached, preloaded, or replayed by the SW: the OAuth
  // callback carries a single-use `code`, and `defaultCache`'s catch-all treats it as a
  // same-origin document navigation — a replayed/cached hit consumes the code twice and
  // the exchange fails with `invalid_grant`. Force everything under /api straight to the
  // network. Ordered before defaultCache so this rule wins.
  runtimeCaching: [
    {
      matcher: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith("/api"),
      handler: new NetworkOnly(),
    },
    ...defaultCache,
  ],
  // Serve the precached offline page when a navigation can't be fulfilled (the user is
  // offline and the route wasn't already cached). Visited routes still work from cache.
  // Routes are localized under /[locale]; precache the default-locale offline page.
  fallbacks: {
    entries: [
      {
        url: "/en/offline",
        matcher: ({ request }) =>
          request.destination === "document" &&
          !new URL(request.url).pathname.startsWith("/api"),
      },
    ],
  },
});

serwist.addEventListeners();
