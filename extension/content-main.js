// Plinth Inspector — MAIN world content script
// Monkey-patches window.postMessage to capture all Designer ↔ Extension JSON-RPC traffic
// into a ring buffer that the DevTools panel polls via inspectedWindow.eval()

(function () {
  'use strict';

  if (window.__plinthInspectorInstalled) return;
  window.__plinthInspectorInstalled = true;

  const MAX_BUFFER = 500;
  const buffer = [];
  window.__plinthInspectorBuffer = buffer;

  function safeClone(obj) {
    try {
      return JSON.parse(JSON.stringify(obj));
    } catch {
      return { __cloneError: true, type: typeof obj, str: String(obj).slice(0, 200) };
    }
  }

  function extractMethod(data) {
    if (!data || typeof data !== 'object') return null;
    if (data.method) return data.method;
    if (data.jsonrpc && data.method) return data.method;
    // Check for nested payload
    if (data.data && typeof data.data === 'object' && data.data.method) return data.data.method;
    return null;
  }

  function pushEntry(direction, data) {
    const method = extractMethod(data);
    const entry = {
      ts: Date.now(),
      dir: direction, // 'out' = page→ext, 'in' = ext→page
      method: method || '(unknown)',
      data: safeClone(data)
    };
    buffer.push(entry);
    if (buffer.length > MAX_BUFFER) {
      buffer.splice(0, buffer.length - MAX_BUFFER);
    }
  }

  // Patch postMessage to capture outgoing messages
  const origPostMessage = window.postMessage.bind(window);
  window.postMessage = function (message, targetOrigin, transfer) {
    pushEntry('out', message);
    return origPostMessage(message, targetOrigin, transfer);
  };

  // Listen for incoming messages
  window.addEventListener('message', function (event) {
    // Only capture messages from other frames (not our own outgoing ones echoed back)
    if (event.source !== window) {
      pushEntry('in', event.data);
    }
  });
})();
