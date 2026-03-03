/**
 * move.ts
 *
 * Responds to MCP `move_element` and `reorder_sections` requests by
 * repositioning existing elements on the live Webflow Designer canvas.
 *
 * Flow:
 *   1. MCP tool POSTs to relay /move/request with { className, beforeClass|afterClass }
 *      or { sectionClasses: string[] }
 *   2. Poller calls checkAndSendMove() on each tick
 *   3. If pending: execute repositioning, POST result to relay
 *   4. MCP tool polls /move/done and returns the result
 */

// ── Public API ───────────────────────────────────────────────────────────────

export async function checkAndSendMove(
  siteId:   string,
  relayUrl: string,
): Promise<void> {
  try {
    const res = await fetch(
      `${relayUrl}/move/pending?siteId=${encodeURIComponent(siteId)}`
    );
    if (!res.ok) return;
    const data = (await res.json()) as {
      pending:         boolean;
      className?:      string;
      beforeClass?:    string;
      afterClass?:     string;
      sectionClasses?: string[];
    };
    if (!data.pending) return;

    let result: { moved: number; errors: string[] };

    if (data.sectionClasses?.length) {
      result = await executeReorderSections(data.sectionClasses);
    } else if (data.className) {
      result = await executeMoveElement(
        data.className,
        data.beforeClass ?? null,
        data.afterClass  ?? null,
      );
    } else {
      result = { moved: 0, errors: ['No operation specified'] };
    }

    await fetch(
      `${relayUrl}/move/done?siteId=${encodeURIComponent(siteId)}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(result),
      }
    );
  } catch (err) {
    console.warn('[move] Error:', err instanceof Error ? err.message : String(err));
  }
}

// ── Internals ────────────────────────────────────────────────────────────────

async function executeMoveElement(
  className:   string,
  beforeClass: string | null,
  afterClass:  string | null,
): Promise<{ moved: number; errors: string[] }> {
  const styleNames  = await buildStyleNameMap();
  const allElements = await webflow.getAllElements().catch(() => [] as AnyElement[]);

  const target = await findByClass(className, allElements, styleNames);
  if (!target) return { moved: 0, errors: [`No element found with class "${className}"`] };

  const anchorClass = beforeClass ?? afterClass!;
  const anchor = await findByClass(anchorClass, allElements, styleNames);
  if (!anchor) return { moved: 0, errors: [`No anchor element found with class "${anchorClass}"`] };

  try {
    if (beforeClass) {
      await (anchor as any).before(target);
    } else {
      await (anchor as any).after(target);
    }
    return { moved: 1, errors: [] };
  } catch (e) {
    return { moved: 0, errors: [e instanceof Error ? e.message : String(e)] };
  }
}

async function executeReorderSections(
  sectionClasses: string[],
): Promise<{ moved: number; errors: string[] }> {
  const styleNames  = await buildStyleNameMap();
  const allElements = await webflow.getAllElements().catch(() => [] as AnyElement[]);
  const sections    = allElements.filter((el) => el.type === 'Section');

  // Build className → element map
  const sectionMap = new Map<string, AnyElement>();
  for (const section of sections) {
    const classes = await getElementClasses(section, styleNames);
    for (const cls of classes) {
      if (sectionClasses.includes(cls) && !sectionMap.has(cls)) {
        sectionMap.set(cls, section);
      }
    }
  }

  const missing = sectionClasses.filter((cls) => !sectionMap.has(cls));
  if (missing.length > 0) {
    return { moved: 0, errors: [`Sections not found: ${missing.join(', ')}`] };
  }

  // Find insertion anchor: root-level element just before the earliest target section
  const root         = await webflow.getRootElement();
  const rootChildren = await (root as any).getChildren() as AnyElement[];

  const targetIds = new Set(
    sectionClasses.map((cls) => sectionMap.get(cls)!.id?.element).filter(Boolean)
  );
  let minIdx = rootChildren.length;
  for (let i = 0; i < rootChildren.length; i++) {
    if (targetIds.has(rootChildren[i].id?.element)) {
      minIdx = Math.min(minIdx, i);
    }
  }

  const anchor: AnyElement | null = minIdx > 0 ? rootChildren[minIdx - 1] : null;

  // Re-insert sections in desired order by chaining after()
  const errors: string[] = [];
  let moved  = 0;
  let prev   = anchor;

  for (const cls of sectionClasses) {
    const section = sectionMap.get(cls)!;
    try {
      if (prev === null) {
        // Insert before the current first root child
        const kids = await (root as any).getChildren() as AnyElement[];
        if (kids.length > 0) {
          await (kids[0] as any).before(section);
        } else {
          await (root as any).append(section);
        }
      } else {
        await (prev as any).after(section);
      }
      prev = section;
      moved++;
    } catch (e) {
      errors.push(`${cls}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { moved, errors };
}

// ── Shared helpers ───────────────────────────────────────────────────────────

async function buildStyleNameMap(): Promise<Map<string, string>> {
  const styleNames = new Map<string, string>();
  const allStyles  = await webflow.getAllStyles().catch(() => [] as Style[]);
  const names      = await Promise.all(allStyles.map((s) => s.getName()));
  allStyles.forEach((s, i) => styleNames.set(s.id, names[i]));
  return styleNames;
}

async function getElementClasses(
  el:         AnyElement,
  styleNames: Map<string, string>,
): Promise<string[]> {
  if (!('styles' in el) || (el as any).styles !== true) return [];
  try {
    const applied = await (el as any).getStyles() as Array<{ id: string } | null> | null;
    if (!applied) return [];
    return applied
      .filter(Boolean)
      .map((s: { id: string }) => styleNames.get(s.id) ?? '')
      .filter(Boolean) as string[];
  } catch { return []; }
}

async function findByClass(
  className:   string,
  allElements: AnyElement[],
  styleNames:  Map<string, string>,
): Promise<AnyElement | null> {
  for (const el of allElements) {
    const classes = await getElementClasses(el, styleNames);
    if (classes.includes(className)) return el;
  }
  return null;
}
