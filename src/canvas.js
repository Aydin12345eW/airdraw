// AirDraw — stroke model, eraser convex-hull splitting, and shape snap.
//
// Strokes are plain point-list polylines in canvas pixel space. Shape snap
// never mutates the original points destructively without a fallback: it
// records them under `raw` and animates the rendered points from `raw`
// toward the fitted shape over CONFIG.SNAP_ANIMATION_MS.

import { CONFIG } from "./config.js";

let nextStrokeId = 1;

export function createStroke(color, width) {
  return {
    id: nextStrokeId++,
    color,
    width,
    points: [], // {x, y} in canvas pixel space, live/raw points
    snap: null, // set on pen-up if a shape match is found: {type, raw, target, startTime, duration}
  };
}

export function addPoint(stroke, x, y) {
  const last = stroke.points[stroke.points.length - 1];
  if (last && last.x === x && last.y === y) return;
  stroke.points.push({ x, y });
}

// ---------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------
function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pathLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += dist(points[i - 1], points[i]);
  return len;
}

function boundingBox(points) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

// Perpendicular distance from point p to the infinite line through a-b.
function perpDistance(p, a, b) {
  const len = dist(a, b) || 1e-6;
  return Math.abs(
    (b.y - a.y) * p.x - (b.x - a.x) * p.y + b.x * a.y - b.y * a.x
  ) / len;
}

// Resample a polyline to exactly n points evenly spaced by arc length —
// used so the hand-drawn path and its snapped target can be lerped point
// for point during the snap animation, whatever shape each one is.
function resamplePath(points, n) {
  const total = pathLength(points);
  if (total === 0 || points.length === 1) {
    return new Array(n).fill(points[0] || { x: 0, y: 0 });
  }
  const step = total / (n - 1);
  const out = [points[0]];
  let segIdx = 0;
  let segStart = points[0];
  let segEnd = points[1];
  let segLen = dist(segStart, segEnd);
  let accumulated = 0;

  for (let i = 1; i < n - 1; i++) {
    const targetDist = step * i;
    while (accumulated + segLen < targetDist && segIdx < points.length - 2) {
      accumulated += segLen;
      segIdx++;
      segStart = points[segIdx];
      segEnd = points[segIdx + 1];
      segLen = dist(segStart, segEnd) || 1e-6;
    }
    const remain = targetDist - accumulated;
    const t = Math.min(1, remain / (segLen || 1e-6));
    out.push({
      x: segStart.x + (segEnd.x - segStart.x) * t,
      y: segStart.y + (segEnd.y - segStart.y) * t,
    });
  }
  out.push(points[points.length - 1]);
  return out;
}

// ---------------------------------------------------------------------
// Shape classification (called once, on pen-up)
// ---------------------------------------------------------------------
function tryFitCircle(points) {
  // Kasa least-squares circle fit.
  let sumX = 0,
    sumY = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
  }
  const n = points.length;
  const meanX = sumX / n;
  const meanY = sumY / n;

  let suu = 0,
    svv = 0,
    suv = 0,
    suuu = 0,
    svvv = 0,
    suvv = 0,
    svuu = 0;
  for (const p of points) {
    const u = p.x - meanX;
    const v = p.y - meanY;
    suu += u * u;
    svv += v * v;
    suv += u * v;
    suuu += u * u * u;
    svvv += v * v * v;
    suvv += u * v * v;
    svuu += v * u * u;
  }
  const denom = 2 * (suu * svv - suv * suv);
  if (Math.abs(denom) < 1e-9) return null;
  const uc = (svv * (suuu + suvv) - suv * (svvv + svuu)) / denom;
  const vc = (suu * (svvv + svuu) - suv * (suuu + suvv)) / denom;
  const cx = uc + meanX;
  const cy = vc + meanY;
  const radius =
    points.reduce((sum, p) => sum + dist(p, { x: cx, y: cy }), 0) / n;

  const maxDev = Math.max(
    ...points.map((p) => Math.abs(dist(p, { x: cx, y: cy }) - radius))
  );
  const closure = dist(points[0], points[points.length - 1]);

  if (
    maxDev / radius <= CONFIG.SNAP_CIRCLE_MAX_DEVIATION_RATIO &&
    closure / radius <= CONFIG.SNAP_CLOSURE_MAX_RATIO
  ) {
    const target = [];
    const steps = 48;
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      target.push({ x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius });
    }
    return { type: "circle", target };
  }
  return null;
}

function tryFitRectangle(points, bbox) {
  const diag = Math.hypot(bbox.w, bbox.h) || 1e-6;
  const closure = dist(points[0], points[points.length - 1]);
  if (closure / diag > CONFIG.SNAP_CLOSURE_MAX_RATIO) return null;

  const distToEdge = (p) =>
    Math.min(
      Math.abs(p.x - bbox.minX),
      Math.abs(p.x - bbox.maxX),
      Math.abs(p.y - bbox.minY),
      Math.abs(p.y - bbox.maxY)
    );
  const maxDev = Math.max(...points.map(distToEdge));
  if (maxDev / diag > CONFIG.SNAP_RECT_MAX_DEVIATION_RATIO) return null;

  const corners = [
    { x: bbox.minX, y: bbox.minY },
    { x: bbox.maxX, y: bbox.minY },
    { x: bbox.maxX, y: bbox.maxY },
    { x: bbox.minX, y: bbox.maxY },
    { x: bbox.minX, y: bbox.minY },
  ];
  return { type: "rectangle", target: corners };
}

// Line/arrow: check overall straightness against the start->end chord,
// then look for a sharp direction reversal near the tail (the "flick
// back" that turns a straight stroke into an arrow).
function tryFitLineOrArrow(points) {
  const start = points[0];
  const end = points[points.length - 1];
  const chordLen = dist(start, end);
  if (chordLen < 1e-6) return null;

  // A stroke that isn't straight enough for a plain line may still be an
  // arrow — the tail flick itself is what breaks straightness — so fall
  // through to the reversal search below rather than returning early.
  const maxDev = Math.max(...points.map((p) => perpDistance(p, start, end)));

  const total = pathLength(points);
  const tailStart = total * (1 - CONFIG.SNAP_ARROW_TAIL_FRACTION);
  let accumulated = 0;
  let reversalIdx = -1;
  let bestAngle = 0;

  for (let i = 1; i < points.length - 1; i++) {
    accumulated += dist(points[i - 1], points[i]);
    if (accumulated < tailStart) continue;

    const inVec = {
      x: points[i].x - points[i - 1].x,
      y: points[i].y - points[i - 1].y,
    };
    const outVec = {
      x: points[points.length - 1].x - points[i].x,
      y: points[points.length - 1].y - points[i].y,
    };
    const inLen = Math.hypot(inVec.x, inVec.y) || 1e-6;
    const outLen = Math.hypot(outVec.x, outVec.y) || 1e-6;
    const cos = Math.max(
      -1,
      Math.min(1, (inVec.x * outVec.x + inVec.y * outVec.y) / (inLen * outLen))
    );
    const angleDeg = (Math.acos(cos) * 180) / Math.PI;
    if (angleDeg > bestAngle) {
      bestAngle = angleDeg;
      reversalIdx = i;
    }
  }

  if (bestAngle >= CONFIG.SNAP_ARROW_REVERSAL_ANGLE_DEG && reversalIdx > 0) {
    // Arrow: shaft from start to the reversal point (the visual tip),
    // with a rendered arrowhead there pointing back along the shaft.
    const tip = points[reversalIdx];
    const shaftDev = Math.max(
      ...points
        .slice(0, reversalIdx + 1)
        .map((p) => perpDistance(p, start, tip))
    );
    const shaftLen = dist(start, tip) || 1e-6;
    if (shaftDev / shaftLen <= CONFIG.SNAP_LINE_MAX_DEVIATION_RATIO * 1.5) {
      return { type: "arrow", target: [start, tip] };
    }
  }

  if (maxDev / chordLen <= CONFIG.SNAP_LINE_MAX_DEVIATION_RATIO) {
    return { type: "line", target: [start, end] };
  }
  return null;
}

/**
 * Called once when a stroke is finished (pen-up). Mutates `stroke` in
 * place, adding a `snap` animation descriptor if a shape matched.
 */
export function trySnapStroke(stroke, canvasWidth, snapEnabled) {
  if (!snapEnabled || stroke.points.length < 4) return;

  const bbox = boundingBox(stroke.points);
  const span = Math.max(bbox.w, bbox.h);
  if (span < CONFIG.SNAP_MIN_SPAN_FRACTION * canvasWidth) return; // protects handwriting

  const fit =
    tryFitRectangle(stroke.points, bbox) ||
    tryFitCircle(stroke.points) ||
    tryFitLineOrArrow(stroke.points);
  if (!fit) return;

  const sampleCount = 48;
  stroke.snap = {
    type: fit.type,
    raw: resamplePath(stroke.points, sampleCount),
    target: resamplePath(fit.target, sampleCount),
    startTime: performance.now(),
    duration: CONFIG.SNAP_ANIMATION_MS,
  };
}

/**
 * Returns the points to actually render for this stroke right now:
 * mid-animation interpolation between the hand-drawn path and the fitted
 * shape, or just the raw points if there is no snap (or it has finished).
 */
export function getRenderPoints(stroke, nowMs) {
  if (!stroke.snap) return stroke.points;
  const { raw, target, startTime, duration } = stroke.snap;
  const t = Math.min(1, (nowMs - startTime) / duration);
  const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
  return raw.map((p, i) => ({
    x: p.x + (target[i].x - p.x) * eased,
    y: p.y + (target[i].y - p.y) * eased,
  }));
}

export function isSnapAnimating(stroke, nowMs) {
  return !!stroke.snap && nowMs - stroke.snap.startTime < stroke.snap.duration;
}

// ---------------------------------------------------------------------
// Eraser: convex hull + polyline splitting
// ---------------------------------------------------------------------

// Andrew's monotone chain convex hull.
export function convexHull(points) {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;

  const cross = (o, a, b) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower = [];
  for (const p of pts) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0
    ) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0
    ) {
      upper.pop();
    }
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x,
      yi = poly[i].y;
    const xj = poly[j].x,
      yj = poly[j].y;
    const intersects =
      yi > p.y !== yj > p.y &&
      p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Removes any points of `strokes` that fall inside the eraser hull,
 * splitting a stroke into multiple strokes at the removed gaps rather than
 * deleting the whole stroke.
 */
export function eraseInsideHull(strokes, hullPoints) {
  if (hullPoints.length < 3) return strokes;
  const hull = convexHull(hullPoints);
  const result = [];

  for (const stroke of strokes) {
    const inside = stroke.points.map((p) => pointInPolygon(p, hull));
    if (!inside.some(Boolean)) {
      result.push(stroke); // nothing removed — keep identity, snap state, everything
      continue;
    }

    let current = [];
    const flush = () => {
      if (current.length >= 2) {
        const piece = createStroke(stroke.color, stroke.width);
        piece.points = current;
        result.push(piece);
      }
      current = [];
    };
    stroke.points.forEach((p, i) => {
      if (inside[i]) flush();
      else current.push(p);
    });
    flush();
  }
  return result;
}
