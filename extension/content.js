// Content script — runs ONLY on gopokaji.ru (see manifest `matches`).
//
// Three jobs:
//   1. Expose a DOM attribute so the website can detect the extension is installed.
//   2. Bridge `postMessage` events from the Pokaji site into the extension's
//      background worker (e.g. «Записать ответ» button on a video page).
//   3. Sync the JWT token from the site's localStorage into extension storage,
//      so the extension picks up logins transparently.
//
// The camera overlay that used to live here was superseded by canvas-based
// compositing in recorder.js (see worker compositor), and removed together with
// the `<all_urls>` content-script match.

// 1) Presence signal — set as DOM attribute because `window` is isolated from the page.
document.documentElement.setAttribute("data-pokaji-ext", "1");
document.dispatchEvent(new CustomEvent("pokaji-extension-ready"));

// 2) Bridge: page JS → background (open recorder with optional reply target).
const POKAJI_ORIGINS = ["https://gopokaji.ru", "https://www.gopokaji.ru"];
window.addEventListener("message", (event) => {
  if (event.source !== window || !event.data) return;
  if (!POKAJI_ORIGINS.includes(event.origin)) return;
  if (event.data.type === "pokaji-open-recorder") {
    const replyToSlug = event.data.replyToSlug || null;
    chrome.runtime.sendMessage({ action: "openRecorder", replyToSlug });
  }
});

// 3) Token sync — runs every 2s while on the Pokaji site so a login (possibly
// in a different tab that wrote to localStorage) propagates into the extension
// without requiring a manual refresh.
const syncToken = () => {
  const token = localStorage.getItem("token");
  if (token) {
    chrome.runtime.sendMessage({ action: "saveToken", token });
  }
};

syncToken();
window.addEventListener("storage", syncToken);
setInterval(syncToken, 2000);
