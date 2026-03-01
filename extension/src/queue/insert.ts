/**
 * insert.ts
 *
 * Responds to MCP `insert_elements` requests by building new element subtrees
 * inside or alongside existing elements — without rebuilding the whole section.
 *
 * Flow:
 *   1. MCP tool POSTs to relay /insert/request with { parentClass|afterClass, nodes, styles? }
 *   2. Poller calls checkAndSendInsert() on each tick
 *   3. If pending: locate the anchor element, create styles, build subtrees, POST result
 *   4. MCP tool polls /insert/result and returns the result
 *
 * parentClass → append nodes as children inside the named element
 * afterClass  → insert nodes as siblings after the named element
 */

import type { ElementNode, StyleDef } from '../builder/validator';
import { createStyles } from '../builder/style-manager';
import { buildTree } from '../builder/element-factory';

// ── Public API ───────────────────────────────────────────────────────────────

export async function checkAndSendInsert(
  siteId:   string,
  relayUrl: string,
): Promise<void> {
  try {
    const res = await fetch(
      `${relayUrl}/insert/pending?siteId=${encodeURIComponent(siteId)}`
    );
    if (!res.ok) return;
    const data = (await res.json()) as {
      pending:      boolean;
      parentClass?: string;
      afterClass?:  string;
      nodes:        ElementNode[];
      styles?:      StyleDef[];
    };
    if (!data.pending) return;

    const result = await executeInsert(
      data.parentClass ?? null,
      data.afterClass  ?? null,
      data.nodes       ?? [],
      data.styles      ?? [],
    );

    await fetch(
      `${relayUrl}/insert/done?siteId=${encodeURIComponent(siteId)}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(result),
      }
    );
  } catch (err) {
    console.warn('[insert] Error:', err instanceof Error ? err.message : String(err));
  }
}

// ── Internals ────────────────────────────────────────────────────────────────

async function executeInsert(
  parentClass: string | null,
  afterClass:  string | null,
  nodes:       ElementNode[],
  styles:      StyleDef[],
): Promise<{ inserted: number; stylesCreated: number; errors: string[] }> {
  const errors: string[] = [];

  // ── Create styles ──────────────────────────────────────────────────
  let stylesCreated = 0;
  if (styles.length > 0) {
    try {
      const styleResult = await createStyles(styles);
      stylesCreated = styleResult.created;
    } catch (e) {
      errors.push(`styles: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── Find anchor element ────────────────────────────────────────────
  const targetClass = parentClass ?? afterClass!;

  const allStyles  = await webflow.getAllStyles().catch(() => [] as Style[]);
  const styleNames = new Map<string, string>();
  try {
    const names = await Promise.all(allStyles.map((s) => s.getName()));
    allStyles.forEach((s, i) => styleNames.set(s.id, names[i]));
  } catch { /* proceed without names */ }

  const allElements = await webflow.getAllElements().catch(() => [] as AnyElement[]);
  let anchor: AnyElement | null = null;

  for (const el of allElements) {
    if (!('styles' in el) || (el as any).styles !== true) continue;
    try {
      const applied = await (el as any).getStyles() as Array<{ id: string }> | null;
      if (!applied) continue;
      const classes = applied
        .filter(Boolean)
        .map((s: { id: string }) => styleNames.get(s.id) ?? '')
        .filter(Boolean);
      if (classes.includes(targetClass)) {
        anchor = el;
        break;
      }
    } catch { continue; }
  }

  if (!anchor) {
    return {
      inserted: 0,
      stylesCreated,
      errors: [`No element found with class "${targetClass}"`, ...errors],
    };
  }

  // ── Build each node ────────────────────────────────────────────────
  // parentClass: depth=1 so buildTree appends inside anchor
  // afterClass:  depth=0 so buildTree inserts after anchor (using .after())
  const depth = parentClass ? 1 : 0;
  let inserted = 0;

  // When inserting multiple siblings via afterClass, each subsequent node
  // should go after the previously inserted one, not after the original anchor.
  let currentAnchor = anchor;

  for (const node of nodes) {
    try {
      const { element, count } = await buildTree(node, currentAnchor, depth);
      inserted += count;
      // Advance anchor so next sibling inserts after this one.
      if (!parentClass) {
        currentAnchor = element as unknown as AnyElement;
      }
    } catch (e) {
      errors.push(
        `.${node.className}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  return { inserted, stylesCreated, errors };
}
