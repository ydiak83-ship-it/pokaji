const API_URL = "http://localhost:8000";

let mediaRecorder = null;
let recordedChunks = [];
let isPaused = false;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "startRecording") {
    startRecording(message.mode).then((success) => sendResponse({ success }));
    return true;
  }

  if (message.action === "togglePause") {
    if (mediaRecorder) {
      if (isPaused) {
        mediaRecorder.resume();
        isPaused = false;
      } else {
        mediaRecorder.pause();
        isPaused = true;
      }
    }
    sendResponse({ paused: isPaused });
    return false;
  }

  if (message.action === "stopRecording") {
    stopRecording().then((result) => sendResponse(result));
    return true;
  }

  if (message.action === "saveToken") {
    chrome.storage.local.set({ token: message.token });
    sendResponse({ success: true });
    return false;
  }

  return false;
});

async function startRecording(mode) {
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({});

    // Create offscreen document for MediaRecorder
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });

    if (existingContexts.length === 0) {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["USER_MEDIA"],
        justification: "Recording tab audio and video",
      });
    }

    recordedChunks = [];

    // Get media stream constraints based on mode
    const constraints = { audio: true };

    if (mode === "screen" || mode === "screen-cam") {
      constraints.video = true;
      constraints.mandatory = {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      };
    } else if (mode === "cam") {
      constraints.video = { facingMode: "user" };
    }

    // Send to offscreen document to handle recording
    chrome.runtime.sendMessage({
      target: "offscreen",
      action: "startCapture",
      streamId,
      mode,
    });

    return true;
  } catch (error) {
    console.error("Failed to start recording:", error);
    return false;
  }
}

async function stopRecording() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { target: "offscreen", action: "stopCapture" },
      async (response) => {
        if (response?.blob) {
          const slug = await uploadVideo(response.blob);
          resolve({ slug });
        } else {
          resolve({ error: "No recording data" });
        }
      }
    );
  });
}

async function uploadVideo(blobData) {
  const { token } = await chrome.storage.local.get(["token"]);
  if (!token) throw new Error("Not authenticated");

  const blob = new Blob([new Uint8Array(blobData)], { type: "video/webm" });
  const formData = new FormData();
  formData.append("file", blob, "recording.webm");

  const response = await fetch(`${API_URL}/api/videos/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });

  if (!response.ok) throw new Error("Upload failed");

  const data = await response.json();
  return data.slug;
}
