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
for (const box of document.querySelectorAll("input[data-select-all]")) {
  box.addEventListener("change", () => {
    for (const other of document.querySelectorAll(`input[name="${box.dataset.selectAll}"]`)) other.checked = box.checked;
  });
}
