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

  // ── Style name lookup map ────────────────────────────────────────
  // Fetch all site styles upfront so we can resolve IDs → names in
  // one batch rather than one call per element.
  const styleNames = new Map<string, string>();
  try {
    const allStyles = await webflow.getAllStyles();
    const names     = await Promise.all(allStyles.map((s) => s.getName()));
    allStyles.forEach((s, i) => styleNames.set(s.id, names[i]));
  } catch { /* proceed without style names */ }

  // ── Element tree ─────────────────────────────────────────────────
  const lines: string[] = [];
  try {
    const root = await webflow.getRootElement();
    if (root) {
      await traverseElement(root, 0, styleNames, lines);
    } else {
      lines.push('(no root element — is a page open in the Designer?)');
    }
  } catch (err) {
    lines.push(
      `(error traversing DOM: ${err instanceof Error ? err.message : String(err)})`
    );
  }

  // ── Append site-wide style list at bottom ────────────────────────
  if (styleNames.size > 0) {
    lines.push('');
    lines.push('── Site styles ──────────────────────');
    lines.push([...styleNames.values()].sort().join(', '));
  }

  return { summary: lines.join('\n'), pageInfo };
}

async function traverseElement(
  el:         AnyElement,
  depth:      number,
  styleNames: Map<string, string>,
  lines:      string[],
): Promise<void> {
  const indent = '  '.repeat(depth);
  const type   = el.type || '?';

  // Applied class names (styles)
  let classes = '';
  if ('styles' in el && el.styles === true) {
    try {
      const applied = await (el as any).getStyles() as Array<{ id: string } | null> | null;
      if (applied) {
        const names = applied
          .filter(Boolean)
          .map((s: { id: string }) => styleNames.get(s.id) ?? s.id)
          .filter(Boolean);
        if (names.length) classes = ' .' + names.join('.');
      }
    } catch { /* ignore */ }
  }

  // Text content (only String elements have getText())
  let textSnippet = '';
  if (type === 'String') {
    try {
      const text = await (el as any).getText() as string | null;
      if (text) {
        const t = text.trim().replace(/\s+/g, ' ');
        textSnippet = ` "${t.slice(0, 80)}${t.length > 80 ? '…' : ''}"`;
      }
    } catch { /* ignore */ }
  }

  lines.push(`${indent}${type}${classes}${textSnippet}`);

  if (depth >= MAX_DEPTH) return;

  // Recurse into children
  if ('children' in el && el.children === true) {
    try {
      const children = await (el as any).getChildren() as AnyElement[];
      if (!children || children.length === 0) return;

      const shown = children.slice(0, MAX_CHILDREN);
      for (const child of shown) {
        await traverseElement(child, depth + 1, styleNames, lines);
      }

      if (children.length > MAX_CHILDREN) {
        lines.push(`${indent}  … (${children.length - MAX_CHILDREN} more)`);
      }
    } catch { /* ignore */ }
  }
}
