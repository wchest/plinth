'use strict';

/**
 * Plinth Wix Bridge — MAIN world
 *
 * Accesses the Wix Document Services API through the preview iframe
 * to add/remove/modify components, read page structure, etc.
 *
 * The documentServices API is at:
 *   document.querySelector('iframe[name="preview-frame"]').contentWindow.documentServices
 */

(function () {
  const TAG = '[plinth-wix-bridge]';

  // -- Document Services accessor -----------------------------------------

  let _ds = null;
  let _dsReady = false;

  function getDS() {
    if (_ds && _dsReady) return _ds;

    const frame = document.querySelector('iframe[name="preview-frame"]');
    if (!frame || !frame.contentWindow) return null;

    const ds = frame.contentWindow.documentServices;
    if (!ds || !ds.components || !ds.pages) return null;

    _ds = ds;
    _dsReady = true;
    return ds;
  }

  function waitForDS(timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        const ds = getDS();
        if (ds) return resolve(ds);
        if (Date.now() - start > timeoutMs) return reject(new Error('documentServices not available'));
        setTimeout(check, 1000);
      };
      check();
    });
  }

  // -- Helpers ------------------------------------------------------------

  function compRef(id) {
    return { id, type: 'DESKTOP' };
  }

  function stripHtml(html) {
    return (html || '').replace(/<[^>]+>/g, '').trim();
  }

  // -- Command handlers ---------------------------------------------------

  const handlers = {};

  // -- ping ---------------------------------------------------------------
  handlers.ping = async () => {
    const ds = getDS();
    return {
      ok: true,
      data: {
        ready: !!ds,
        dsAvailable: !!ds,
        pageId: ds ? ds.pages.getFocusedPageId() : null,
      },
    };
  };

  // -- snapshot -----------------------------------------------------------
  handlers.snapshot = async () => {
    const ds = await waitForDS();
    const pageId = ds.pages.getFocusedPageId();
    const pageRef = compRef(pageId);
    const pageData = ds.pages.data.get(pageId);

    function describeComp(ref, depth, indent) {
      if (depth > 8) return '';
      let type;
      try { type = ds.components.getType(ref); } catch (e) { return ''; }

      const shortType = type.split('.').pop();
      let line = `${indent}${shortType} [${ref.id}]`;

      // Get text content
      if (type.includes('RichText') || type.includes('Text')) {
        try {
          const data = ds.components.data.get(ref);
          if (data && data.text) {
            const text = stripHtml(data.text);
            if (text) line += ` — "${text.substring(0, 60)}"`;
          }
        } catch (e) {}
      }

      // Get layout summary
      try {
        const layout = ds.components.layout.get(ref);
        if (layout) {
          line += ` (${layout.width}×${layout.height})`;
        }
      } catch (e) {}

      let result = line + '\n';

      // Recurse into children
      let children = [];
      try { children = ds.components.getChildren(ref) || []; } catch (e) {}
      for (const child of children) {
        result += describeComp(child, depth + 1, indent + '  ');
      }

      return result;
    }

    // Build tree from page children
    let pageChildren = [];
    try { pageChildren = ds.components.getChildren(pageRef) || []; } catch (e) {}

    let summary = '';
    for (const child of pageChildren) {
      summary += describeComp(child, 0, '');
    }

    // Collect all component types
    const allComps = ds.components.getAllComponents(pageRef);
    const typeCounts = {};
    for (const c of allComps) {
      try {
        const t = ds.components.getType(c).split('.').pop();
        typeCounts[t] = (typeCounts[t] || 0) + 1;
      } catch (e) {}
    }

    return {
      ok: true,
      data: {
        pageInfo: { id: pageId, name: pageData?.title || pageId },
        componentCount: allComps.length,
        typeCounts,
        summary: summary || '(empty page)',
      },
    };
  };

  // -- list_pages ---------------------------------------------------------
  handlers.list_pages = async () => {
    const ds = await waitForDS();
    const pageIds = ds.pages.getPageIdList();
    const pages = pageIds.map(id => {
      try {
        const data = ds.pages.data.get(id);
        return { id, title: data?.title, pageTitleSEO: data?.pageTitleSEO };
      } catch (e) {
        return { id };
      }
    });
    return { ok: true, data: { pages } };
  };

  // -- switch_page --------------------------------------------------------
  handlers.switch_page = async (payload) => {
    const ds = await waitForDS();
    const { pageId } = payload;
    try {
      ds.pages.navigateTo(pageId);
      return { ok: true, data: { switched: true, pageId } };
    } catch (e) {
      return { ok: false, error: `Failed to switch page: ${e.message}` };
    }
  };

  // -- probe ----------------------------------------------------------------
  handlers.probe = async (payload) => {
    const ds = await waitForDS();
    const { expr } = payload;
    if (!expr) return { ok: false, error: 'payload.expr is required' };
    try {
      const fn = new Function('ds', 'compRef', expr);
      const result = fn(ds, compRef);
      return { ok: true, data: { value: result } };
    } catch (e) {
      return { ok: false, error: `Probe failed: ${e.message}` };
    }
  };

  // -- build_section ------------------------------------------------------
  handlers.build_section = async (payload) => {
    const ds = await waitForDS();
    const { tree, insertAfterSectionId } = payload;

    const pageId = ds.pages.getFocusedPageId();
    const pageRef = compRef(pageId);

    // Convert SectionSpec tree to Wix component structure
    function convertNode(node) {
      const result = {};

      // Map SectionSpec types to Wix component types
      const typeMap = {
        'Section': 'responsive.components.Section',
        'Container': 'mobile.core.components.Container',
        'Block': 'mobile.core.components.Container',
        'DivBlock': 'mobile.core.components.Container',
        'Heading': 'wysiwyg.viewer.components.WRichText',
        'Paragraph': 'wysiwyg.viewer.components.WRichText',
        'Text': 'wysiwyg.viewer.components.WRichText',
        'Link': 'wysiwyg.viewer.components.WRichText',
        'Button': 'wysiwyg.viewer.components.SiteButton',
        'Image': 'core.components.Image',
        'VectorImage': 'wysiwyg.viewer.components.VectorImage',
      };

      const wixType = typeMap[node.type] || node.wixType || 'responsive.components.Container';
      result.componentType = wixType;

      // Layout
      if (node.layout) {
        result.layout = {
          width: node.layout.width || 980,
          height: node.layout.height || 100,
          x: node.layout.x || 0,
          y: node.layout.y || 0,
        };
      }

      // Text content
      if (node.text) {
        let htmlText = node.text;

        // Wrap in appropriate tags if plain text
        if (!htmlText.startsWith('<')) {
          if (node.type === 'Heading') {
            const level = node.headingLevel || 2;
            const fontClass = `font_${Math.min(level, 10)}`;
            htmlText = `<h${level} class="${fontClass}">${htmlText}</h${level}>`;
          } else {
            htmlText = `<p class="font_8">${htmlText}</p>`;
          }
        }

        result.data = {
          type: 'StyledText',
          text: htmlText,
        };
      }

      // Button
      if (node.type === 'Button') {
        result.data = {
          type: 'LinkableButton',
          label: node.text || 'Button',
        };
        if (node.href) {
          result.data.link = { type: 'ExternalLink', url: node.href, target: '_blank' };
        }
      }

      // Image
      if (node.type === 'Image' && node.src) {
        result.data = {
          type: 'Image',
          uri: node.src,
          alt: node.alt || '',
        };
      }

      // Inline styles to Wix style properties
      if (node.styles) {
        // Store raw CSS for future processing
        result._rawStyles = node.styles;
      }

      // Children
      if (node.children && node.children.length > 0) {
        result.components = node.children.map(convertNode);
      }

      return result;
    }

    try {
      const structure = convertNode(tree);
      const newComp = ds.components.add(pageRef, structure);

      // Count nodes
      let nodeCount = 1;
      function countNodes(node) {
        if (node.components) {
          for (const c of node.components) {
            nodeCount++;
            countNodes(c);
          }
        }
      }
      countNodes(structure);

      let rootType = null;
      try {
        if (newComp) rootType = ds.components.getType(compRef(newComp.id || newComp));
      } catch (_) {}

      return {
        ok: true,
        data: {
          nodeCount,
          rootId: newComp?.id || newComp || null,
          rootType,
        },
      };
    } catch (e) {
      return { ok: false, error: `Build failed: ${e.message}` };
    }
  };

  // -- delete -------------------------------------------------------------
  handlers.delete = async (payload) => {
    const ds = await waitForDS();
    const { elementIds } = payload;
    let deleted = 0;
    const errors = [];

    for (const id of elementIds) {
      try {
        ds.components.remove(compRef(id));
        deleted++;
      } catch (e) {
        errors.push(`${id}: ${e.message}`);
      }
    }

    return { ok: true, data: { deleted, errors } };
  };

  // -- get_component ------------------------------------------------------
  handlers.get_component = async (payload) => {
    const ds = await waitForDS();
    const { elementId } = payload;
    const ref = compRef(elementId);

    try {
      const type = ds.components.getType(ref);
      const data = ds.components.data.get(ref);
      const layout = ds.components.layout.get(ref);
      const style = ds.components.style.get(ref);
      const design = ds.components.design.get(ref);
      const children = (ds.components.getChildren(ref) || []).map(c => ({
        id: c.id,
        type: ds.components.getType(c),
      }));

      return {
        ok: true,
        data: { id: elementId, type, data, layout, style, design, children },
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  // -- update_component ---------------------------------------------------
  handlers.update_component = async (payload) => {
    const ds = await waitForDS();
    const { elementId, data, layout, style, design } = payload;
    const ref = compRef(elementId);

    try {
      if (data) ds.components.data.update(ref, data);
      if (layout) ds.components.layout.update(ref, layout);
      if (style) ds.components.style.update(ref, style);
      if (design) ds.components.design.update(ref, design);

      return { ok: true, data: { updated: elementId } };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  // -- list_component_types -----------------------------------------------
  handlers.list_component_types = async () => {
    const ds = await waitForDS();
    const defMap = ds.components.COMPONENT_DEFINITION_MAP;
    const types = Object.keys(defMap).filter(k => k !== '$id').sort();
    return { ok: true, data: { count: types.length, types } };
  };

  // -- get_theme ----------------------------------------------------------
  handlers.get_theme = async () => {
    const ds = await waitForDS();
    const result = {};

    try {
      if (ds.theme.colors && ds.theme.colors.getAll) {
        result.colors = ds.theme.colors.getAll();
      }
    } catch (e) { result.colorsErr = e.message; }

    try {
      if (ds.theme.fonts && ds.theme.fonts.getAll) {
        result.fonts = ds.theme.fonts.getAll();
      }
    } catch (e) { result.fontsErr = e.message; }

    try {
      if (ds.theme.textThemes && ds.theme.textThemes.getAll) {
        result.textThemes = ds.theme.textThemes.getAll();
      }
    } catch (e) { result.textThemesErr = e.message; }

    return { ok: true, data: result };
  };

  // -- add_page -----------------------------------------------------------
  handlers.add_page = async (payload) => {
    const ds = await waitForDS();
    const { name } = payload;

    try {
      const pageRef = ds.pages.add(name);
      return { ok: true, data: { created: true, pageId: pageRef?.id || pageRef } };
    } catch (e) {
      return { ok: false, error: `Failed to add page: ${e.message}` };
    }
  };

  // -- update_styles ------------------------------------------------------
  handlers.update_styles = async (payload) => {
    const ds = await waitForDS();
    const { elementId, cssProperties } = payload;
    const ref = compRef(elementId);

    try {
      // Get existing CSS style
      const existing = ds.components.cssStyle.get(ref) || {};
      const updated = { ...existing, ...cssProperties };
      ds.components.cssStyle.update(ref, updated);
      return { ok: true, data: { updated: elementId, properties: Object.keys(cssProperties) } };
    } catch (e) {
      return { ok: false, error: `Update styles failed: ${e.message}` };
    }
  };

  // -- get_styles ---------------------------------------------------------
  handlers.get_styles = async (payload) => {
    const ds = await waitForDS();
    const { elementId } = payload;
    const ref = compRef(elementId);

    try {
      const cssStyle = ds.components.cssStyle.get(ref);
      const style = ds.components.style.get(ref);
      const design = ds.components.design.get(ref);
      return { ok: true, data: { elementId, cssStyle, style, design } };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  // -- get_theme_colors ---------------------------------------------------
  handlers.get_theme_colors = async () => {
    const ds = await waitForDS();
    try {
      const colors = ds.theme.colors.getAll();
      return { ok: true, data: { colors } };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  // -- update_theme_color -------------------------------------------------
  handlers.update_theme_color = async (payload) => {
    const ds = await waitForDS();
    const { colorId, value } = payload;
    try {
      ds.theme.colors.update(colorId, value);
      return { ok: true, data: { updated: colorId, value } };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  // -- get_text_themes ----------------------------------------------------
  handlers.get_text_themes = async () => {
    const ds = await waitForDS();
    try {
      const textThemes = ds.theme.textThemes.getAll();
      return { ok: true, data: { textThemes } };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  // -- update_text_theme --------------------------------------------------
  handlers.update_text_theme = async (payload) => {
    const ds = await waitForDS();
    const { themeId, value } = payload;
    try {
      ds.theme.textThemes.update(themeId, value);
      return { ok: true, data: { updated: themeId } };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  // -- get_all_styles -----------------------------------------------------
  handlers.get_all_styles = async () => {
    const ds = await waitForDS();
    try {
      const styles = ds.theme.styles.getAll();
      const ids = ds.theme.styles.getAllIds();
      return { ok: true, data: { count: ids.length, ids, styles } };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  // -- duplicate_component ------------------------------------------------
  handlers.duplicate_component = async (payload) => {
    const ds = await waitForDS();
    const { elementId } = payload;
    try {
      const newRef = ds.components.duplicate(compRef(elementId));
      return { ok: true, data: { duplicated: elementId, newId: newRef?.id } };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  // -- Command dispatch ---------------------------------------------------

  async function handleCommand(command) {
    const { id, type, payload } = command;

    const handler = handlers[type];
    if (!handler) {
      return { id, ok: false, error: `Unknown command type: ${type}` };
    }

    try {
      const result = await handler(payload || {});
      return { id, ...result };
    } catch (e) {
      return { id, ok: false, error: `Handler error: ${e.message}` };
    }
  }

  // -- Message listener (commands from ISOLATED world) --------------------

  window.addEventListener('message', async (event) => {
    if (!event.data || !event.data.__plinthWixBridge) return;
    if (event.data.direction !== 'to-main') return;

    const { command } = event.data;
    if (!command) return;

    console.log(`${TAG} Handling command: ${command.type}`);

    const result = await handleCommand(command);

    // Send result back to ISOLATED world
    window.postMessage({
      __plinthWixBridge: true,
      direction: 'to-isolated',
      result,
    }, '*');
  });

  // -- Startup ------------------------------------------------------------

  console.log(`${TAG} Content bridge loaded, waiting for documentServices...`);

  waitForDS(60000).then((ds) => {
    const pageId = ds.pages.getFocusedPageId();
    const pageData = ds.pages.data.get(pageId);
    console.log(`${TAG} documentServices ready — page: ${pageData?.title || pageId}`);
  }).catch((e) => {
    console.warn(`${TAG} documentServices not available: ${e.message}`);
  });
})();
