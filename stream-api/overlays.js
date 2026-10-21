'use strict';
// The product's generic OBS overlays: each a transparent 1920×1080 browser
// source driven by the frames stream-api already broadcasts on the public WS, served beside
// /overlay/poll (poll.js) and /overlay/sticker (money.js) with the same headers (overlay-page.js).
//   /overlay/alert        showAlert                                  overlay-alert.html
//   /overlay/support-bar  timerState · updateSupportBar · resetSupportBar  overlay-support-bar.html
//   /overlay/meter        meterState (the support meter module)      overlay-meter.html
//   /overlay/bubble       showSupportBubble (lifecycle.js, while live)  overlay-bubble.html
// Public like the other two: OBS loads them with no credentials, and they render only what the
// public socket already carries. Their look is neutral on purpose; per-install styling comes later.

const path = require('path');
const { sendOverlayPage } = require('./overlay-page');

const send = (res, file) => sendOverlayPage(res, path.join(__dirname, file));

/** One literal route per page, the handler inline: the route-surface scan reads
 *  `app.get('<path>', <middleware>…` and must see each page — and see it as PUBLIC, which a named
 *  handler factory in the middleware position would hide. */
function registerOverlayRoutes(app) {
  app.get('/overlay/alert', (_req, res) => send(res, 'overlay-alert.html'));
  app.get('/overlay/support-bar', (_req, res) => send(res, 'overlay-support-bar.html'));
  app.get('/overlay/meter', (_req, res) => send(res, 'overlay-meter.html'));
  app.get('/overlay/bubble', (_req, res) => send(res, 'overlay-bubble.html'));
}

module.exports = { registerOverlayRoutes };
