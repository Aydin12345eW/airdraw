// AirDraw — landmark -> gesture state machine.
//
// Consumes the smoothed per-hand landmarks from tracking.js and produces,
// per hand, a single gesture for this frame: 'pen' | 'hover' | 'eraser' |
// 'openPalm' | 'idle', plus fires global one-shot events: 'undo', 'clearAll'.
//
// All thresholds live in config.js.

import { CONFIG, LANDMARK } from "./config.js";

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
}

function handSize(landmarks) {
  return dist(landmarks[LANDMARK.WRIST], landmarks[LANDMARK.MIDDLE_MCP]);
}

function fingerExtension(landmarks, tipIdx, mcpIdx) {
  const wrist = landmarks[LANDMARK.WRIST];
  const wristToTip = dist(wrist, landmarks[tipIdx]);
  const wristToMcp = dist(wrist, landmarks[mcpIdx]) || 1e-6;
  return wristToTip / wristToMcp;
}

function isExtended(ratio) {
  return ratio > CONFIG.FINGER_EXTENDED_RATIO;
}

function fingerStates(landmarks) {
  return {
    thumb: fingerExtension(landmarks, LANDMARK.THUMB_TIP, LANDMARK.THUMB_MCP),
    index: fingerExtension(landmarks, LANDMARK.INDEX_TIP, LANDMARK.INDEX_MCP),
    middle: fingerExtension(
      landmarks,
      LANDMARK.MIDDLE_TIP,
      LANDMARK.MIDDLE_MCP
    ),
    ring: fingerExtension(landmarks, LANDMARK.RING_TIP, LANDMARK.RING_MCP),
    pinky: fingerExtension(landmarks, LANDMARK.PINKY_TIP, LANDMARK.PINKY_MCP),
  };
}

// Per-hand persistent state (pinch hysteresis, eraser dwell, swipe history).
class HandState {
  constructor() {
    this.pinchDown = false;
    this.openPalmSince = null;
    this.eraserActive = false;
    this.swipeHistory = []; // [{x, t}] of the hover-pose midpoint, for undo-swipe detection
    this.lastSwipeFiredAt = -Infinity;
  }
}

export class GestureEngine {
  constructor() {
    this.handStates = new Map(); // handedness -> HandState
    this.bothPalmsSince = null;
  }

  _stateFor(handedness) {
    let s = this.handStates.get(handedness);
    if (!s) {
      s = new HandState();
      this.handStates.set(handedness, s);
    }
    return s;
  }

  /**
   * @param {Array<{handedness, landmarks}>} hands normalized landmarks (0..1)
   * @param {number} nowMs
   * @param {number} canvasWidth
   * @param {number} canvasHeight
   * @returns {{hands: Array, events: {undo: boolean, clearAll: boolean}}}
   */
  update(hands, nowMs, canvasWidth, canvasHeight) {
    const events = { undo: false, clearAll: false };
    const toPx = (lm) => ({ x: lm.x * canvasWidth, y: lm.y * canvasHeight });

    // First pass: classify each hand's raw pose (pinch / finger pattern).
    const classified = hands.map(({ handedness, landmarks }) => {
      const state = this._stateFor(handedness);
      const size = handSize(landmarks) || 1e-6;
      const pinchRatio =
        dist(landmarks[LANDMARK.THUMB_TIP], landmarks[LANDMARK.INDEX_TIP]) /
        size;

      // Hysteresis: separate down/up thresholds so a stroke doesn't
      // flicker pen-up/pen-down mid-letter from tiny pinch jitter.
      if (!state.pinchDown && pinchRatio < CONFIG.PINCH_DOWN_RATIO) {
        state.pinchDown = true;
      } else if (state.pinchDown && pinchRatio > CONFIG.PINCH_UP_RATIO) {
        state.pinchDown = false;
      }

      const fingers = fingerStates(landmarks);
      const indexMiddleOnly =
        isExtended(fingers.index) &&
        isExtended(fingers.middle) &&
        !isExtended(fingers.ring) &&
        !isExtended(fingers.pinky);
      const allExtended =
        isExtended(fingers.thumb) &&
        isExtended(fingers.index) &&
        isExtended(fingers.middle) &&
        isExtended(fingers.ring) &&
        isExtended(fingers.pinky);

      return {
        handedness,
        landmarks,
        state,
        pinching: state.pinchDown,
        indexMiddleOnly,
        allExtended,
        indexTip: toPx(landmarks[LANDMARK.INDEX_TIP]),
        // Normalized (0..1) midpoint, used for swipe distance so
        // UNDO_SWIPE_MIN_DISTANCE means the same fraction of frame width
        // regardless of output resolution.
        swipeX:
          (landmarks[LANDMARK.INDEX_TIP].x + landmarks[LANDMARK.MIDDLE_TIP].x) /
          2,
      };
    });

    // Both-hands clear-all takes priority over per-hand eraser so two open
    // palms don't spend 300ms erasing before the 2s clear-all also fires.
    const openPalmHands = classified.filter((h) => h.allExtended);
    if (openPalmHands.length >= 2) {
      if (this.bothPalmsSince == null) this.bothPalmsSince = nowMs;
      if (nowMs - this.bothPalmsSince >= CONFIG.CLEAR_ALL_HOLD_MS) {
        events.clearAll = true;
        this.bothPalmsSince = null; // reset so it fires once, requires releasing and re-holding to fire again
      }
    } else {
      this.bothPalmsSince = null;
    }
    const suppressSingleHandEraser = openPalmHands.length >= 2;

    const outHands = classified.map((h) => {
      const { state } = h;

      if (h.pinching) {
        state.openPalmSince = null;
        state.eraserActive = false;
        return { handedness: h.handedness, gesture: "pen", point: h.indexTip };
      }

      if (h.allExtended) {
        if (state.openPalmSince == null) state.openPalmSince = nowMs;
        const dwellElapsed = nowMs - state.openPalmSince;
        state.eraserActive =
          !suppressSingleHandEraser && dwellElapsed >= CONFIG.ERASER_DWELL_MS;
        return {
          handedness: h.handedness,
          gesture: state.eraserActive ? "eraser" : "openPalm",
          hullLandmarks: h.landmarks, // canvas.js builds the convex hull from these
        };
      }
      state.openPalmSince = null;
      state.eraserActive = false;

      if (h.indexMiddleOnly) {
        this._trackSwipe(h.state, h.swipeX, nowMs, events);
        return { handedness: h.handedness, gesture: "hover", point: h.indexTip };
      }

      h.state.swipeHistory = [];
      return { handedness: h.handedness, gesture: "idle" };
    });

    return { hands: outHands, events };
  }

  _trackSwipe(state, x, nowMs, events) {
    state.swipeHistory.push({ x, t: nowMs });
    const cutoff = nowMs - CONFIG.UNDO_SWIPE_MAX_MS;
    state.swipeHistory = state.swipeHistory.filter((p) => p.t >= cutoff);
    if (state.swipeHistory.length < 2) return;
    if (nowMs - state.lastSwipeFiredAt < CONFIG.UNDO_SWIPE_COOLDOWN_MS) return;

    const first = state.swipeHistory[0];
    const dx = x - first.x;
    const travel = dx * CONFIG.UNDO_SWIPE_DIRECTION_SIGN;
    if (-travel >= CONFIG.UNDO_SWIPE_MIN_DISTANCE) {
      events.undo = true;
      state.lastSwipeFiredAt = nowMs;
      state.swipeHistory = [];
    }
  }
}
