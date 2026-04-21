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
let selectedTeamSlug = null;
let compositorWorker = null;
let pipPosPollerId = null;
// Remember which window owns the poller interval — after pagehide nulls
// pipWin, `window.clearInterval` on a PiP-owned ID is a no-op
let pipPosPollerWin = null;
let audioCtx = null;
// True when the screen capture source is the whole monitor — in that case
// the PiP recorder window is part of the capture, and we switch to a
// worker-based compositor that paints the camera overlay on top of the
// PiP's location to hide it
let isFullScreenCapture = false;

// Load reply context and team selection
chrome.storage.local.get(["replyToSlug", "selectedTeamSlug"], (result) => {
  replyToSlug = result.replyToSlug || null;
  selectedTeamSlug = result.selectedTeamSlug || null;
  if (replyToSlug) {
    chrome.storage.local.remove("replyToSlug");
  }
});

// Background broadcasts this when the user hits the stop hotkey while the
// main popup is minimised (worker-path mode has no visible PiP controls)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.action === "stopRecording" && mediaRecorder && mediaRecorder.state === "recording") {
    stopRecording(true);
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
      // Hide the mode selector immediately so it can't appear in the first
      // frames of the recording when the screen capture includes the popup
      Object.values(screens).forEach((s) => s && s.classList.add("hidden"));
      await startCapture(mode);

      const useWorkerPath =
        isFullScreenCapture && mode === "screen-cam" && compositorWorker;

      const pipOpened = await openDocumentPiP(mode);
      if (!pipOpened) {
        // Fallback: compact popup window
        showScreen("recording");
        await resizeFallback(mode);
      }

      if (useWorkerPath && pipOpened) {
        startPipPosPolling();
        try {
          await chrome.notifications.create("pokaji-recording", {
            type: "basic",
            iconUrl: chrome.runtime.getURL("icons/icon128.png"),
            title: "Запись идёт",
            message: "Остановить: Alt+Shift+P",
            priority: 2,
          });
        } catch {}
      }

      // Only start the recorder after the UI is tucked away (PiP opened and
      // main popup minimized) — otherwise the first 1-2 seconds of the video
      // contain the popup window with the mode selector
      mediaRecorder.start(1000);
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
      width: 160,
      height: 180,
      disallowReturnToOpener: false,
    });
  } catch (e) {
    console.warn("Document PiP failed:", e);
    return false;
  }

  // Move PiP to bottom-right so its position matches the fallback window path
  // AND the compositor's overlay (fullscreen mode hides the PiP behind the
  // overlay, so both must land in the same corner).
  try {
    const sw = pipWin.screen?.availWidth ?? window.screen.availWidth;
    const sh = pipWin.screen?.availHeight ?? window.screen.availHeight;
    pipWin.moveTo(sw - 160 - 32, sh - 180 - 32);
  } catch {}

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
    // Bottom-right — matches the Document-PiP path and the compositor overlay.
    const sw = screen.availWidth;
    const sh = screen.availHeight;
    await chrome.windows.update(current.id, {
      width: 160,
      height: 210, // includes OS title bar (~30px) so body area matches 180
      top: sh - 210 - 32,
      left: sw - 160 - 32,
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
  stopPipPosPolling();
  if (compositorWorker) {
    try { compositorWorker.postMessage({ type: "stop" }); } catch {}
    try { compositorWorker.terminate(); } catch {}
    compositorWorker = null;
  }
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try { mediaRecorder.stop(); } catch {}
  }
  activeStreams.forEach((s) => {
    try { s.getTracks().forEach((t) => t.stop()); } catch {}
  });
  activeStreams = [];
  if (audioCtx) {
    try { audioCtx.close(); } catch {}
    audioCtx = null;
  }
  mediaRecorder = null;
  recordedChunks = [];
  isFullScreenCapture = false;
}

function stopPipPosPolling() {
  if (pipPosPollerId !== null && pipPosPollerWin) {
    try { pipPosPollerWin.clearInterval(pipPosPollerId); } catch {}
  }
  pipPosPollerId = null;
  pipPosPollerWin = null;
}

function startPipPosPolling() {
  if (!pipWin || !compositorWorker) return;
  const dpr = window.devicePixelRatio || 1;
  const send = () => {
    if (!pipWin || !compositorWorker) return;
    compositorWorker.postMessage({
      type: "pip-pos",
      pos: {
        x: pipWin.screenX * dpr,
        y: pipWin.screenY * dpr,
        w: pipWin.outerWidth * dpr,
        h: pipWin.outerHeight * dpr,
      },
    });
  };
  send();
  // pipWin.setInterval runs in the PiP document's timer loop, which isn't
  // throttled (PiP is always visible), so polling stays smooth even while
  // the main popup is minimised
  pipPosPollerWin = pipWin;
  pipPosPollerId = pipWin.setInterval(send, 33);
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
    finalStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      audio: true,
    });
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

    // Heuristic: whole-screen captures return a stream sized to the monitor
    // (optionally multiplied by devicePixelRatio on retina). Window and tab
    // captures return the window's own dimensions.
    try {
      const s = screenStream.getVideoTracks()[0].getSettings();
      const sw = window.screen.width;
      const sh = window.screen.height;
      const dpr = window.devicePixelRatio || 1;
      isFullScreenCapture =
        (s.width >= sw * 0.95 && s.height >= sh * 0.95) ||
        (s.width >= sw * dpr * 0.95 && s.height >= sh * dpr * 0.95);
    } catch {
      isFullScreenCapture = false;
    }

    let micStream = null;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      activeStreams.push(micStream);
    } catch (e) {
      console.warn("[recorder] microphone unavailable:", e);
    }

    const audioTracks = [];
    if (micStream && screenStream.getAudioTracks().length > 0) {
      audioCtx = new AudioContext();
      const dest = audioCtx.createMediaStreamDestination();
      audioCtx.createMediaStreamSource(micStream).connect(dest);
      audioCtx.createMediaStreamSource(screenStream).connect(dest);
      audioTracks.push(...dest.stream.getAudioTracks());
    } else if (micStream) {
      audioTracks.push(...micStream.getAudioTracks());
    } else {
      audioTracks.push(...screenStream.getAudioTracks());
    }

    if (mode === "screen-cam") {
      let camStream = null;
      try {
        camStream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
          audio: false,
        });
        activeStreams.push(camStream);
        cameraPreviewStream = camStream;
      } catch (err) {
        console.warn("[recorder] camera overlay unavailable, continuing screen-only:", err);
      }

      const canUseWorker =
        typeof MediaStreamTrackProcessor !== "undefined" &&
        typeof MediaStreamTrackGenerator !== "undefined";

      if (camStream && isFullScreenCapture && canUseWorker) {
        // Whole-screen capture: composite off the main thread so the camera
        // overlay is painted directly over the PiP recorder window's bounding
        // box, hiding the PiP in the final video while still letting the user
        // see their own live preview inside it
        const screenProc = new MediaStreamTrackProcessor({
          track: screenStream.getVideoTracks()[0],
        });
        const camProc = new MediaStreamTrackProcessor({
          track: camStream.getVideoTracks()[0],
        });
        const generator = new MediaStreamTrackGenerator({ kind: "video" });

        compositorWorker = new Worker(
          chrome.runtime.getURL("recorder/recorder-worker.js")
        );
        // Tell the worker what size the overlay should be when pipPos isn't
        // reported yet (fallback Chrome popup path): 160×210 logical, which is
        // `resizeFallback`'s window dims including OS title bar.
        const dpr = window.devicePixelRatio || 1;
        compositorWorker.postMessage(
          {
            type: "init",
            screen: screenProc.readable,
            cam: camProc.readable,
            output: generator.writable,
            fallbackSize: {
              w: Math.round(160 * dpr),
              h: Math.round(210 * dpr),
            },
          },
          [screenProc.readable, camProc.readable, generator.writable]
        );

        finalStream = new MediaStream([generator, ...audioTracks]);
      } else if (camStream) {
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
        // Overlay size = PiP window body (160×180 logical) in physical pixels,
        // so the camera looks the exact same size as the user sees the PiP on
        // their screen, regardless of the captured window's resolution.
        const dprWin = window.devicePixelRatio || 1;
        const rectW = Math.round(160 * dprWin);
        const rectH = Math.round(180 * dprWin);
        const margin = Math.round(32 * dprWin);
        const rectL = canvas.width - margin - rectW;
        const rectT = canvas.height - margin - rectH;
        const radius = Math.min(16, Math.min(rectW, rectH) / 6);

        const drawPath = () => {
          ctx2d.beginPath();
          if (ctx2d.roundRect) {
            ctx2d.roundRect(rectL, rectT, rectW, rectH, radius);
          } else {
            ctx2d.rect(rectL, rectT, rectW, rectH);
          }
        };

        function drawFrame() {
          ctx2d.drawImage(screenVideo, 0, 0, canvas.width, canvas.height);
          const vw = camVideo.videoWidth;
          const vh = camVideo.videoHeight;
          if (vw > 0 && vh > 0) {
            // Cover-fit the cam into the rect and mirror horizontally.
            const scale = Math.max(rectW / vw, rectH / vh);
            const drawW = vw * scale;
            const drawH = vh * scale;
            const drawX = rectL + (rectW - drawW) / 2;
            const drawY = rectT + (rectH - drawH) / 2;
            ctx2d.save();
            drawPath();
            ctx2d.clip();
            const midX = rectL + rectW / 2;
            ctx2d.translate(midX, 0);
            ctx2d.scale(-1, 1);
            ctx2d.translate(-midX, 0);
            ctx2d.drawImage(camVideo, drawX, drawY, drawW, drawH);
            ctx2d.restore();
            ctx2d.strokeStyle = "#d9744a";
            ctx2d.lineWidth = 3;
            drawPath();
            ctx2d.stroke();
          }
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

    screenStream
      .getVideoTracks()[0]
      .addEventListener("ended", () => stopRecording(true), { once: true });
  }

  recordedChunks = [];
  const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
    ? "video/webm;codecs=vp9,opus"
    : MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")
    ? "video/webm;codecs=vp8,opus"
    : "video/webm";
  mediaRecorder = new MediaRecorder(finalStream, {
    mimeType,
    videoBitsPerSecond: 5000000,
  });
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordedChunks.push(e.data);
  };
  // Recorder is started by the caller after the UI is hidden
}

// ─── Stop & upload ───

async function stopRecording(upload = true) {
  stopTimer();
  stopPipPosPolling();
  closePiP();

  try {
    await chrome.notifications.clear("pokaji-recording");
  } catch {}

  try {
    const current = await chrome.windows.getCurrent();
    await chrome.windows.update(current.id, {
      width: 420,
      height: 300,
      state: "normal",
      focused: true,
    });
  } catch {}

  showScreen("uploading");

  if (!mediaRecorder || mediaRecorder.state === "inactive") {
    // Nothing left to stop the normal way — tear everything down by hand
    // so streams, worker and AudioContext don't leak
    cleanup();
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

  // Step 1 — ask backend for a presigned S3 PUT URL. Pass team_slug so the
  // backend gate-check matches where finalize will file the video (a team
  // member uploading to an active team library shouldn't be blocked at init
  // by their personal monthly quota).
  const teamQuery = selectedTeamSlug
    ? `?team_slug=${encodeURIComponent(selectedTeamSlug)}`
    : "";
  const initResp = await fetch(`${API_URL}/api/videos/init-upload${teamQuery}`, {
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
      team_slug: selectedTeamSlug || null,
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
