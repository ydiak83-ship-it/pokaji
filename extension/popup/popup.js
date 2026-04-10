const API_URL = "http://localhost:8000";
const APP_URL = "http://localhost:3000";

const screens = {
  auth: document.getElementById("auth-screen"),
  record: document.getElementById("record-screen"),
  recording: document.getElementById("recording-screen"),
  uploading: document.getElementById("uploading-screen"),
  done: document.getElementById("done-screen"),
};

let timerInterval = null;
let seconds = 0;

function showScreen(name) {
  Object.values(screens).forEach((s) => s.classList.add("hidden"));
  screens[name].classList.remove("hidden");
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function startTimer() {
  seconds = 0;
  document.getElementById("timer").textContent = "00:00";
  timerInterval = setInterval(() => {
    seconds++;
    document.getElementById("timer").textContent = formatTime(seconds);
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
}

// Check auth on load
chrome.storage.local.get(["token"], (result) => {
  if (result.token) {
    showScreen("record");
  } else {
    showScreen("auth");
  }
});

// Login button — open web app login page
document.getElementById("btn-login").addEventListener("click", () => {
  chrome.tabs.create({ url: `${APP_URL}/login?extension=true` });
});

// Record buttons
document.querySelectorAll(".option-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const mode = btn.dataset.mode;
    chrome.runtime.sendMessage({ action: "startRecording", mode }, (response) => {
      if (response?.success) {
        showScreen("recording");
        startTimer();
      }
    });
  });
});

// Pause
document.getElementById("btn-pause").addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "togglePause" }, (response) => {
    const btn = document.getElementById("btn-pause");
    btn.textContent = response?.paused ? "Продолжить" : "Пауза";
  });
});

// Stop
document.getElementById("btn-stop").addEventListener("click", () => {
  stopTimer();
  showScreen("uploading");
  chrome.runtime.sendMessage({ action: "stopRecording" }, (response) => {
    if (response?.slug) {
      const link = `${APP_URL}/v/${response.slug}`;
      document.getElementById("video-link").value = link;
      showScreen("done");
    }
  });
});

// Copy link
document.getElementById("btn-copy").addEventListener("click", () => {
  const input = document.getElementById("video-link");
  navigator.clipboard.writeText(input.value);
  const btn = document.getElementById("btn-copy");
  btn.textContent = "Скопировано!";
  setTimeout(() => {
    btn.textContent = "Копировать";
  }, 2000);
});

// New recording
document.getElementById("btn-new").addEventListener("click", () => {
  showScreen("record");
});
