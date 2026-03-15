// Plinth Bridge — ISOLATED world content script
// Polls the relay for pending commands, forwards them to MAIN world via postMessage,
// and posts results back to the relay. Runs in the ISOLATED world so it can fetch() localhost.

(function () {
  'use strict';

  if (window.__plinthBridgeIsolated) return;
  window.__plinthBridgeIsolated = true;

  var RELAY_BASE = 'http://localhost:3847';
  var POLL_INTERVAL_MS = 2000;
  var DISCOVERY_RETRY_MS = 3000;

  var siteId = null;
  var pollTimer = null;
  var pendingResults = {}; // id -> true (commands awaiting results)
  var dispatchedIds = {};  // id -> true (commands already forwarded to MAIN)

  console.log('[plinth-bridge] ISOLATED content script loaded');

  // -- SiteId discovery ----------------------------------------------------
  // Ask the MAIN world content script for the siteId (it has access to _webflow).
  // Falls back to URL patterns if MAIN doesn't respond.

  var discoveryTimeout = null;

  function discoverSiteId() {
    // Try URL patterns first (instant, no round-trip)

    // Subdomain: <site-id>.design.webflow.com
    var subMatch = window.location.hostname.match(/^([a-f0-9]{24})\.design\.webflow\.com$/);
    if (subMatch) {
      siteId = subMatch[1];
      console.log('[plinth-bridge] Discovered siteId from subdomain:', siteId);
      startPolling();
      return;
    }

    // Path: webflow.com/design/<site-id>
    var pathMatch = window.location.pathname.match(/\/design\/([a-f0-9]{24})/);
    if (pathMatch) {
      siteId = pathMatch[1];
      console.log('[plinth-bridge] Discovered siteId from path:', siteId);
      startPolling();
      return;
    }

    // Ask MAIN world for the siteId
    console.log('[plinth-bridge] Requesting siteId from MAIN world...');
    window.postMessage({
      __plinthBridge: true,
      direction: 'command',
      id: '__discover_site_id',
      type: 'discover_site_id',
      payload: {},
    }, '*');

    // If MAIN doesn't respond within timeout, retry
    discoveryTimeout = setTimeout(function () {
      console.warn('[plinth-bridge] MAIN world did not respond with siteId, retrying...');
      discoverSiteId();
    }, DISCOVERY_RETRY_MS);
  }

  // -- Polling for pending commands ----------------------------------------

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(pollForCommands, POLL_INTERVAL_MS);
    pollForCommands(); // immediate first check
  }

  function pollForCommands() {
    if (!siteId) return;

    fetch(RELAY_BASE + '/bridge/pending?siteId=' + encodeURIComponent(siteId))
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.pending) return;

        var id = data.id;
        var type = data.type;
        var payload = data.payload || {};

        // Skip if we already dispatched this command (prevents re-dispatch on every poll)
        if (dispatchedIds[id]) return;
        dispatchedIds[id] = true;

        // Track this command so we know to forward its result
        pendingResults[id] = true;

        // Forward to MAIN world
        window.postMessage({
          __plinthBridge: true,
          direction: 'command',
          id: id,
          type: type,
          payload: payload,
        }, '*');
      })
      .catch(function () {
        // Relay went away — will retry on next interval
      });
  }

  // -- Listen for results from MAIN world ----------------------------------

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var msg = event.data;
    if (!msg || !msg.__plinthBridge || msg.direction !== 'result') return;

    // Handle siteId discovery response
    if (msg.id === '__discover_site_id') {
      if (discoveryTimeout) {
        clearTimeout(discoveryTimeout);
        discoveryTimeout = null;
      }
      if (msg.ok && msg.data && msg.data.siteId) {
        siteId = msg.data.siteId;
        console.log('[plinth-bridge] Discovered siteId from MAIN world:', siteId);
        startPolling();
      } else {
        console.warn('[plinth-bridge] MAIN world could not provide siteId, retrying...');
        setTimeout(discoverSiteId, DISCOVERY_RETRY_MS);
      }
      return;
    }

    var id = msg.id;

    // Only forward results for commands we dispatched
    if (!pendingResults[id]) return;
    delete pendingResults[id];
    delete dispatchedIds[id];

    // Post result back to relay
    fetch(RELAY_BASE + '/bridge/result?siteId=' + encodeURIComponent(siteId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: msg.id,
        ok: msg.ok,
        data: msg.data,
        error: msg.error,
      }),
    }).catch(function (err) {
      console.error('[plinth-bridge] Failed to post result:', err);
    });
  });

  // -- Start ---------------------------------------------------------------

  discoverSiteId();
})();
