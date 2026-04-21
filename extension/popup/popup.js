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

// Load teams for the team selector
async function loadTeams(token) {
  try {
    const resp = await fetch(`${APP_URL}/api/teams`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return;
    const teams = await resp.json();
    if (teams.length > 0) {
      const selector = document.getElementById("team-selector");
      const select = document.getElementById("team-select");
      teams.forEach((team) => {
        const opt = document.createElement("option");
        opt.value = team.slug;
        opt.textContent = team.name;
        select.appendChild(opt);
      });
      selector.classList.remove("hidden");

      // Restore last selection
      chrome.storage.local.get(["selectedTeamSlug"], (r) => {
        if (r.selectedTeamSlug) select.value = r.selectedTeamSlug;
      });

      select.addEventListener("change", () => {
        chrome.storage.local.set({ selectedTeamSlug: select.value });
      });
    }
  } catch {
    // Teams unavailable — skip
  }
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
  loadTeams(result.token);
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
