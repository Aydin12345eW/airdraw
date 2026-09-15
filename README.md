# AirDraw

Draw in the air with your hand during Google Meet and Teams calls. Your drawings
are composited into the camera stream you send, so every participant sees them
with nothing installed on their end.

Hand tracking runs locally via MediaPipe — camera frames never leave your machine.

## Install (unpacked)

There is no build step; the repo loads as-is.

1. Clone or download this repo.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the folder containing `manifest.json`.
4. Join a Meet or Teams call and allow camera access.

Works in any Chromium browser (Chrome, Edge, Brave, Arc). Unpacked extensions
do not auto-update — pull and hit reload on the extensions page.

## Local demo

`demo.html` runs the real `src/` modules against your webcam outside of a call,
which is the fast way to iterate on tracking and gestures. ES modules and wasm
can't load over `file://`, so serve the repo root:

```
python3 -m http.server 8000
```

Then open <http://localhost:8000/demo.html>.

## Layout

| Path | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest |
| `rules.json` | declarativeNetRequest rules (see note below) |
| `src/content.js` | Isolated-world shim; injects `inject.js` into the page |
| `src/inject.js` | Main-world `getUserMedia` patch |
| `src/tracking.js` | MediaPipe hand landmark tracking |
| `src/gestures.js` | Landmark → pen up/down and tool gestures |
| `src/canvas.js` | Stroke model |
| `src/render.js` | Draws strokes into the outgoing frame |
| `src/overlay.js` | Local-only tracking overlay |
| `src/config.js` | Tunables |
| `vendor/mediapipe/` | Vendored MediaPipe runtime + hand landmark model (~30 MB) |

The `getUserMedia` patch has to run in the page's main world: Meet and Teams
call it from their own scripts, where an isolated-world override is invisible.
That is why `content.js` does nothing but inject a real `<script>` tag at
`document_start`.

## Known issue: CSP removal

`rules.json` strips `content-security-policy` response headers on the Meet and
Teams origins so the MediaPipe wasm and worker can load. This works, but it
weakens the security headers of sites you don't control and is likely to draw a
rejection or extended manual review if submitted to the Chrome Web Store.

The intended fix is to move tracking into a sandboxed extension page or an
offscreen document and pass frames over `postMessage`, so nothing governed by
the page's CSP ever loads — which would drop both this rule and the
`declarativeNetRequestWithHostAccess` permission.
