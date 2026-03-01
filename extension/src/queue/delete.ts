/**
 * delete.ts
 *
 * Responds to MCP `delete_elements` / `delete_section` requests by finding
 * and removing elements from the live Webflow Designer canvas.
 *
 * Flow:
 *   1. MCP tool POSTs to relay /delete/request with { elementIds } or { sectionClass }
 *   2. Poller calls checkAndSendDelete() on each tick
 *   3. If pending: find matching elements, remove them, POST result to relay
 *   4. MCP tool polls /delete/done and returns the result
 */

// ── Public API ───────────────────────────────────────────────────────────────

export async function checkAndSendDelete(
  siteId:   string,
  relayUrl: string,
): Promise<void> {
  try {
    const res = await fetch(
      `${relayUrl}/delete/pending?siteId=${encodeURIComponent(siteId)}`
    );
    if (!res.ok) return;
    const data = (await res.json()) as {
      pending:      boolean;
      elementIds:   string[] | null;
      sectionClass: string   | null;
    };
    if (!data.pending) return;

    const result = await executeDelete(data.elementIds, data.sectionClass);

    await fetch(
      `${relayUrl}/delete/done?siteId=${encodeURIComponent(siteId)}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(result),
      }
    );
  } catch (err) {
    console.warn('[delete] Error:', err instanceof Error ? err.message : String(err));
  }
}

// ── Internals ────────────────────────────────────────────────────────────────

async function executeDelete(
  elementIds:   string[] | null,
  sectionClass: string   | null,
): Promise<{ deleted: number; errors: string[] }> {
  const allElements = await webflow.getAllElements().catch(() => [] as AnyElement[]);
  let toDelete: AnyElement[] = [];

  if (elementIds?.length) {
    // Delete by explicit element IDs
    const idSet = new Set(elementIds);
    toDelete = allElements.filter((el) => el.id?.element && idSet.has(el.id.element));
  } else if (sectionClass) {
    // Delete all Section elements whose applied styles include sectionClass
    const styleNames = await buildStyleNameMap();
    const sections   = allElements.filter((el) => el.type === 'Section');
    const matches    = await Promise.all(
      sections.map(async (el) => {
        const classes = await getElementClasses(el, styleNames);
        return classes.includes(sectionClass) ? el : null;
      })
    );
    toDelete = matches.filter(Boolean) as AnyElement[];
  }

  let deleted = 0;
  const errors: string[] = [];

  for (const el of toDelete) {
    try {
      await (el as any).remove();
      deleted++;
    } catch (e) {
      errors.push(`${el.id?.element ?? '?'}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { deleted, errors };
}

async function buildStyleNameMap(): Promise<Map<string, string>> {
  const styleNames = new Map<string, string>();
  const allStyles  = await webflow.getAllStyles().catch(() => [] as Style[]);
  const names      = await Promise.all(allStyles.map((s) => s.getName()));
  allStyles.forEach((s, i) => styleNames.set(s.id, names[i]));
  return styleNames;
}

async function getElementClasses(
  el: AnyElement,
  styleNames: Map<string, string>,
): Promise<string[]> {
  if (!('styles' in el) || el.styles !== true) return [];
  try {
    const applied = await (el as any).getStyles() as Array<{ id: string } | null> | null;
    if (!applied) return [];
    return applied
      .filter(Boolean)
      .map((s: { id: string }) => styleNames.get(s.id) ?? '')
      .filter(Boolean) as string[];
  } catch { return []; }
}
