let mediaRecorder = null;
let recordedChunks = [];

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== "offscreen") return false;

  if (message.action === "startCapture") {
    startCapture(message.streamId, message.mode);
    sendResponse({ success: true });
    return false;
  }

  if (message.action === "stopCapture") {
    stopCapture().then((blobData) => sendResponse({ blob: blobData }));
    return true;
  }

  return false;
});

async function startCapture(streamId, mode) {
  const constraints = {
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
  };

  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);

    // If screen+cam mode, also get camera stream
    if (mode === "screen-cam") {
      try {
        const camStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: 200, height: 200 },
          audio: false,
        });
        // Camera overlay handled by content script
        // Just mix audio if needed
        camStream.getTracks().forEach((track) => {
          if (track.kind === "audio") {
            stream.addTrack(track);
          }
        });
      } catch {
        console.warn("Camera not available, recording screen only");
      }
    }

    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream, {
      mimeType: "video/webm;codecs=vp9,opus",
      videoBitsPerSecond: 2500000,
    });

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        recordedChunks.push(event.data);
      }
    };

    mediaRecorder.start(1000); // Collect data every second
  } catch (error) {
    console.error("Capture failed:", error);
  }
}

async function stopCapture() {
  return new Promise((resolve) => {
    if (!mediaRecorder || mediaRecorder.state === "inactive") {
      resolve(null);
      return;
    }

    mediaRecorder.onstop = async () => {
      const blob = new Blob(recordedChunks, { type: "video/webm" });
      const arrayBuffer = await blob.arrayBuffer();
      const uint8Array = Array.from(new Uint8Array(arrayBuffer));

      // Stop all tracks
      mediaRecorder.stream.getTracks().forEach((track) => track.stop());
      mediaRecorder = null;
      recordedChunks = [];

      resolve(uint8Array);
    };

    mediaRecorder.stop();
  });
}
