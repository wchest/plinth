/**
 * updates.ts
 *
 * Responds to MCP `update_styles` / `update_content` requests by applying
 * targeted edits to existing Webflow styles and elements.
 *
 * Flow:
 *   1. MCP tool POSTs to relay /updates/request with { type, styles | updates }
 *   2. Poller calls checkAndSendUpdates() on each tick
 *   3. If pending: execute the update, POST result to relay
 *   4. MCP tool polls /updates/result and returns the result
 *
 * type: 'styles'  → setProperties on existing named styles
 * type: 'content' → setTextContent / setAttribute on elements by className
 */

// ── Types ────────────────────────────────────────────────────────────────────

interface StyleUpdate {
  name: string;
  properties?: Record<string, string>;
  breakpoints?: Record<string, Record<string, string>>;
  pseudo?: Record<string, Record<string, string>>;
}

interface ContentUpdate {
  className: string;
  text?: string;
  href?: string;
  src?: string;
  alt?: string;
  attributes?: Array<{ name: string; value: string }>;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Check if the relay has a pending update request for this site.
 * If so, execute it and post the result back.
 * Safe to call on every poller tick — exits immediately if nothing pending.
 */
export async function checkAndSendUpdates(
  siteId:   string,
  relayUrl: string,
): Promise<void> {
  try {
    const res = await fetch(
      `${relayUrl}/updates/pending?siteId=${encodeURIComponent(siteId)}`
    );
    if (!res.ok) return;
    const data = (await res.json()) as {
      pending:  boolean;
      type?:    string;
      styles?:  StyleUpdate[];
      updates?: ContentUpdate[];
    };
    if (!data.pending) return;

    let result: object;
    if (data.type === 'styles') {
      result = await executeStyleUpdates(data.styles ?? []);
    } else if (data.type === 'content') {
      result = await executeContentUpdates(data.updates ?? []);
    } else {
      result = { error: `Unknown update type: ${data.type}` };
    }

    await fetch(
      `${relayUrl}/updates/done?siteId=${encodeURIComponent(siteId)}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(result),
      }
    );
  } catch (err) {
    console.warn('[updates] Error:', err instanceof Error ? err.message : String(err));
  }
}

// ── Internals ────────────────────────────────────────────────────────────────

async function executeStyleUpdates(
  styles: StyleUpdate[],
): Promise<{ updated: number; errors: string[] }> {
  let updated = 0;
  const errors: string[] = [];

  for (const styleDef of styles) {
    try {
      const style = await webflow.getStyleByName(styleDef.name);
      if (!style) {
        errors.push(`Style "${styleDef.name}" not found`);
        continue;
      }

      if (styleDef.properties && Object.keys(styleDef.properties).length > 0) {
        await style.setProperties(styleDef.properties);
      }
      if (styleDef.breakpoints) {
        for (const [bpId, props] of Object.entries(styleDef.breakpoints)) {
          if (props && Object.keys(props).length > 0) {
            await style.setProperties(props, { breakpoint: bpId as BreakpointId });
          }
        }
      }
      if (styleDef.pseudo) {
        for (const [state, props] of Object.entries(styleDef.pseudo)) {
          if (props && Object.keys(props).length > 0) {
            await style.setProperties(props, { pseudo: state as PseudoStateKey });
          }
        }
      }
      updated++;
    } catch (e) {
      errors.push(`${styleDef.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { updated, errors };
}

async function executeContentUpdates(
  updates: ContentUpdate[],
): Promise<{ updated: number; errors: string[] }> {
  if (updates.length === 0) return { updated: 0, errors: [] };

  // Build style name map once so we can look up classes for any element.
  const allStyles = await webflow.getAllStyles().catch(() => [] as Style[]);
  const styleNames = new Map<string, string>();
  try {
    const names = await Promise.all(allStyles.map((s) => s.getName()));
    allStyles.forEach((s, i) => styleNames.set(s.id, names[i]));
  } catch { /* proceed without style names */ }

  // Fetch all elements once.
  const allElements = await webflow.getAllElements().catch(() => [] as AnyElement[]);

  let updated = 0;
  const errors: string[] = [];

  for (const update of updates) {
    try {
      // Find all elements whose applied styles include the target class.
      const matching = await Promise.all(
        allElements.map(async (el) => {
          if (!('styles' in el) || (el as any).styles !== true) return null;
          try {
            const applied = await (el as any).getStyles() as Array<{ id: string }> | null;
            if (!applied) return null;
            const classes = applied
              .filter(Boolean)
              .map((s: { id: string }) => styleNames.get(s.id) ?? '')
              .filter(Boolean);
            return classes.includes(update.className) ? el : null;
          } catch { return null; }
        })
      );
      const elements = matching.filter(Boolean) as AnyElement[];

      if (elements.length === 0) {
        errors.push(`No elements found with class "${update.className}"`);
        continue;
      }

      for (const el of elements) {
        if (update.text !== undefined) await (el as any).setTextContent(update.text);
        if (update.href !== undefined) await (el as any).setAttribute('href', update.href);
        if (update.src  !== undefined) await (el as any).setAttribute('src',  update.src);
        if (update.alt  !== undefined) await (el as any).setAttribute('alt',  update.alt);
        if (update.attributes) {
          for (const attr of update.attributes) {
            await (el as any).setAttribute(attr.name, attr.value);
          }
        }
      }
      updated += elements.length;
    } catch (e) {
      errors.push(`${update.className}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { updated, errors };
}
