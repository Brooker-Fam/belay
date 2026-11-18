// Belay's service worker: shows the notices the server pushes to this browser, and opens the
// parent page a notice is about when it's tapped. It caches nothing and fetches nothing.
"use strict";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/** Only paths on this site, like "/requests". */
function pagePath(value) {
  return typeof value === "string" && /^\/(?![/\\])[^\s]*$/.test(value) ? value : "/requests";
}

self.addEventListener("push", (event) => {
  let notice = {};
  try {
    notice = event.data ? event.data.json() : {};
  } catch {
    notice = {};
  }
  const title = typeof notice.title === "string" ? notice.title : "Belay";
  const body = typeof notice.body === "string" ? notice.body : "Something is waiting for you.";
  const path = pagePath(notice.url);
  // An urgent notice (the kid's "I need help") stays on the screen until the parent acts on it.
  const requireInteraction = notice.urgent === true;
  // Browsers require a visible notification for every push; one per page, replaced by the newest
  // (a request's own card, "/requests#request-…", is still the Requests page; "#help" stays apart).
  const tag = path.replace(/#request-[\w-]+$/, "");
  event.waitUntil(self.registration.showNotification(title, { body, tag, renotify: true, requireInteraction, data: { path } }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(pagePath(event.notification.data && event.notification.data.path), self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin && "navigate" in client) {
          await client.focus();
          await client.navigate(url);
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
