// AirDraw — page main-world patch + frame loop.
//
// Replaces navigator.mediaDevices.getUserMedia so that any video request
// gets the real camera piped through a hidden <canvas>. Hand-drawn strokes
// (tracked from the SAME unmirrored camera frame, so coordinates line up
// exactly) are composited onto it every frame, and canvas.captureStream(30)
// is returned as the outgoing video track — the literal track handed to
// Meet/Teams, so whatever lands on the canvas is what participants see.
//
// getUserMedia is overridden synchronously, on the very first line below,
// so the patch is guaranteed to be in place before any async module
// loading finishes — heavy init (MediaPipe, wasm) happens in parallel and
// is only awaited inside the override, once a real video call comes in.

(function airdraw() {
  if (navigator.mediaDevices.__airdrawPatched) return; // avoid double-patch on re-injection
  navigator.mediaDevices.__airdrawPatched = true;

  const originalGetUserMedia =
    navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

  let extensionRoot;
  try {
    extensionRoot = new URL("..", document.currentScript.src).href;
  } catch (err) {
    console.error(
      "[AirDraw] could not determine extension URL — drawing disabled, camera unaffected",
      err
    );
  }
  const readyPromise = extensionRoot
    ? initAirDraw(extensionRoot)
    : Promise.reject(new Error("no extension root"));
  readyPromise.then(
    () => console.log("[AirDraw] hand tracking ready"),
    (err) => console.error("[AirDraw] init failed — falling back to real camera on next getUserMedia call", err)
  );

  navigator.mediaDevices.getUserMedia = async function airdrawGetUserMedia(
    constraints
  ) {
    // Audio-only requests fall through untouched. getDisplayMedia is a
    // separate method entirely and is never touched by this override.
    if (!constraints || !constraints.video) {
      return originalGetUserMedia(constraints);
    }

    const realStream = await originalGetUserMedia(constraints);
    try {
      const { buildCanvasStream } = await readyPromise;
      return buildCanvasStream(realStream);
    } catch (err) {
      console.error(
        "[AirDraw] failed to build canvas stream, falling back to real camera",
        err
      );
      return realStream;
    }
  };

  console.log("[AirDraw] getUserMedia patched");

  async function initAirDraw(root) {
    const [{ CONFIG, LANDMARK }, { HandTracker }, { GestureEngine }, canvasApi, { renderFrame }, { createOverlay }] =
      await Promise.all([
        import(root + "src/config.js"),
        import(root + "src/tracking.js"),
        import(root + "src/gestures.js"),
        import(root + "src/canvas.js"),
        import(root + "src/render.js"),
        import(root + "src/overlay.js"),
      ]);
    const { createStroke, addPoint, trySnapStroke, eraseInsideHull } = canvasApi;

    const tracker = new HandTracker();
    await tracker.init(root + "vendor/");
    const gestureEngine = new GestureEngine();
    const overlay = createOverlay();

    // Settings — hardcoded defaults for now. The popup (next step) will
    // update `settings` in place via chrome.storage instead of these.
    const settings = {
      enabled: true,
      color: CONFIG.PALETTE[CONFIG.DEFAULT_COLOR_INDEX],
      width: CONFIG.STROKE_WIDTH_BASE_PX,
      snapEnabled: CONFIG.SNAP_ENABLED_DEFAULT,
    };

    // Landmarks used to build the eraser's convex hull: palm base points
    // (wrist + each finger's MCP) plus every fingertip.
    const ERASER_HULL_INDICES = [
      LANDMARK.WRIST,
      LANDMARK.THUMB_MCP,
      LANDMARK.INDEX_MCP,
      LANDMARK.MIDDLE_MCP,
      LANDMARK.RING_MCP,
      LANDMARK.PINKY_MCP,
      LANDMARK.THUMB_TIP,
      LANDMARK.INDEX_TIP,
      LANDMARK.MIDDLE_TIP,
      LANDMARK.RING_TIP,
      LANDMARK.PINKY_TIP,
    ];

    function buildCanvasStream(realStream) {
      const realVideoTrack = realStream.getVideoTracks()[0];
      if (!realVideoTrack) return realStream;

      const trackSettings = realVideoTrack.getSettings();
      const width = trackSettings.width || 1280;
      const height = trackSettings.height || 720;

      const sourceVideo = document.createElement("video");
      sourceVideo.muted = true;
      sourceVideo.playsInline = true;
      sourceVideo.srcObject = new MediaStream([realVideoTrack]);
      sourceVideo.play().catch(() => {});

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { alpha: false });

      let strokes = [];
      const activeStrokes = new Map(); // handedness -> in-progress stroke

      function finishStroke(handedness) {
        const stroke = activeStrokes.get(handedness);
        if (!stroke) return;
        activeStrokes.delete(handedness);
        if (stroke.points.length < 2) return; // a tap, not a stroke
        trySnapStroke(stroke, canvas.width, settings.snapEnabled);
        strokes.push(stroke);
      }

      let trackingBroken = false; // set true if tracking/gestures throw, so we stop retrying every frame but keep drawing video+strokes

      function processHandsAndGestures(nowMs) {
        const hands = tracker.update(sourceVideo, nowMs);
        const { hands: gestureHands, events } = gestureEngine.update(
          hands,
          nowMs,
          canvas.width,
          canvas.height
        );

        if (events.clearAll) {
          strokes = [];
          activeStrokes.clear();
        }
        if (events.undo && strokes.length > 0) {
          strokes.pop();
        }

        const seenHands = new Set();
        for (const hand of gestureHands) {
          seenHands.add(hand.handedness);

          if (hand.gesture === "pen") {
            let stroke = activeStrokes.get(hand.handedness);
            if (!stroke) {
              stroke = createStroke(settings.color, settings.width);
              activeStrokes.set(hand.handedness, stroke);
            }
            addPoint(stroke, hand.point.x, hand.point.y);
          } else {
            finishStroke(hand.handedness);
          }

          if (hand.gesture === "eraser") {
            const hullPoints = ERASER_HULL_INDICES.map((i) => ({
              x: hand.hullLandmarks[i].x * canvas.width,
              y: hand.hullLandmarks[i].y * canvas.height,
            }));
            strokes = eraseInsideHull(strokes, hullPoints);
          }
        }
        // A hand that was drawing but dropped out of tracking entirely
        // this frame still needs its stroke finalized, not left hanging.
        for (const handedness of [...activeStrokes.keys()]) {
          if (!seenHands.has(handedness)) finishStroke(handedness);
        }

        const primary = gestureHands[0];
        overlay.update({
          enabled: true,
          gesture: primary ? primary.gesture : "idle",
          color: settings.color,
        });
      }

      let rafId = null;
      function drawFrame() {
        const nowMs = performance.now();

        // Everything in this try block must never be allowed to freeze the
        // outgoing video: if tracking/gestures throw, we disable tracking
        // for the rest of the call but keep rendering the real camera plus
        // whatever strokes already exist.
        try {
          if (settings.enabled && !trackingBroken && sourceVideo.readyState >= 2) {
            processHandsAndGestures(nowMs);
          } else {
            overlay.update({
              enabled: settings.enabled,
              gesture: "off",
              color: settings.color,
            });
          }
        } catch (err) {
          trackingBroken = true;
          console.error(
            "[AirDraw] hand tracking/gesture error — drawing disabled, video output continues",
            err
          );
        }

        try {
          renderFrame(
            ctx,
            canvas,
            sourceVideo,
            strokes,
            settings.enabled ? [...activeStrokes.values()] : [],
            nowMs
          );
        } catch (err) {
          console.error("[AirDraw] render error", err);
        }

        rafId = requestAnimationFrame(drawFrame);
      }
      rafId = requestAnimationFrame(drawFrame);

      const canvasStream = canvas.captureStream(CONFIG.TARGET_FPS);
      const [canvasVideoTrack] = canvasStream.getVideoTracks();

      const outputStream = new MediaStream([
        canvasVideoTrack,
        ...realStream.getAudioTracks(),
      ]);

      // Note: `overlay` is shared across every buildCanvasStream() call for
      // this page (created once in initAirDraw), so it is intentionally
      // NOT destroyed here — toggling the camera off/on within the same
      // call must not leave the status panel gone for good.
      const stopAll = () => {
        cancelAnimationFrame(rafId);
        sourceVideo.pause();
        sourceVideo.srcObject = null;
        realVideoTrack.stop();
        canvasVideoTrack.stop();
      };
      realVideoTrack.addEventListener("ended", stopAll);
      canvasVideoTrack.addEventListener("ended", stopAll);

      return outputStream;
    }

    return { buildCanvasStream };
  }
})();
