// AirDraw — MediaPipe HandLandmarker wrapper + One Euro smoothing filter.
//
// Everything here is bundled locally under vendor/mediapipe (wasm + .task
// model fetched from the real @mediapipe/tasks-vision npm package, no CDN)
// so it keeps working under strict page CSPs like Meet's and Teams'.

import { CONFIG } from "./config.js";

// -------------------------------------------------------------------------
// One Euro filter — Casiez, Roussel, Vogel (2012).
// Adapts smoothing to speed: heavy smoothing when nearly still (kills
// jitter), light smoothing when moving fast (kills lag). A fixed moving
// average can only pick one tradeoff; this picks per-frame.
// -------------------------------------------------------------------------
class LowPassFilter {
  setAlpha(alpha) {
    this.alpha = alpha;
  }
  filter(value, alpha) {
    if (alpha !== undefined) this.setAlpha(alpha);
    this.value = this.initialized
      ? this.alpha * value + (1 - this.alpha) * this.value
      : value;
    this.initialized = true;
    return this.value;
  }
}

function alphaFromCutoff(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export class OneEuroFilter {
  constructor(
    minCutoff = CONFIG.ONE_EURO_MIN_CUTOFF,
    beta = CONFIG.ONE_EURO_BETA,
    dCutoff = CONFIG.ONE_EURO_D_CUTOFF
  ) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.xFilter = new LowPassFilter();
    this.dxFilter = new LowPassFilter();
    this.lastTimeMs = null;
  }

  filter(value, timeMs) {
    if (this.lastTimeMs == null) {
      this.lastTimeMs = timeMs;
      this.xFilter.filter(value);
      this.dxFilter.filter(0);
      return value;
    }
    const dt = Math.max((timeMs - this.lastTimeMs) / 1000, 1 / 240);
    this.lastTimeMs = timeMs;

    const dx = (value - this.xFilter.value) / dt;
    const edx = this.dxFilter.filter(dx, alphaFromCutoff(this.dCutoff, dt));

    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.xFilter.filter(value, alphaFromCutoff(cutoff, dt));
  }
}

// Filters one full 21-landmark hand (x, y, z each smoothed independently).
class HandLandmarkFilter {
  constructor() {
    this.filters = null; // lazily sized to landmark count on first use
  }
  filter(landmarks, timeMs) {
    if (!this.filters) {
      this.filters = landmarks.map(() => ({
        x: new OneEuroFilter(),
        y: new OneEuroFilter(),
        z: new OneEuroFilter(),
      }));
    }
    return landmarks.map((lm, i) => ({
      x: this.filters[i].x.filter(lm.x, timeMs),
      y: this.filters[i].y.filter(lm.y, timeMs),
      z: this.filters[i].z.filter(lm.z, timeMs),
    }));
  }
}

// MediaPipe loads its wasm loader by appending a <script> to document.body.
// inject.js runs at document_start, when a heavy page like Meet may not have
// parsed <body> yet — so wait for it (not for DOMContentLoaded, which would
// hold init back until the whole page has parsed).
function bodyReady() {
  if (document.body) return Promise.resolve();
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (!document.body) return;
      observer.disconnect();
      resolve();
    });
    observer.observe(document.documentElement, { childList: true });
  });
}

// -------------------------------------------------------------------------
// HandTracker — owns the HandLandmarker instance, the downscaled tracking
// canvas, per-hand smoothing, and the every-2nd-frame fallback so the
// caller can call update() once per rendered frame and always get a usable
// result without ever blocking the canvas output framerate.
// -------------------------------------------------------------------------
export class HandTracker {
  constructor() {
    this.landmarker = null;
    this.trackingCanvas = document.createElement("canvas");
    this.trackingCanvas.width = CONFIG.TRACKING_WIDTH;
    this.trackingCanvas.height = CONFIG.TRACKING_HEIGHT;
    this.trackingCtx = this.trackingCanvas.getContext("2d", { alpha: false });

    this.filtersByHandedness = new Map(); // 'Left' | 'Right' -> HandLandmarkFilter
    this.lastResult = []; // last known [{handedness, landmarks}]
    this.lastInferenceMs = 0; // EMA of detectForVideo() cost
    this.skipAlternateFrames = false;
    this.frameParity = 0;
  }

  async init(vendorBaseUrl) {
    const { FilesetResolver, HandLandmarker } = await import(
      /* webpackIgnore: true */ vendorBaseUrl + "mediapipe/vision_bundle.mjs"
    );
    const fileset = await FilesetResolver.forVisionTasks(
      vendorBaseUrl + "mediapipe/wasm"
    );
    await bodyReady();
    this.landmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: vendorBaseUrl + "mediapipe/hand_landmarker.task",
      },
      runningMode: "VIDEO",
      numHands: CONFIG.MAX_NUM_HANDS,
      minHandDetectionConfidence: CONFIG.MIN_HAND_DETECTION_CONFIDENCE,
      minHandPresenceConfidence: CONFIG.MIN_HAND_PRESENCE_CONFIDENCE,
      minTrackingConfidence: CONFIG.MIN_TRACKING_CONFIDENCE,
    });
  }

  /**
   * @param {HTMLVideoElement} sourceVideo unmirrored real camera frame
   * @param {number} nowMs monotonic timestamp (performance.now())
   * @returns {Array<{handedness:string, landmarks:Array<{x,y,z}>}>}
   */
  update(sourceVideo, nowMs) {
    if (!this.landmarker) return this.lastResult;
    // HAVE_CURRENT_DATA (2) or better — otherwise there's no decoded frame
    // yet to draw, and drawing/detecting against an empty video source
    // must never be allowed to throw and kill the caller's render loop.
    if (sourceVideo.readyState < 2) return this.lastResult;

    const shouldRunThisFrame =
      !this.skipAlternateFrames || this.frameParity % 2 === 0;
    this.frameParity++;

    if (!shouldRunThisFrame) {
      return this.lastResult; // caller keeps last known landmarks (held, not interpolated forward — good enough between two adjacent 30fps frames)
    }

    this.trackingCtx.drawImage(
      sourceVideo,
      0,
      0,
      this.trackingCanvas.width,
      this.trackingCanvas.height
    );

    const t0 = performance.now();
    const result = this.landmarker.detectForVideo(this.trackingCanvas, nowMs);
    const inferenceMs = performance.now() - t0;
    this.lastInferenceMs = this.lastInferenceMs
      ? this.lastInferenceMs * 0.8 + inferenceMs * 0.2
      : inferenceMs;

    if (
      !this.skipAlternateFrames &&
      this.lastInferenceMs > CONFIG.TRACKING_SLOW_FRAME_MS
    ) {
      this.skipAlternateFrames = true;
      console.warn(
        "[AirDraw] tracking is slow (%dms/frame) — switching to every-2nd-frame tracking",
        this.lastInferenceMs.toFixed(1)
      );
    } else if (
      this.skipAlternateFrames &&
      this.lastInferenceMs < CONFIG.TRACKING_RECOVER_FRAME_MS
    ) {
      this.skipAlternateFrames = false;
    }

    const hands = (result.landmarks || []).map((landmarks, i) => {
      const handedness =
        result.handednesses?.[i]?.[0]?.categoryName || `hand${i}`;
      let filter = this.filtersByHandedness.get(handedness);
      if (!filter) {
        filter = new HandLandmarkFilter();
        this.filtersByHandedness.set(handedness, filter);
      }
      return { handedness, landmarks: filter.filter(landmarks, nowMs) };
    });

    this.lastResult = hands;
    return hands;
  }
}
