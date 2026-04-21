// Off-main-thread compositor for the fullscreen "screen + camera" recording
// mode. Lives in a Worker because requestAnimationFrame in a minimised
// recorder popup is throttled to ~1 Hz, which froze the final video in the
// first attempt at this fix (reverted commit 98c03b3). Workers are not
// throttled, so the composition runs at full speed regardless of what the
// popup window is doing.
//
// The camera overlay is drawn as a circle positioned over the PiP recorder
// window's bounding box in the captured screen stream, slightly larger than
// the PiP's diagonal, so the PiP itself is hidden behind the overlay in the
// final video — leaving only one camera visible even though the user sees a
// live preview in the PiP.

let running = false;
let latestCamFrame = null;
// { x, y, w, h } in canvas (device) pixels — where the PiP window is in the
// captured screen stream. Updated via postMessage from the main thread.
let pipPos = null;
// Overlay size in canvas pixels when pipPos is unknown (e.g. fallback Chrome
// popup path): main thread sends physical pixels matching fallback window.
let fallbackSize = null;
let camReader = null;
const offscreen = new OffscreenCanvas(1, 1);
const ctx = offscreen.getContext("2d");

async function pumpCam(readable) {
  camReader = readable.getReader();
  try {
    while (running) {
      const result = await camReader.read();
      if (result.done || !result.value) return;
      const old = latestCamFrame;
      latestCamFrame = result.value;
      if (old) {
        try { old.close(); } catch {}
      }
    }
  } catch {
    // reader closed or errored — fall through to cleanup
  } finally {
    if (latestCamFrame) {
      try { latestCamFrame.close(); } catch {}
      latestCamFrame = null;
    }
    camReader = null;
  }
}

function drawCam(w, h) {
  if (!latestCamFrame) return;

  const vw = latestCamFrame.displayWidth;
  const vh = latestCamFrame.displayHeight;
  if (!vw || !vh) return;

  // Overlay covers the PiP window exactly: either its live-reported bounds
  // (Document PiP path) or the known fallback window size (Chrome popup path).
  // The overlay is the same physical size as the PiP regardless of capture
  // resolution, so the camera shows at the exact size the user sees on screen.
  let rectL, rectT, rectW, rectH;
  if (pipPos && pipPos.w > 0 && pipPos.h > 0) {
    rectW = Math.round(pipPos.w);
    rectH = Math.round(pipPos.h);
    rectL = Math.max(0, Math.min(w - rectW, Math.round(pipPos.x)));
    rectT = Math.max(0, Math.min(h - rectH, Math.round(pipPos.y)));
  } else {
    // Fallback (Chrome popup) — size supplied by main thread in physical px.
    // If it wasn't sent, fall back to a proportional guess.
    rectW = fallbackSize ? fallbackSize.w : Math.round(w * 0.095);
    rectH = fallbackSize ? fallbackSize.h : Math.round(w * 0.11);
    const margin = Math.round(w / 60); // = 32 logical px at any dpr
    rectL = w - margin - rectW;
    rectT = h - margin - rectH;
  }
  if (rectW <= 0 || rectH <= 0) return;

  const radius = Math.min(16, Math.min(rectW, rectH) / 6);

  // Cover-fit cam into rect and mirror horizontally (selfie view).
  const scale = Math.max(rectW / vw, rectH / vh);
  const drawW = vw * scale;
  const drawH = vh * scale;
  const drawX = rectL + (rectW - drawW) / 2;
  const drawY = rectT + (rectH - drawH) / 2;

  const drawPath = () => {
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(rectL, rectT, rectW, rectH, radius);
    } else {
      ctx.rect(rectL, rectT, rectW, rectH);
    }
  };

  ctx.save();
  drawPath();
  ctx.clip();
  const midX = rectL + rectW / 2;
  ctx.translate(midX, 0);
  ctx.scale(-1, 1);
  ctx.translate(-midX, 0);
  ctx.drawImage(latestCamFrame, drawX, drawY, drawW, drawH);
  ctx.restore();

  ctx.strokeStyle = "#d9744a";
  ctx.lineWidth = 3;
  drawPath();
  ctx.stroke();
}

function makeTransformer() {
  return new TransformStream({
    transform(screenFrame, controller) {
      const w = screenFrame.displayWidth;
      const h = screenFrame.displayHeight;
      if (offscreen.width !== w || offscreen.height !== h) {
        offscreen.width = w;
        offscreen.height = h;
      }
      ctx.drawImage(screenFrame, 0, 0, w, h);
      const ts = screenFrame.timestamp;
      const duration = screenFrame.duration ?? 0;
      screenFrame.close();

      drawCam(w, h);

      controller.enqueue(new VideoFrame(offscreen, { timestamp: ts, duration }));
    },
  });
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "init") {
    running = true;
    if (msg.pipPos) pipPos = msg.pipPos;
    if (msg.fallbackSize) fallbackSize = msg.fallbackSize;
    if (msg.cam) {
      pumpCam(msg.cam);
    }
    msg.screen
      .pipeThrough(makeTransformer())
      .pipeTo(msg.output)
      .catch((err) => {
        console.error("[recorder-worker] pipeline:", err);
      });
  } else if (msg.type === "pip-pos") {
    pipPos = msg.pos;
  } else if (msg.type === "stop") {
    running = false;
    // Cancel the reader so the in-flight `reader.read()` in pumpCam resolves
    // immediately instead of holding an unclosed frame until termination
    if (camReader) {
      try { camReader.cancel(); } catch {}
    }
    if (latestCamFrame) {
      try { latestCamFrame.close(); } catch {}
      latestCamFrame = null;
    }
  }
};
