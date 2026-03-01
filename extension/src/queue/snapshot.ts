/**
 * snapshot.ts
 *
 * Responds to MCP `get_page_dom` / `list_styles` requests by capturing
 * a live snapshot of the current page from the Webflow Designer API
 * and posting it to the relay server.
 *
 * Flow:
 *   1. Relay sets a "pending" flag when an MCP tool calls POST /snapshot/request
 *   2. The poller calls checkAndSendSnapshot() on each tick
 *   3. If pending: traverse the DOM, build a text summary, POST to relay
 *   4. MCP tool receives the snapshot and returns it to Claude
 */

const MAX_DEPTH        = 5;  // how deep to traverse the element tree
const MAX_CHILDREN     = 10; // max children to expand at each level (rest summarised)

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Check if the relay has a pending snapshot request for this site.
 * If so, capture the Designer DOM and send it to the relay.
 * Safe to call on every poller tick — exits immediately if no request pending.
 */
export async function checkAndSendSnapshot(
  siteId:   string,
  relayUrl: string,
): Promise<void> {
  try {
    const res = await fetch(
      `${relayUrl}/snapshot/pending?siteId=${encodeURIComponent(siteId)}`
    );
    if (!res.ok) return;
    const { pending } = (await res.json()) as { pending: boolean };
    if (!pending) return;

    // Capture and send
    const payload = await captureSnapshot();
    await fetch(
      `${relayUrl}/snapshot?siteId=${encodeURIComponent(siteId)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );
  } catch (err) {
    console.warn(
      '[snapshot] Error:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ── Internals ────────────────────────────────────────────────────────────────

interface SnapshotPayload {
  summary:  string;
  pageInfo: { name: string; id: string } | null;
}

async function captureSnapshot(): Promise<SnapshotPayload> {
  // ── Page info ────────────────────────────────────────────────────
  let pageInfo: { name: string; id: string } | null = null;
  try {
    const page = await webflow.getCurrentPage();
    if (page) {
      pageInfo = { name: await page.getName(), id: page.id };
    }
  } catch { /* non-fatal */ }

  // ── All elements (one call) + all styles (one call + batched names) ──
  const [allElements, allStyles] = await Promise.all([
    webflow.getAllElements().catch(() => [] as AnyElement[]),
    webflow.getAllStyles().catch(() => [] as Style[]),
  ]);

  const styleNames = new Map<string, string>();
  try {
    const names = await Promise.all(allStyles.map((s) => s.getName()));
    allStyles.forEach((s, i) => styleNames.set(s.id, names[i]));
  } catch { /* proceed without style names */ }

  // ── Get styles for every element in parallel ─────────────────────
  const elementStyles = await Promise.all(
    allElements.map(async (el) => {
      if (!('styles' in el) || el.styles !== true) return [];
      try {
        const applied = await (el as any).getStyles() as Array<{ id: string } | null> | null;
        if (!applied) return [];
        return applied
          .filter(Boolean)
          .map((s: { id: string }) => styleNames.get(s.id) ?? s.id)
          .filter(Boolean) as string[];
      } catch { return []; }
    })
  );

  // ── Build flat summary (type + id + classes per element) ─────────
  const lines: string[] = [];
  allElements.forEach((el, i) => {
    const type    = el.type || '?';
    const id      = el.id?.element ? `#${el.id.element}` : '';
    const classes = elementStyles[i].length ? ' .' + elementStyles[i].join('.') : '';
    lines.push(`${type}${id}${classes}`);
  });

  // ── Append site-wide style list ──────────────────────────────────
  if (styleNames.size > 0) {
    lines.push('');
    lines.push('── Site styles ──────────────────────');
    lines.push([...styleNames.values()].sort().join(', '));
  }

  return { summary: lines.join('\n'), pageInfo };
}
