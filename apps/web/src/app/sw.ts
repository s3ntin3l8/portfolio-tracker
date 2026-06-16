import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { Serwist } from "serwist";

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

// Cache + key the Web Share Target stashes a shared screenshot under. The import page
// (`?shared=1`) reads it back out, then deletes it. See `share_target` in the manifest.
export const SHARE_CACHE = "share-target";
export const SHARE_KEY = "/shared-image";

// Web Share Target: Android delivers a shared image as a multipart POST to
// `/share-target` (no server route can receive it in a static/SSR app, so the SW does).
// Stash the file in the Cache and redirect to the import flow, which picks it up.
self.addEventListener("fetch", (event: FetchEvent) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "POST" || url.pathname !== "/share-target") return;

  event.respondWith(
    (async () => {
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
          return Response.redirect("/import?shared=1", 303);
        }
      } catch {
        // Fall through to a plain redirect so the user still lands on the import page.
      }
      return Response.redirect("/import", 303);
    })(),
  );
});

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: defaultCache,
  // Serve the precached offline page when a navigation can't be fulfilled (the user is
  // offline and the route wasn't already cached). Visited routes still work from cache.
  // Routes are localized under /[locale]; precache the default-locale offline page.
  fallbacks: {
    entries: [
      {
        url: "/en/offline",
        matcher: ({ request }) => request.destination === "document",
      },
    ],
  },
});

serwist.addEventListeners();
