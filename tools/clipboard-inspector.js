/**
 * clipboard-inspector.js
 *
 * Run this in the Webflow Designer browser console (F12 → Console).
 *
 * Step 1: Paste this script into the console and press Enter.
 * Step 2: Select any element on the Webflow canvas.
 * Step 3: Press Ctrl+C (or Cmd+C) to copy it.
 * Step 4: Check the console output — it will show every clipboard type
 *         and its raw content so we can reverse-engineer the format.
 *
 * This does NOT interfere with normal Webflow paste (Ctrl+V still works).
 */

(function installClipboardInspector() {
  // ── Capture what Webflow writes to the clipboard on Ctrl+C ───────────────
  document.addEventListener('copy', async function onCopy(e) {
    console.group('%c[Plinth Clipboard Inspector] copy event', 'color: #0057ff; font-weight: bold');

    // 1. Synchronous clipboard data (available on the event)
    const syncTypes = Array.from(e.clipboardData?.types ?? []);
    if (syncTypes.length) {
      console.log('Sync clipboard types:', syncTypes);
      for (const type of syncTypes) {
        const data = e.clipboardData.getData(type);
        console.group(`  sync: ${type} (${data.length} chars)`);
        try   { console.log(JSON.parse(data)); }
        catch { console.log(data.slice(0, 4000)); }
        console.groupEnd();
      }
    } else {
      console.log('No sync clipboard data on event — trying async API…');
    }

    // 2. Async Clipboard API (may have richer data after a tick)
    try {
      await new Promise(r => setTimeout(r, 50)); // let Webflow finish writing
      const items = await navigator.clipboard.read();
      console.log(`Async clipboard items: ${items.length}`);
      for (const item of items) {
        console.log('  item types:', item.types);
        for (const type of item.types) {
          try {
            const blob = await item.getType(type);
            const text = await blob.text();
            console.group(`  async: ${type} (${text.length} chars)`);
            try   { console.log(JSON.parse(text)); }
            catch { console.log(text.slice(0, 4000)); }
            console.groupEnd();
          } catch (err) {
            console.warn(`  async: ${type} — read error:`, err.message);
          }
        }
      }
    } catch (err) {
      console.warn('Async clipboard API unavailable:', err.message);
    }

    console.groupEnd();
  }, true /* capture phase, before Webflow can preventDefault */);

  // ── Also log what's on the clipboard when you paste (Ctrl+V) ────────────
  document.addEventListener('paste', function onPaste(e) {
    console.group('%c[Plinth Clipboard Inspector] paste event', 'color: #c0392b; font-weight: bold');
    const types = Array.from(e.clipboardData?.types ?? []);
    console.log('Paste clipboard types:', types);
    for (const type of types) {
      const data = e.clipboardData.getData(type);
      console.group(`  ${type} (${data.length} chars)`);
      try   { console.log(JSON.parse(data)); }
      catch { console.log(data.slice(0, 4000)); }
      console.groupEnd();
    }
    console.groupEnd();
    // Do NOT call preventDefault — let Webflow paste normally
  }, true);

  console.log('%c[Plinth Clipboard Inspector] installed ✓', 'color: #27ae60; font-weight: bold');
  console.log('Now: select an element in Webflow → Ctrl+C → see the format above.');
})();
