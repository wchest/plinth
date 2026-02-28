/**
 * element-factory.ts
 * Recursively creates Webflow elements from BuildPlan ElementNode definitions.
 *
 * Uses webflow.createDOM(tag) which accepts any HTML tag string and returns a
 * DOMElement. Styles are looked up by name before being applied.
 */

import type { ElementNode } from './validator';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BuildTreeResult {
  element: DOMElement;
  count: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Derive the HTML tag string from an ElementNode.
 * Headings encode their level in the BuildPlan as headingLevel; all others
 * map directly from the type field.
 */
function tagForNode(node: ElementNode): string {
  if (node.type === 'Heading' && node.headingLevel) {
    return `h${node.headingLevel}`;
  }
  switch (node.type) {
    case 'Section':   return 'section';
    case 'Container': return 'div';
    case 'Paragraph': return 'p';
    case 'Button':
    case 'TextLink':
    case 'LinkBlock': return 'a';
    case 'Image':     return 'img';
    case 'DOM':       return node.domTag ?? 'div';
    default:          return node.type.toLowerCase();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Recursively builds a Webflow element tree from an ElementNode descriptor.
 *
 * On the root call (depth 0):
 *   - If a parent element is provided (selected in the Designer), the new
 *     section is inserted AFTER it.
 *   - If no parent is provided, the section is appended to the page root.
 *
 * Child elements are always appended inside their parent.
 *
 * @param node       The element node to create.
 * @param parent     Anchor element (null → use page root).
 * @param depth      Current nesting depth (0 for the root call).
 * @param onProgress Optional callback for progress messages.
 */
export async function buildTree(
  node: ElementNode,
  parent: AnyElement | null,
  depth: number,
  onProgress?: (msg: string) => void,
): Promise<BuildTreeResult> {
  const tag = tagForNode(node);

  // Determine where to materialize this element.
  let el: DOMElement;

  if (depth === 0) {
    if (parent !== null) {
      // Insert root section after the selected element.
      el = await (parent as DOMElement).after(webflow.elementPresets.DOM) as DOMElement;
    } else {
      // Fall back: append to the page root.
      const root = await webflow.getRootElement();
      if (!root) throw new Error('No element selected and getRootElement() returned null');
      el = await (root as DOMElement).append(webflow.elementPresets.DOM) as DOMElement;
    }
  } else {
    // Children always append inside their parent.
    el = await (parent as DOMElement).append(webflow.elementPresets.DOM) as DOMElement;
  }

  // Set the HTML tag now that the element is on the canvas.
  await el.setTag(tag);
  onProgress?.(`[elements] Created <${tag}> .${node.className} (depth ${depth})`);

  // Look up and apply the style by class name.
  const style = await webflow.getStyleByName(node.className);
  if (style) {
    await el.setStyles([style]);
  } else {
    onProgress?.(`[elements] Warning: style "${node.className}" not found — skipping`);
  }

  // Set text content.
  if (node.text) {
    await el.setTextContent(node.text);
  }

  // Link href (Button, TextLink, LinkBlock all render as <a>).
  if (
    (node.type === 'Button' || node.type === 'TextLink' || node.type === 'LinkBlock') &&
    node.href
  ) {
    await el.setAttribute('href', node.href);
  }

  // Image src and alt.
  if (node.type === 'Image') {
    if (node.src) await el.setAttribute('src', node.src);
    if (node.alt) await el.setAttribute('alt', node.alt);
  }

  // Custom HTML attributes.
  if (node.attributes?.length) {
    for (const attr of node.attributes) {
      await el.setAttribute(attr.name, attr.value);
    }
  }

  // Recursively build children.
  let count = 1;
  for (const childNode of node.children ?? []) {
    try {
      const { count: childCount } = await buildTree(childNode, el, depth + 1, onProgress);
      count += childCount;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[element-factory] Failed to build child "${childNode.className}" ` +
        `of "${node.className}": ${message}`,
      );
      onProgress?.(
        `[elements] ERROR building .${childNode.className} under .${node.className}: ${message}`,
      );
    }
  }

  return { element: el, count };
}
