// AirDraw content script — isolated world, runs at document_start.
//
// The getUserMedia patch MUST live in the page's main world: Meet/Teams call
// navigator.mediaDevices.getUserMedia directly from their own page scripts,
// and an isolated-world override is invisible to that call. So this script's
// only job is to inject inject.js as a real <script> tag before any call
// site in the page has a chance to run.

(function injectAirDrawPageScript() {
  const scriptEl = document.createElement("script");
  scriptEl.src = chrome.runtime.getURL("src/inject.js");
  scriptEl.async = false; // preserve execution order relative to inline page scripts appended after it

  const target = document.documentElement || document.head || document;
  target.appendChild(scriptEl);

  // No need to keep the tag around once it has executed.
  scriptEl.addEventListener("load", () => scriptEl.remove());
})();
