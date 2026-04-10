// Camera overlay for screen+cam mode
let cameraOverlay = null;
let cameraStream = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "showCamera") {
    showCameraOverlay();
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "hideCamera") {
    hideCameraOverlay();
    sendResponse({ success: true });
    return false;
  }

  return false;
});

async function showCameraOverlay() {
  if (cameraOverlay) return;

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: 200, height: 200 },
      audio: false,
    });

    cameraOverlay = document.createElement("div");
    cameraOverlay.id = "pokaji-camera-overlay";

    const video = document.createElement("video");
    video.srcObject = cameraStream;
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;

    cameraOverlay.appendChild(video);
    document.body.appendChild(cameraOverlay);

    // Make draggable
    let isDragging = false;
    let offsetX = 0;
    let offsetY = 0;

    cameraOverlay.addEventListener("mousedown", (e) => {
      isDragging = true;
      offsetX = e.clientX - cameraOverlay.offsetLeft;
      offsetY = e.clientY - cameraOverlay.offsetTop;
    });

    document.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      cameraOverlay.style.left = `${e.clientX - offsetX}px`;
      cameraOverlay.style.top = `${e.clientY - offsetY}px`;
    });

    document.addEventListener("mouseup", () => {
      isDragging = false;
    });
  } catch (error) {
    console.error("Camera overlay failed:", error);
  }
}

function hideCameraOverlay() {
  if (cameraOverlay) {
    cameraOverlay.remove();
    cameraOverlay = null;
  }
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
  }
}
