const APP_URL = "https://gopokaji.ru";

const screens = {
  auth: document.getElementById("auth-screen"),
  main: document.getElementById("main-screen"),
  recording: document.getElementById("recording-screen"),
};

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.add("hidden"));
  screens[name].classList.remove("hidden");
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

let tickInterval = null;

function startTickingTimer(startedAt) {
  function tick() {
    const elapsed = Math.floor((Date.now() - startedAt) / 1000);
    const el = document.getElementById("popup-timer");
    if (el) el.textContent = formatTime(elapsed);
  }
  tick();
  tickInterval = setInterval(tick, 500);
}

// Check state
chrome.storage.local.get(["token", "recordingStartedAt"], (result) => {
  if (!result.token) {
    showScreen("auth");
    return;
  }
  if (result.recordingStartedAt) {
    showScreen("recording");
    startTickingTimer(result.recordingStartedAt);
    return;
  }
  showScreen("main");
});

document.getElementById("btn-login").addEventListener("click", () => {
  chrome.tabs.create({ url: `${APP_URL}/login` });
});

document.getElementById("btn-start").addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "openRecorder" }, () => {
    window.close();
  });
});

document.getElementById("btn-dashboard").addEventListener("click", () => {
  chrome.tabs.create({ url: `${APP_URL}/dashboard` });
});

document.getElementById("btn-open-recorder").addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "openRecorder" }, () => {
    window.close();
  });
});

window.addEventListener("beforeunload", () => {
  if (tickInterval) clearInterval(tickInterval);
});
