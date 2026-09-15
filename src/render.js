// AirDraw — frame compositing: real (unmirrored) camera frame + strokes.
//
// Every stroke is drawn twice — a dark outline pass a few px wider,
// underneath a color pass — so strokes stay legible against any
// background, per the "legible in a small video tile" design priority.

import { CONFIG } from "./config.js";
import { getRenderPoints } from "./canvas.js";

function strokeWidthPx(stroke, canvasHeight) {
  return (stroke.width / CONFIG.STROKE_WIDTH_REFERENCE_HEIGHT) * canvasHeight;
}

function drawPolyline(ctx, points, width, color) {
  if (points.length < 2) {
    if (points.length === 1) {
      ctx.beginPath();
      ctx.arc(points[0].x, points[0].y, width / 2, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
    return;
  }
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.lineWidth = width;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = color;
  ctx.stroke();
}

function drawArrowhead(ctx, tip, direction, width, color) {
  const headLen = width * 2.2;
  const spread = (25 * Math.PI) / 180;
  const angle = Math.atan2(direction.y, direction.x);
  const left = {
    x: tip.x - headLen * Math.cos(angle - spread),
    y: tip.y - headLen * Math.sin(angle - spread),
  };
  const right = {
    x: tip.x - headLen * Math.cos(angle + spread),
    y: tip.y - headLen * Math.sin(angle + spread),
  };
  ctx.beginPath();
  ctx.moveTo(left.x, left.y);
  ctx.lineTo(tip.x, tip.y);
  ctx.lineTo(right.x, right.y);
  ctx.lineWidth = width;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = color;
  ctx.stroke();
}

export function drawStroke(stroke, ctx, canvasHeight, nowMs) {
  const points = getRenderPoints(stroke, nowMs);
  const width = strokeWidthPx(stroke, canvasHeight);
  const outlineWidth =
    width + (CONFIG.STROKE_OUTLINE_EXTRA_PX / 720) * canvasHeight;

  drawPolyline(ctx, points, outlineWidth, CONFIG.STROKE_OUTLINE_COLOR);
  drawPolyline(ctx, points, width, stroke.color);

  if (stroke.snap?.type === "arrow" && points.length >= 2) {
    const tip = points[points.length - 1];
    const prev = points[points.length - 2];
    const direction = { x: tip.x - prev.x, y: tip.y - prev.y };
    const len = Math.hypot(direction.x, direction.y) || 1;
    direction.x /= len;
    direction.y /= len;
    drawArrowhead(ctx, tip, direction, outlineWidth, CONFIG.STROKE_OUTLINE_COLOR);
    drawArrowhead(ctx, tip, direction, width, stroke.color);
  }
}

/**
 * Draws one full output frame: the real unmirrored camera frame, then
 * every completed stroke, then the in-progress stroke (if any).
 */
export function renderFrame(ctx, canvas, sourceVideo, strokes, activeStrokes, nowMs) {
  if (sourceVideo.readyState >= 2) {
    ctx.drawImage(sourceVideo, 0, 0, canvas.width, canvas.height);
  } else {
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  for (const stroke of strokes) drawStroke(stroke, ctx, canvas.height, nowMs);
  for (const stroke of activeStrokes) drawStroke(stroke, ctx, canvas.height, nowMs);
}
