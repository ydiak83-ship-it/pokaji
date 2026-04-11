const API_URL = "https://gopokaji.ru";

let mediaRecorder = null;
let recordedChunks = [];
let activeStreams = [];
let timerInterval = null;
let seconds = 0;
let isPaused = false;

let recordingStartTime = null;
let pauseStartTime = null;
let totalPausedMs = 0;

let pipWin = null;
let currentMode = null;
let cameraPreviewStream = null;
let canvasAnimationId = null;
let replyToSlug = null;

// Load reply context set by background when recorder was opened from a video page
chrome.storage.local.get(["replyToSlug"], (result) => {
  replyToSlug = result.replyToSlug || null;
  if (replyToSlug) {
    chrome.storage.local.remove("replyToSlug");
  }
});

// Store element references once — they survive being moved to PiP window
const timerEl = document.getElementById("timer");
const pauseIconEl = document.getElementById("pause-icon");
const cameraVideoEl = document.getElementById("camera-video");
const screenIconEl = document.getElementById("screen-icon");
const recordingScreenEl = document.getElementById("recording-screen");
const btnPause = document.getElementById("btn-pause");
const btnStop = document.getElementById("btn-stop");
const btnCancel = document.getElementById("btn-cancel");

const screens = {
  mode: document.getElementById("mode-screen"),
  recording: recordingScreenEl,
  uploading: document.getElementById("uploading-screen"),
  done: document.getElementById("done-screen"),
  error: document.getElementById("error-screen"),
};

function showScreen(name) {
  Object.values(screens).forEach((s) => s && s.classList.add("hidden"));
  if (screens[name]) screens[name].classList.remove("hidden");
}

function showError(msg) {
  document.getElementById("error-msg").textContent = msg;
  showScreen("error");
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function getElapsedSeconds() {
  if (!recordingStartTime) return 0;
  const paused = isPaused ? Date.now() - pauseStartTime : 0;
  return Math.floor((Date.now() - recordingStartTime - totalPausedMs - paused) / 1000);
}

function tickTimer() {
  if (!recordingStartTime || isPaused) return;
  const elapsed = getElapsedSeconds();
  if (elapsed !== seconds) {
    seconds = elapsed;
    timerEl.textContent = formatTime(seconds);
    updateBadge();
  }
}

function startTimer() {
  seconds = 0;
  totalPausedMs = 0;
  pauseStartTime = null;
  recordingStartTime = Date.now();
  timerEl.textContent = "0:00";
  chrome.storage.local.set({ recordingStartedAt: recordingStartTime });
  updateBadge();
  timerInterval = setInterval(tickTimer, 500);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  recordingStartTime = null;
  pauseStartTime = null;
  totalPausedMs = 0;
  chrome.storage.local.remove(["recordingStartedAt"]);
  chrome.action.setBadgeText({ text: "" }).catch(() => {});
}

function updateBadge() {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  const text = m > 0 ? `${m}m` : `${s}s`;
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: "#dc2626" }).catch(() => {});
}

// Sync on focus restore (Chrome throttle fix)
window.addEventListener("focus", tickTimer);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) tickTimer();
});

// ─── Event listeners (attached once; survive move to PiP) ───

btnPause.addEventListener("click", () => {
  if (!mediaRecorder) return;
  if (isPaused) {
    mediaRecorder.resume();
    totalPausedMs += Date.now() - pauseStartTime;
    pauseStartTime = null;
    isPaused = false;
    pauseIconEl.innerHTML =
      '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>';
    btnPause.title = "Пауза";
  } else {
    mediaRecorder.pause();
    pauseStartTime = Date.now();
    isPaused = true;
    pauseIconEl.innerHTML = '<polygon points="5,3 19,12 5,21"/>';
    btnPause.title = "Продолжить";
  }
});

btnStop.addEventListener("click", () => stopRecording(true));

btnCancel.addEventListener("click", () => {
  const win = pipWin || window;
  if (win.confirm("Отменить запись? Видео не сохранится.")) {
    stopTimer();
    cleanup();
    closePiP();
    window.close();
  }
});

document.getElementById("btn-close").addEventListener("click", () => window.close());

// ─── Mode selection ───

document.querySelectorAll(".mode-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const mode = btn.dataset.mode;
    try {
      await startCapture(mode);
      const pipOpened = await openDocumentPiP(mode);
      if (!pipOpened) {
        // Fallback: compact popup window
        showScreen("recording");
        await resizeFallback(mode);
      }
      startTimer();
    } catch (err) {
      showError(err.message || "Не удалось начать запись");
    }
  });
});

// ─── Document PiP ───

async function openDocumentPiP(mode) {
  if (!window.documentPictureInPicture) {
    console.warn("Document PiP not supported, using fallback");
    return false;
  }

  try {
    pipWin = await window.documentPictureInPicture.requestWindow({
      width: 210,
      height: 268,
      disallowReturnToOpener: false,
    });
  } catch (e) {
    console.warn("Document PiP failed:", e);
    return false;
  }

  // Copy CSS into PiP window
  [...document.styleSheets].forEach((sheet) => {
    try {
      const cssText = [...sheet.cssRules].map((r) => r.cssText).join("\n");
      const style = pipWin.document.createElement("style");
      style.textContent = cssText;
      pipWin.document.head.appendChild(style);
    } catch {}
  });

  pipWin.document.body.style.cssText =
    "margin:0;padding:0;background:#0d0d10;overflow:hidden;display:flex;align-items:center;justify-content:center;height:100vh;";

  // Show recording screen and move it to PiP document
  recordingScreenEl.classList.remove("hidden");
  pipWin.document.body.appendChild(recordingScreenEl);

  // Setup camera or screen icon
  if ((mode === "cam" || mode === "screen-cam") && cameraPreviewStream) {
    cameraVideoEl.srcObject = cameraPreviewStream;
    cameraVideoEl.style.display = "block";
    screenIconEl.classList.add("hidden");
  } else {
    cameraVideoEl.style.display = "none";
    cameraVideoEl.srcObject = null;
    screenIconEl.classList.remove("hidden");
  }

  // When user closes the PiP window manually → stop recording
  pipWin.addEventListener("pagehide", () => {
    if (pipWin) {
      pipWin = null;
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        stopRecording(true);
      }
    }
  });

  // Minimize the main popup (it stays alive for recording + upload)
  try {
    const current = await chrome.windows.getCurrent();
    await chrome.windows.update(current.id, { state: "minimized" });
  } catch {}

  return true;
}

function closePiP() {
  if (!pipWin) return;
  // Move recording screen back before closing
  document.querySelector(".container").appendChild(recordingScreenEl);
  try { pipWin.close(); } catch {}
  pipWin = null;
}

// ─── Fallback: compact popup window ───

async function resizeFallback(mode) {
  if ((mode === "cam" || mode === "screen-cam") && cameraPreviewStream) {
    cameraVideoEl.srcObject = cameraPreviewStream;
    cameraVideoEl.style.display = "block";
    screenIconEl.classList.add("hidden");
  } else {
    cameraVideoEl.style.display = "none";
    cameraVideoEl.srcObject = null;
    screenIconEl.classList.remove("hidden");
  }
  try {
    const current = await chrome.windows.getCurrent();
    await chrome.windows.update(current.id, {
      width: 210,
      height: 268,
      top: 40,
      left: 40,
      focused: true,
    });
  } catch (err) {
    console.warn("Resize failed:", err);
  }
}

// ─── Media capture ───

function cleanup() {
  if (canvasAnimationId) {
    cancelAnimationFrame(canvasAnimationId);
    canvasAnimationId = null;
  }
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try { mediaRecorder.stop(); } catch {}
  }
  activeStreams.forEach((s) => {
    try { s.getTracks().forEach((t) => t.stop()); } catch {}
  });
  activeStreams = [];
  mediaRecorder = null;
  recordedChunks = [];
}

async function startCapture(mode) {
  cleanup();
  currentMode = mode;
  let finalStream;

  if (mode === "cam") {
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (!devices.some((d) => d.kind === "videoinput")) {
      throw new Error("Камера не найдена");
    }
    finalStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    activeStreams.push(finalStream);
    cameraPreviewStream = finalStream;
  } else {
    // Use chrome.desktopCapture via background — picker is tied to active tab,
    // but we keep the recorder popup focused. getDisplayMedia() would flip
    // focus to the last normal tab, which is the bug we're fixing.
    const pickerResp = await chrome.runtime.sendMessage({ action: "chooseDesktopMedia" });
    if (!pickerResp || !pickerResp.streamId) {
      throw new Error("Выбор источника отменён");
    }
    const screenStream = await navigator.mediaDevices.getUserMedia({
      audio: pickerResp.canRequestAudioTrack
        ? { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: pickerResp.streamId } }
        : false,
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: pickerResp.streamId,
          maxFrameRate: 30,
        },
      },
    });
    activeStreams.push(screenStream);

    let micStream = null;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      activeStreams.push(micStream);
    } catch {}

    const audioTracks = [];
    if (micStream && screenStream.getAudioTracks().length > 0) {
      const ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      ctx.createMediaStreamSource(micStream).connect(dest);
      ctx.createMediaStreamSource(screenStream).connect(dest);
      audioTracks.push(...dest.stream.getAudioTracks());
    } else if (micStream) {
      audioTracks.push(...micStream.getAudioTracks());
    } else {
      audioTracks.push(...screenStream.getAudioTracks());
    }

    if (mode === "screen-cam") {
      let camStream = null;
      try {
        camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        activeStreams.push(camStream);
        cameraPreviewStream = camStream;
      } catch {}

      if (camStream) {
        const screenVideo = document.createElement("video");
        screenVideo.srcObject = screenStream;
        screenVideo.muted = true;
        screenVideo.autoplay = true;
        await screenVideo.play();

        const camVideo = document.createElement("video");
        camVideo.srcObject = camStream;
        camVideo.muted = true;
        camVideo.autoplay = true;
        await camVideo.play();

        await new Promise((resolve) => {
          if (screenVideo.videoWidth > 0) resolve();
          else screenVideo.addEventListener("loadedmetadata", resolve, { once: true });
        });

        const canvas = document.createElement("canvas");
        canvas.width = screenVideo.videoWidth || 1920;
        canvas.height = screenVideo.videoHeight || 1080;
        const ctx2d = canvas.getContext("2d");
        const camSize = Math.floor(canvas.width * 0.18);
        const camX = canvas.width - camSize - 40;
        const camY = canvas.height - camSize - 40;

        function drawFrame() {
          ctx2d.drawImage(screenVideo, 0, 0, canvas.width, canvas.height);
          ctx2d.save();
          ctx2d.beginPath();
          ctx2d.arc(camX + camSize / 2, camY + camSize / 2, camSize / 2, 0, Math.PI * 2);
          ctx2d.clip();
          ctx2d.translate(2 * (camX + camSize / 2), 0);
          ctx2d.scale(-1, 1);
          ctx2d.drawImage(camVideo, camX, camY, camSize, camSize);
          ctx2d.restore();
          ctx2d.strokeStyle = "#6366f1";
          ctx2d.lineWidth = 4;
          ctx2d.beginPath();
          ctx2d.arc(camX + camSize / 2, camY + camSize / 2, camSize / 2, 0, Math.PI * 2);
          ctx2d.stroke();
          canvasAnimationId = requestAnimationFrame(drawFrame);
        }
        drawFrame();

        const canvasStream = canvas.captureStream(30);
        finalStream = new MediaStream([canvasStream.getVideoTracks()[0], ...audioTracks]);
      } else {
        finalStream = new MediaStream([screenStream.getVideoTracks()[0], ...audioTracks]);
      }
    } else {
      finalStream = new MediaStream([screenStream.getVideoTracks()[0], ...audioTracks]);
    }

    screenStream.getVideoTracks()[0].addEventListener("ended", () => stopRecording(true));
  }

  recordedChunks = [];
  mediaRecorder = new MediaRecorder(finalStream, {
    mimeType: "video/webm;codecs=vp9,opus",
    videoBitsPerSecond: 2500000,
  });
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordedChunks.push(e.data);
  };
  mediaRecorder.start(1000);
}

// ─── Stop & upload ───

async function stopRecording(upload = true) {
  stopTimer();
  closePiP();

  try {
    const current = await chrome.windows.getCurrent();
    await chrome.windows.update(current.id, {
      width: 420,
      height: 300,
      state: "normal",
    });
  } catch {}

  showScreen("uploading");

  if (!mediaRecorder || mediaRecorder.state === "inactive") {
    if (upload) showError("Запись не активна");
    return;
  }

  mediaRecorder.onstop = async () => {
    const blob = new Blob(recordedChunks, { type: "video/webm" });
    activeStreams.forEach((s) => {
      try { s.getTracks().forEach((t) => t.stop()); } catch {}
    });

    if (!upload) return;

    try {
      const { slug } = await uploadVideo(blob);
      showScreen("done");
      setTimeout(() => {
        chrome.tabs.create({ url: `${API_URL}/v/${slug}` });
        window.close();
      }, 2000);
    } catch (err) {
      showError(err.message || "Ошибка загрузки");
    }
  };

  mediaRecorder.stop();
}

async function uploadVideo(blob) {
  const { token } = await chrome.storage.local.get(["token"]);
  if (!token) throw new Error("Не авторизован");

  // Step 1 — ask backend for a presigned S3 PUT URL
  const initResp = await fetch(`${API_URL}/api/videos/init-upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!initResp.ok) {
    const error = await initResp.json().catch(() => ({ detail: "Init failed" }));
    throw new Error(error.detail || `HTTP ${initResp.status}`);
  }
  const { video_id, upload_url, upload_key } = await initResp.json();

  // Step 2 — upload the blob directly to S3 (bypasses Cloudflare 100 MB limit)
  const putResp = await fetch(upload_url, {
    method: "PUT",
    headers: { "Content-Type": "video/webm" },
    body: blob,
  });
  if (!putResp.ok) {
    throw new Error(`Не удалось загрузить файл в хранилище (${putResp.status})`);
  }

  // Step 3 — tell backend to transcode and create the DB record
  const finalizeResp = await fetch(`${API_URL}/api/videos/finalize-upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      video_id,
      upload_key,
      reply_to_slug: replyToSlug || null,
    }),
  });
  if (!finalizeResp.ok) {
    const error = await finalizeResp.json().catch(() => ({ detail: "Finalize failed" }));
    throw new Error(error.detail || `HTTP ${finalizeResp.status}`);
  }

  return finalizeResp.json();
}

window.addEventListener("beforeunload", (e) => {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    e.preventDefault();
    e.returnValue = "Запись идёт. Закрыть окно и потерять видео?";
    return e.returnValue;
  }
  cleanup();
});
