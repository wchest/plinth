// Plinth Bridge — ISOLATED world content script
// Polls the relay for pending commands, forwards them to MAIN world via postMessage,
// and posts results back to the relay. Runs in the ISOLATED world so it can fetch() localhost.

(function () {
  'use strict';

  if (window.__plinthBridgeIsolated) return;
  window.__plinthBridgeIsolated = true;

  var RELAY_BASE = 'http://localhost:3847';
  var POLL_INTERVAL_MS = 2000;
  var DISCOVERY_RETRY_MS = 5000;

  var siteId = null;
  var pollTimer = null;
  var pendingResults = {}; // id -> true (commands awaiting results)

  console.log('[plinth-bridge] ISOLATED content script loaded');

  // -- SiteId discovery via /health ----------------------------------------

  function discoverSiteId() {
    fetch(RELAY_BASE + '/health')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        // data is an array of { siteId, name, ... } or a single site object
        var sites = Array.isArray(data) ? data : (data.sites || []);
        if (sites.length > 0 && sites[0].siteId) {
          siteId = sites[0].siteId;
          console.log('[plinth-bridge] Discovered siteId:', siteId);
          startPolling();
        } else {
          console.warn('[plinth-bridge] No sites found in /health response, retrying...');
          setTimeout(discoverSiteId, DISCOVERY_RETRY_MS);
        }
      })
      .catch(function () {
        // Relay not running yet — retry
        setTimeout(discoverSiteId, DISCOVERY_RETRY_MS);
      });
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

    var id = msg.id;

    // Only forward results for commands we dispatched
    if (!pendingResults[id]) return;
    delete pendingResults[id];

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
