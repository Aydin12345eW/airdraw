// AirDraw — small draggable on-page status overlay (current gesture +
// color), so there's feedback without opening the popup. This lives in the
// real page DOM, outside the canvas, so it is never part of the outgoing
// video — only the local user sees it.

import { CONFIG } from "./config.js";

const GESTURE_LABELS = {
  pen: "✏️ Drawing",
  hover: "☝️ Hover",
  eraser: "🖐️ Erasing",
  openPalm: "🖐️ Hold to erase…",
  idle: "Ready",
  off: "Off",
};

export function createOverlay() {
  const host = document.createElement("div");
  host.style.all = "initial";
  host.style.position = "fixed";
  host.style.top = CONFIG.OVERLAY_DEFAULT_POSITION.top + "px";
  host.style.right = CONFIG.OVERLAY_DEFAULT_POSITION.right + "px";
  host.style.zIndex = "2147483647";
  const shadow = host.attachShadow({ mode: "open" });

  shadow.innerHTML = `
    <style>
      .panel {
        display: flex;
        align-items: center;
        gap: 8px;
        font: 600 12px/1.2 system-ui, sans-serif;
        color: #fff;
        background: rgba(20, 20, 20, 0.78);
        border: 1px solid rgba(255, 255, 255, 0.25);
        border-radius: 10px;
        padding: 6px 10px;
        cursor: move;
        user-select: none;
        backdrop-filter: blur(4px);
      }
      .swatch {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        border: 1px solid rgba(255, 255, 255, 0.6);
        flex: none;
      }
      .label { white-space: nowrap; }
    </style>
    <div class="panel" part="panel">
      <span class="swatch"></span>
      <span class="label">AirDraw</span>
    </div>
  `;

  document.documentElement.appendChild(host);

  const panel = shadow.querySelector(".panel");
  const swatch = shadow.querySelector(".swatch");
  const label = shadow.querySelector(".label");

  // Simple drag-to-reposition, anchored by top/right so it stays clear of
  // the video controls dock at the bottom of Meet/Teams by default.
  let dragging = false;
  let startX, startY, startTop, startRight;
  panel.addEventListener("pointerdown", (e) => {
    dragging = true;
    panel.setPointerCapture(e.pointerId);
    startX = e.clientX;
    startY = e.clientY;
    startTop = parseFloat(host.style.top);
    startRight = parseFloat(host.style.right);
  });
  panel.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    host.style.top = Math.max(0, startTop + (e.clientY - startY)) + "px";
    host.style.right =
      Math.max(0, startRight - (e.clientX - startX)) + "px";
  });
  panel.addEventListener("pointerup", (e) => {
    dragging = false;
    panel.releasePointerCapture(e.pointerId);
  });

  return {
    update({ enabled, gesture, color }) {
      label.textContent = enabled
        ? GESTURE_LABELS[gesture] || gesture
        : GESTURE_LABELS.off;
      swatch.style.background = color || "transparent";
      swatch.style.opacity = enabled ? "1" : "0.3";
    },
    destroy() {
      host.remove();
    },
  };
}
