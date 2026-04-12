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
const offscreen = new OffscreenCanvas(1, 1);
const ctx = offscreen.getContext("2d");

async function pumpCam(readable) {
  const reader = readable.getReader();
  try {
    while (running) {
      const result = await reader.read();
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
  }
}

function drawCam(w, h) {
  if (!latestCamFrame) return;

  const vw = latestCamFrame.displayWidth;
  const vh = latestCamFrame.displayHeight;
  if (!vw || !vh) return;

  if (pipPos && pipPos.w > 0 && pipPos.h > 0) {
    // Rounded-rect overlay covering the PiP's bounding box. A circle would
    // always leave a corner of the PiP visible when the PiP is flush with
    // the screen edge (there's no circle that both stays inside the canvas
    // and contains an edge-touching rectangle). A rounded rect clamped to
    // canvas bounds handles every PiP position cleanly.
    const margin = 16;
    const rectL = Math.max(0, pipPos.x - margin);
    const rectT = Math.max(0, pipPos.y - margin);
    const rectR = Math.min(w, pipPos.x + pipPos.w + margin);
    const rectB = Math.min(h, pipPos.y + pipPos.h + margin);
    const rectW = rectR - rectL;
    const rectH = rectB - rectT;
    if (rectW <= 0 || rectH <= 0) return;
    const radius = Math.min(28, Math.min(rectW, rectH) / 4);

    // Cover-fit the cam stream into the rectangle and mirror horizontally
    const scale = Math.max(rectW / vw, rectH / vh);
    const drawW = vw * scale;
    const drawH = vh * scale;
    const drawX = rectL + (rectW - drawW) / 2;
    const drawY = rectT + (rectH - drawH) / 2;

    ctx.save();
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(rectL, rectT, rectW, rectH, radius);
    } else {
      ctx.rect(rectL, rectT, rectW, rectH);
    }
    ctx.clip();
    // Mirror horizontally around the rect's centre so the preview reads
    // like a selfie
    const midX = rectL + rectW / 2;
    ctx.translate(midX, 0);
    ctx.scale(-1, 1);
    ctx.translate(-midX, 0);
    ctx.drawImage(latestCamFrame, drawX, drawY, drawW, drawH);
    ctx.restore();

    ctx.strokeStyle = "#6366f1";
    ctx.lineWidth = 4;
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(rectL, rectT, rectW, rectH, radius);
    } else {
      ctx.rect(rectL, rectT, rectW, rectH);
    }
    ctx.stroke();
    return;
  }

  // Fallback — bottom-left circle (when PiP position hasn't been reported yet)
  const size = Math.floor(w * 0.18);
  const cx = 40 + size / 2;
  const cy = h - 40 - size / 2;
  const r = size / 2;
  const side = Math.min(vw, vh);
  const sx = (vw - side) / 2;
  const sy = (vh - side) / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.translate(2 * cx, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(latestCamFrame, sx, sy, side, side, cx - r, cy - r, r * 2, r * 2);
  ctx.restore();
  ctx.strokeStyle = "#6366f1";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
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
    if (latestCamFrame) {
      try { latestCamFrame.close(); } catch {}
      latestCamFrame = null;
    }
  }
};
