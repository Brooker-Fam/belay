// Belay parent pages: small conveniences only. Everything works without this file.
"use strict";
document.addEventListener("submit", (event) => {
  const form = event.target;
  const message = form instanceof HTMLFormElement ? form.dataset.confirm : undefined;
  if (message && !window.confirm(message)) event.preventDefault();
});
for (const field of document.querySelectorAll("input[data-browser-timezone]")) {
  if (!field.value || field.value === "UTC") {
    try {
      field.value = Intl.DateTimeFormat().resolvedOptions().timeZone || field.value;
    } catch {
      // Leave the server's guess.
    }
  }
}
for (const button of document.querySelectorAll("button[data-copy]")) {
  button.hidden = false;
  button.addEventListener("click", () => {
    const target = document.getElementById(button.dataset.copy || "");
    if (target && navigator.clipboard) {
      navigator.clipboard.writeText(target.textContent || "").then(() => {
        button.textContent = "Copied";
      });
    }
  });
}
// On a phone the menu and a phone's tabs are rows that scroll sideways: start each at the current page.
for (const link of document.querySelectorAll('header.top nav [aria-current="page"], nav.tabs [aria-current="page"]')) {
  const strip = link.parentElement;
  if (strip && strip.scrollWidth > strip.clientWidth) strip.scrollLeft = link.offsetLeft - (strip.clientWidth - link.offsetWidth) / 2;
}
for (const box of document.querySelectorAll("input[data-select-all]")) {
  box.addEventListener("change", () => {
    for (const other of document.querySelectorAll(`input[name="${box.dataset.selectAll}"]`)) other.checked = box.checked;
  });
}

// Settings → Notifications: subscribes this browser to Web Push with the server's public key,
// then posts the subscription with the page's form (and its CSRF token).
function fromBase64Url(text) {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

async function setUpNotifications(onForm) {
  const offForm = document.getElementById("push-off");
  const onButton = onForm.querySelector("button");
  const offButton = offForm && offForm.querySelector("button");
  const status = document.querySelector("[data-push-status]");
  const say = (text) => {
    if (status) status.textContent = text;
  };
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    const help = document.querySelector("[data-push-unsupported]");
    if (help) help.hidden = false;
    return;
  }
  const registration = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const current = await registration.pushManager.getSubscription();
  onButton.hidden = false;
  if (current && offButton) {
    offButton.hidden = false;
    say("Notifications are on for this browser.");
  }
  onButton.addEventListener("click", async () => {
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        say("This browser blocks notifications from Belay. Allow them in its settings, then try again.");
        return;
      }
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(onForm.dataset.vapidKey || "") });
      const json = subscription.toJSON();
      onForm.elements.namedItem("endpoint").value = json.endpoint || "";
      onForm.elements.namedItem("p256dh").value = (json.keys && json.keys.p256dh) || "";
      onForm.elements.namedItem("auth").value = (json.keys && json.keys.auth) || "";
      onForm.submit();
    } catch {
      say("This browser couldn't turn on notifications.");
    }
  });
  if (offButton) {
    offButton.addEventListener("click", async () => {
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        offForm.elements.namedItem("endpoint").value = subscription.endpoint;
        await subscription.unsubscribe();
      }
      offForm.submit();
    });
  }
}

const pushForm = document.getElementById("push-on");
if (pushForm) {
  setUpNotifications(pushForm).catch(() => {
    const status = document.querySelector("[data-push-status]");
    if (status) status.textContent = "This browser couldn't set up notifications.";
  });
}
