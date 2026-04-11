const API_URL = "https://gopokaji.ru";

let recorderWindowId = null;

// Open recorder window (reused by popup button and hotkey)
async function openRecorderWindow() {
  const { token } = await chrome.storage.local.get(["token"]);
  if (!token) {
    await chrome.tabs.create({ url: `${API_URL}/login` });
    return;
  }

  // Check if recorder already open — just focus it
  const windows = await chrome.windows.getAll({ populate: true });
  for (const win of windows) {
    for (const tab of win.tabs || []) {
      if (tab.url?.includes("recorder/recorder.html")) {
        recorderWindowId = win.id;
        await chrome.windows.update(win.id, { focused: true });
        return;
      }
    }
  }

  const win = await chrome.windows.create({
    url: chrome.runtime.getURL("recorder/recorder.html"),
    type: "popup",
    width: 500,
    height: 520,
  });
  recorderWindowId = win.id;
}

// Clean up when recorder window is closed
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === recorderWindowId) {
    recorderWindowId = null;
    clearTimeout(refocusTimeout);
    chrome.storage.local.remove(["recordingStartedAt"]);
  }
});


// Hotkey: Alt+Shift+P
chrome.commands.onCommand.addListener(async (command) => {
  if (command === "toggle-recording") {
    await openRecorderWindow();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "openRecorder") {
    const open = () => openRecorderWindow().then(() => sendResponse({ success: true }));
    if (message.replyToSlug) {
      chrome.storage.local.set({ replyToSlug: message.replyToSlug }, open);
    } else {
      chrome.storage.local.remove("replyToSlug", open);
    }
    return true;
  }

  if (message.action === "saveToken") {
    chrome.storage.local.set({ token: message.token });
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "chooseDesktopMedia") {
    // Picker must be tied to a tab; use the active tab in the last focused normal window
    chrome.windows.getAll({ populate: true, windowTypes: ["normal"] }, (wins) => {
      let targetTab = null;
      for (const w of wins) {
        if (w.focused) {
          targetTab = (w.tabs || []).find((t) => t.active);
          if (targetTab) break;
        }
      }
      if (!targetTab) {
        for (const w of wins) {
          targetTab = (w.tabs || []).find((t) => t.active);
          if (targetTab) break;
        }
      }
      const sources = ["screen", "window", "tab", "audio"];
      const requestId = chrome.desktopCapture.chooseDesktopMedia(
        sources,
        targetTab,
        (streamId, options) => {
          if (!streamId) {
            sendResponse({ streamId: null, error: "cancelled" });
            return;
          }
          sendResponse({ streamId, canRequestAudioTrack: !!options?.canRequestAudioTrack });
        }
      );
      // If sender closes before callback fires, cancel the picker
      // (no-op if already completed)
    });
    return true;
  }

  return false;
});
