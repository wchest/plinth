'use strict';

/**
 * Plinth Wix Bridge — ISOLATED world
 *
 * Polls the relay for pending commands and forwards them to the MAIN world
 * content script via postMessage. Receives results back and posts to the relay.
 *
 * Same pattern as the Webflow bridge, adapted for Wix editor URLs.
 */

(function () {
  const RELAY_URL = 'http://localhost:3847';
  const POLL_INTERVAL = 2000;
  const TAG = '[plinth-wix-isolated]';

  let siteId = null;
  let polling = false;

  // -- Site ID discovery --------------------------------------------------

  function discoverSiteId() {
    // Wix Studio URL: editor.wix.com/studio/<editorSessionId>?metaSiteId=<metaSiteId>
    const url = new URL(window.location.href);
    const metaSiteId = url.searchParams.get('metaSiteId');
    if (metaSiteId) return metaSiteId;

    // Fallback: extract from path
    const match = url.pathname.match(/\/studio\/([a-f0-9-]+)/);
    if (match) return match[1];

    return null;
  }

  // -- Relay communication ------------------------------------------------

  async function pollRelay() {
    if (!siteId || polling) return;
    polling = true;

    try {
      const res = await fetch(`${RELAY_URL}/bridge/pending?siteId=${encodeURIComponent(siteId)}`);
      if (!res.ok) { polling = false; return; }

      const data = await res.json();
      if (!data.pending) { polling = false; return; }

      console.log(`${TAG} Command received: ${data.type} (${data.id})`);

      // Forward to MAIN world
      window.postMessage({
        __plinthWixBridge: true,
        direction: 'to-main',
        command: {
          id: data.id,
          type: data.type,
          payload: data.payload || {},
        },
      }, '*');
    } catch (e) {
      // Relay not running — silently continue
    }

    polling = false;
  }

  async function postResult(result) {
    if (!siteId) return;

    try {
      await fetch(`${RELAY_URL}/bridge/result?siteId=${encodeURIComponent(siteId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result),
      });
    } catch (e) {
      console.error(`${TAG} Failed to post result:`, e.message);
    }
  }

  // -- Message listener (results from MAIN world) -------------------------

  window.addEventListener('message', (event) => {
    if (!event.data || !event.data.__plinthWixBridge) return;
    if (event.data.direction !== 'to-isolated') return;

    const { result } = event.data;
    if (result) {
      console.log(`${TAG} Result received, posting to relay`);
      postResult(result);
    }
  });

  // -- Startup ------------------------------------------------------------

  function start() {
    siteId = discoverSiteId();
    if (!siteId) {
      console.warn(`${TAG} Could not determine site ID from URL`);
      // Retry after the page settles
      setTimeout(() => {
        siteId = discoverSiteId();
        if (siteId) {
          console.log(`${TAG} Site ID discovered (retry): ${siteId.substring(0, 8)}…`);
          setInterval(pollRelay, POLL_INTERVAL);
        }
      }, 5000);
      return;
    }

    console.log(`${TAG} Site ID: ${siteId.substring(0, 8)}…`);
    setInterval(pollRelay, POLL_INTERVAL);
  }

  // Wait a moment for the editor to finish loading
  setTimeout(start, 3000);
})();
