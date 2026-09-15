// AirDraw — every hand-tunable threshold lives here, and nowhere else.
// Landmark indices referenced in comments follow the standard MediaPipe
// Hands 21-point layout: 0 wrist, 1-4 thumb, 5-8 index, 9-12 middle,
// 13-16 ring, 17-20 pinky (each finger: MCP, PIP, DIP, TIP).

export const CONFIG = {
  // ---------------------------------------------------------------------
  // Tracking input resolution
  // ---------------------------------------------------------------------
  // The camera frame is downscaled to this size before being fed to
  // HandLandmarker, purely for inference speed. Landmarks come back
  // normalized (0..1) so they map straight onto the full-res output
  // canvas regardless of this size.
  TRACKING_WIDTH: 480,
  TRACKING_HEIGHT: 270,

  // ---------------------------------------------------------------------
  // HandLandmarker model options
  // ---------------------------------------------------------------------
  MAX_NUM_HANDS: 2,
  MIN_HAND_DETECTION_CONFIDENCE: 0.5,
  MIN_HAND_PRESENCE_CONFIDENCE: 0.5,
  MIN_TRACKING_CONFIDENCE: 0.5,

  // ---------------------------------------------------------------------
  // One Euro filter (landmark smoothing)
  // ---------------------------------------------------------------------
  // A moving average lags behind fast pen motion and ruins handwriting; the
  // One Euro filter instead adapts: slow motion gets heavy smoothing (less
  // jitter while hovering), fast motion gets little smoothing (less lag
  // while writing quickly). Tune MIN_CUTOFF for jitter-at-rest, BETA for
  // lag-during-fast-motion.
  ONE_EURO_MIN_CUTOFF: 1.0, // lower = smoother when the hand is nearly still, but more jitter shows up as this drops too low
  ONE_EURO_BETA: 12.0, // higher = less lag on fast strokes, but more jitter creeps in during fast motion
  ONE_EURO_D_CUTOFF: 1.0, // cutoff for the derivative estimate used internally by the filter

  // ---------------------------------------------------------------------
  // Pinch ("pen") gesture — thumb tip (4) to index tip (8)
  // ---------------------------------------------------------------------
  // Distances are normalized by the hand's own size (wrist(0) to middle-
  // MCP(9) distance) so the pinch still registers correctly whether the
  // hand is close to or far from the camera.
  PINCH_DOWN_RATIO: 0.35, // thumb-index distance / hand size below which the pen goes DOWN
  PINCH_UP_RATIO: 0.5, // must re-open past this LARGER ratio before the pen lifts — hysteresis gap avoids flicker mid-letter

  // ---------------------------------------------------------------------
  // Finger extension test (shared by hover / open-palm / eraser)
  // ---------------------------------------------------------------------
  // extension(finger) = distance(wrist, tip) / distance(wrist, mcp).
  // A curled finger's tip sits close to its own MCP-to-wrist line, so this
  // ratio drops toward ~1; a fully extended finger pushes it well above 1.
  FINGER_EXTENDED_RATIO: 1.2, // ratio above which a finger counts as "extended"

  // ---------------------------------------------------------------------
  // Eraser (flat open palm, all five fingers extended)
  // ---------------------------------------------------------------------
  ERASER_DWELL_MS: 300, // open palm must be held this long before erasing starts — avoids wiping strokes just from talking with an open hand

  // ---------------------------------------------------------------------
  // Two-finger swipe = undo (index + middle extended, ring + pinky curled)
  // ---------------------------------------------------------------------
  UNDO_SWIPE_MIN_DISTANCE: 0.18, // required normalized horizontal travel of the index/middle midpoint
  UNDO_SWIPE_MAX_MS: 450, // the travel above must happen within this window to count as a swipe, not a slow drift
  UNDO_SWIPE_COOLDOWN_MS: 800, // ignore further swipes for this long after one fires, so a single swipe doesn't undo multiple strokes
  // Sign of the swipe direction that counts as "left" in raw (unmirrored)
  // camera coordinates. Flip this to -1 if testing shows it fires on the
  // wrong direction for your camera setup.
  UNDO_SWIPE_DIRECTION_SIGN: 1,

  // ---------------------------------------------------------------------
  // Both open palms held = clear all
  // ---------------------------------------------------------------------
  CLEAR_ALL_HOLD_MS: 2000,

  // ---------------------------------------------------------------------
  // Stroke rendering
  // ---------------------------------------------------------------------
  STROKE_WIDTH_BASE_PX: 12, // default stroke width, defined at the reference resolution below
  STROKE_WIDTH_REFERENCE_HEIGHT: 720, // actual stroke width scales as canvas.height / this value
  STROKE_OUTLINE_EXTRA_PX: 4, // the dark outline pass is this many px wider than the color pass, so strokes stay legible on any background
  STROKE_OUTLINE_COLOR: "#000000",
  PALETTE: ["#FFEB3B", "#F44336", "#00E5FF", "#FFFFFF", "#000000"], // yellow, red, cyan, white, black
  DEFAULT_COLOR_INDEX: 0, // yellow — highest-contrast default in a small video tile

  // ---------------------------------------------------------------------
  // Shape snap
  // ---------------------------------------------------------------------
  SNAP_ENABLED_DEFAULT: true,
  SNAP_MIN_SPAN_FRACTION: 0.25, // strokes whose bounding box is smaller than this fraction of canvas width are left completely untouched — protects handwriting
  SNAP_LINE_MAX_DEVIATION_RATIO: 0.06, // max perpendicular deviation from a straight chord, as a fraction of the chord length, to accept a line/arrow fit
  SNAP_ARROW_TAIL_FRACTION: 0.35, // fraction of the stroke's path length (from the end) searched for the direction-reversal that indicates an arrowhead flick
  SNAP_ARROW_REVERSAL_ANGLE_DEG: 90, // minimum direction change, in degrees, within that tail window to count as an arrowhead reversal
  SNAP_CIRCLE_MAX_DEVIATION_RATIO: 0.14, // max deviation of points from the fitted circle's radius, as a fraction of that radius
  SNAP_CLOSURE_MAX_RATIO: 0.35, // shared by circle + rectangle fits: start/end points must be within this fraction of the shape's own size of each other to count as a closed loop
  SNAP_RECT_MAX_DEVIATION_RATIO: 0.09, // max deviation of points from the nearest bbox edge, as a fraction of the bbox diagonal
  SNAP_ANIMATION_MS: 150, // snap animates from the hand-drawn path to the fitted shape over this long, instead of popping

  // ---------------------------------------------------------------------
  // Performance
  // ---------------------------------------------------------------------
  TARGET_FPS: 30, // canvas output framerate — this must never drop, even if tracking does
  TRACKING_SLOW_FRAME_MS: 20, // if a single detectForVideo call exceeds this, drop to tracking every 2nd frame
  TRACKING_RECOVER_FRAME_MS: 12, // once inference is consistently under this, go back to tracking every frame

  // ---------------------------------------------------------------------
  // On-page status overlay
  // ---------------------------------------------------------------------
  OVERLAY_DEFAULT_POSITION: { right: 16, top: 16 },
};

// Landmark index constants, exported alongside CONFIG for readability at
// call sites (gestures.js, canvas.js).
export const LANDMARK = {
  WRIST: 0,
  THUMB_MCP: 2,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_TIP: 20,
};
