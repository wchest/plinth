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
    case 'Section':    return 'section';
    case 'Container':  return 'div';
    case 'Paragraph':  return 'p';
    case 'Button':
    case 'TextLink':
    case 'LinkBlock':  return 'a';
    case 'Image':      return 'img';
    case 'DOM':        return node.domTag ?? 'div';
    // Preset-created types whose children are regular elements
    case 'SliderSlide':
    case 'TabPane':    return 'div';
    case 'ListItem':   return 'li';
    case 'Blockquote': return 'blockquote';
    default:           return node.type.toLowerCase();
  }
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

/**
 * Create a preset element at the correct position based on depth.
 * depth=0 + parent: insert after parent (section-level sibling)
 * depth=0 + no parent: append to page root
 * depth>0: append inside parent
 */
async function createPresetElement(
  preset: any,
  parent: AnyElement | null,
  depth: number,
): Promise<AnyElement> {
  if (depth === 0 && parent !== null) {
    return (parent as DOMElement).after(preset) as Promise<AnyElement>;
  }
  if (depth === 0) {
    const root = await webflow.getRootElement();
    if (!root) throw new Error('getRootElement() returned null');
    return (root as DOMElement).append(preset) as Promise<AnyElement>;
  }
  return (parent as DOMElement).append(preset) as Promise<AnyElement>;
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

  // ── Preset-based elements ──────────────────────────────────────────────────
  // These use webflow.elementPresets and must not call setTag().
  // Each finds the appropriate inner mount point before appending children.

  if (node.type === 'DynamoWrapper') {
    const wrapper = await createPresetElement(webflow.elementPresets.DynamoWrapper, parent, depth);
    const wStyle = await webflow.getStyleByName(node.className);
    if (wStyle) await (wrapper as any).setStyles([wStyle]);

    // Find the DynamoItem inside the auto-created structure.
    const wChildren = await (wrapper as any).getChildren().catch(() => [] as AnyElement[]);
    let itemParent: AnyElement = wrapper;
    for (const child of wChildren) {
      if (child.type === 'DynamoList') {
        const listChildren = await (child as any).getChildren().catch(() => [] as AnyElement[]);
        const item = listChildren.find((c: AnyElement) => c.type === 'DynamoItem');
        if (item) { itemParent = item; break; }
      }
    }

    onProgress?.(`[elements] Created DynamoWrapper .${node.className} (depth ${depth})`);
    let count = 1;
    for (const childNode of node.children ?? []) {
      try {
        const { count: cc } = await buildTree(childNode, itemParent, depth + 1, onProgress);
        count += cc;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onProgress?.(`[elements] ERROR building .${childNode.className} inside DynamoItem: ${message}`);
      }
    }
    return { element: wrapper as unknown as DOMElement, count };
  }

  if (node.type === 'Slider') {
    const wrapper = await createPresetElement(webflow.elementPresets.SliderWrapper, parent, depth);
    const wStyle = await webflow.getStyleByName(node.className);
    if (wStyle) await (wrapper as any).setStyles([wStyle]);

    // Find SliderMask inside the auto-created wrapper structure.
    const wChildren = await (wrapper as any).getChildren().catch(() => [] as AnyElement[]);
    onProgress?.(`[elements] SliderWrapper children: [${wChildren.map((c: any) => c.type ?? '?').join(', ')}]`);

    let sliderMask: AnyElement | null = null;
    for (const child of wChildren) {
      if ((child as any).type === 'SliderMask') { sliderMask = child; break; }
    }

    onProgress?.(`[elements] Created SliderWrapper .${node.className} (depth ${depth})`);
    let count = 1;

    if (!sliderMask) {
      onProgress?.(`[elements] Warning: SliderMask not found — skipping slides`);
      return { element: wrapper as unknown as DOMElement, count };
    }

    // SliderWrapper preset auto-creates 2 SliderSlide elements inside the mask.
    // Webflow rejects plain DOM elements in SliderMask ("Non-Slide Item can not be
    // placed in a Mask"), so we REUSE existing slides for the first N, then harvest
    // additional real SliderSlide elements from temporary SliderWrappers and move
    // them into this mask. The InsertOrMoveElement API accepts existing elements.
    const maskChildren = await (sliderMask as any).getChildren().catch(() => [] as AnyElement[]);
    let slides: AnyElement[] = maskChildren.filter((c: any) => c.type === 'SliderSlide');
    onProgress?.(`[elements] SliderMask has ${slides.length} auto-created slide(s)`);

    const slideNodes = node.children ?? [];
    const extraNeeded = Math.max(0, slideNodes.length - slides.length);

    // Harvest additional SliderSlide elements from temporary SliderWrappers.
    // Each temp wrapper gives us 2 proper SliderSlide elements we can move.
    if (extraNeeded > 0) {
      onProgress?.(`[elements] Need ${extraNeeded} extra slide(s) — harvesting from temp wrappers`);
      const tempWrappersNeeded = Math.ceil(extraNeeded / 2);
      for (let t = 0; t < tempWrappersNeeded && slides.length < slideNodes.length; t++) {
        try {
          const root = await webflow.getRootElement();
          if (!root) break;
          const tempWrapper = await (root as any).append(webflow.elementPresets.SliderWrapper) as AnyElement;
          const tempChildren = await (tempWrapper as any).getChildren().catch(() => [] as AnyElement[]);

          let tempMask: AnyElement | null = null;
          for (const tc of tempChildren) {
            if ((tc as any).type === 'SliderMask') { tempMask = tc; break; }
          }

          if (tempMask) {
            const tempMaskKids = await (tempMask as any).getChildren().catch(() => [] as AnyElement[]);
            const harvestedSlides = tempMaskKids.filter((c: any) => c.type === 'SliderSlide');

            // Move harvested slides into the real mask after the last real slide.
            for (const hs of harvestedSlides) {
              if (slides.length >= slideNodes.length) break;
              const anchor = slides[slides.length - 1];
              const moved = await (anchor as any).after(hs) as AnyElement;
              slides.push(moved);
            }
          }

          await (tempWrapper as any).remove();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          onProgress?.(`[elements] Warning: harvest failed: ${message}`);
          break;
        }
      }
      onProgress?.(`[elements] After harvesting: ${slides.length} slide(s) available`);
    }

    for (let i = 0; i < slideNodes.length; i++) {
      const slideNode = slideNodes[i];
      if (i >= slides.length) {
        onProgress?.(`[elements] Warning: no slide available for .${slideNode.className} — skipping`);
        continue;
      }
      try {
        const slideEl = slides[i];
        onProgress?.(`[elements] Using slide ${i + 1} for .${slideNode.className}`);

        const slideStyle = await webflow.getStyleByName(slideNode.className);
        if (slideStyle) await (slideEl as any).setStyles([slideStyle]);
        count++;

        for (const childNode of slideNode.children ?? []) {
          try {
            const { count: cc } = await buildTree(childNode, slideEl as DOMElement, depth + 2, onProgress);
            count += cc;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            onProgress?.(`[elements] ERROR in slide .${slideNode.className} → .${childNode.className}: ${message}`);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onProgress?.(`[elements] ERROR processing slide .${slideNode.className}: ${message}`);
      }
    }
    return { element: wrapper as unknown as DOMElement, count };
  }

  if (node.type === 'Tabs') {
    const wrapper = await createPresetElement(webflow.elementPresets.TabsWrapper, parent, depth);
    const wStyle = await webflow.getStyleByName(node.className);
    if (wStyle) await (wrapper as any).setStyles([wStyle]);

    // Find TabsContent inside the auto-created wrapper structure.
    const wChildren = await (wrapper as any).getChildren().catch(() => [] as AnyElement[]);
    let tabsContent: AnyElement | null = null;
    for (const child of wChildren) {
      if ((child as any).type === 'TabsContent') { tabsContent = child; break; }
    }

    onProgress?.(`[elements] Created TabsWrapper .${node.className} (depth ${depth})`);
    let count = 1;

    if (!tabsContent) {
      onProgress?.(`[elements] Warning: TabsContent not found — skipping panes`);
      return { element: wrapper as unknown as DOMElement, count };
    }

    // Same pattern as Slider: reuse auto-created TabPane elements, harvest extras
    // from temporary TabsWrappers if needed.
    const contentChildren = await (tabsContent as any).getChildren().catch(() => [] as AnyElement[]);
    let panes: AnyElement[] = contentChildren.filter((c: any) => c.type === 'TabPane');
    onProgress?.(`[elements] TabsContent has ${panes.length} auto-created pane(s)`);

    const paneNodes = node.children ?? [];
    const extraPanesNeeded = Math.max(0, paneNodes.length - panes.length);

    if (extraPanesNeeded > 0) {
      onProgress?.(`[elements] Need ${extraPanesNeeded} extra pane(s) — harvesting from temp wrappers`);
      const tempWrappersNeeded = Math.ceil(extraPanesNeeded / 2);
      for (let t = 0; t < tempWrappersNeeded && panes.length < paneNodes.length; t++) {
        try {
          const root = await webflow.getRootElement();
          if (!root) break;
          const tempWrapper = await (root as any).append(webflow.elementPresets.TabsWrapper) as AnyElement;
          const tempChildren = await (tempWrapper as any).getChildren().catch(() => [] as AnyElement[]);

          let tempContent: AnyElement | null = null;
          for (const tc of tempChildren) {
            if ((tc as any).type === 'TabsContent') { tempContent = tc; break; }
          }

          if (tempContent) {
            const tempContentKids = await (tempContent as any).getChildren().catch(() => [] as AnyElement[]);
            const harvestedPanes = tempContentKids.filter((c: any) => c.type === 'TabPane');
            for (const hp of harvestedPanes) {
              if (panes.length >= paneNodes.length) break;
              const anchor = panes[panes.length - 1];
              const moved = await (anchor as any).after(hp) as AnyElement;
              panes.push(moved);
            }
          }

          await (tempWrapper as any).remove();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          onProgress?.(`[elements] Warning: pane harvest failed: ${message}`);
          break;
        }
      }
      onProgress?.(`[elements] After harvesting: ${panes.length} pane(s) available`);
    }

    for (let i = 0; i < paneNodes.length; i++) {
      const paneNode = paneNodes[i];
      if (i >= panes.length) {
        onProgress?.(`[elements] Warning: no pane available for .${paneNode.className} — skipping`);
        continue;
      }
      try {
        const paneEl = panes[i];
        onProgress?.(`[elements] Using pane ${i + 1} for .${paneNode.className}`);

        const paneStyle = await webflow.getStyleByName(paneNode.className);
        if (paneStyle) await (paneEl as any).setStyles([paneStyle]);
        count++;

        for (const childNode of paneNode.children ?? []) {
          try {
            const { count: cc } = await buildTree(childNode, paneEl as DOMElement, depth + 2, onProgress);
            count += cc;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            onProgress?.(`[elements] ERROR in pane .${paneNode.className} → .${childNode.className}: ${message}`);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onProgress?.(`[elements] ERROR processing pane .${paneNode.className}: ${message}`);
      }
    }
    return { element: wrapper as unknown as DOMElement, count };
  }

  // ── Simple preset elements (children append directly into wrapper) ──────────
  // Maps BuildPlan type name → webflow.elementPresets key.
  const SIMPLE_PRESET_KEY: Partial<Record<string, keyof typeof webflow.elementPresets>> = {
    QuickStack: 'QuickStack',
    HFlex:      'HFlex',
    VFlex:      'VFlex',
    Grid:       'Grid',
    List:       'List',
    RichText:   'RichText',
    HtmlEmbed:  'HtmlEmbed',
  };

  if (node.type in SIMPLE_PRESET_KEY) {
    const presetKey = SIMPLE_PRESET_KEY[node.type]!;
    const wrapper = await createPresetElement(webflow.elementPresets[presetKey], parent, depth);
    const wStyle = await webflow.getStyleByName(node.className);
    if (wStyle) await (wrapper as any).setStyles([wStyle]);

    onProgress?.(`[elements] Created ${node.type} .${node.className} (depth ${depth})`);
    let count = 1;
    for (const childNode of node.children ?? []) {
      try {
        const { count: cc } = await buildTree(childNode, wrapper, depth + 1, onProgress);
        count += cc;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onProgress?.(`[elements] ERROR building .${childNode.className} inside ${node.type}: ${message}`);
      }
    }
    return { element: wrapper as unknown as DOMElement, count };
  }

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
