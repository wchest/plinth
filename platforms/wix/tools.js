'use strict';

const { z } = require('zod');

/**
 * Register Wix-specific MCP tools.
 *
 * Uses the Document Services API exposed in the Wix editor's preview iframe,
 * accessed via the content script bridge.
 */
function registerTools(server, registry, { ok, fail, requestBridge, log }) {

  // -- wix_health_check ----------------------------------------------------
  server.tool(
    'wix_health_check',
    'Check connectivity to the Wix API and editor bridge for all configured Wix sites.',
    {},
    async () => {
      const sites = registry.summary().filter(s => s.platform === 'wix');
      const checks = await Promise.all(
        sites.map(async ({ siteId, name }) => {
          const client = registry.getClient(siteId);
          const apiResult = await client.healthCheck();

          let bridgeOk = false;
          let bridgeError = null;
          try {
            const { result, error } = await requestBridge(siteId, 'ping', {}, 5_000);
            if (error) bridgeError = error;
            else if (result && result.ok) bridgeOk = true;
            else bridgeError = result?.error || 'ping returned not-ok';
          } catch (e) { bridgeError = e.message; }

          return {
            name, siteId,
            api: apiResult.connected ? 'connected' : apiResult.error,
            bridge: bridgeOk ? 'connected' : (bridgeError || 'not connected'),
          };
        })
      );
      return ok(checks);
    }
  );

  // -- ping ---------------------------------------------------------------
  server.tool(
    'wix_ping',
    'Check if the Wix editor bridge is connected and documentServices is available.',
    { siteId: z.string().describe('The Wix site ID (metaSiteId)') },
    async ({ siteId }) => {
      const { result, error } = await requestBridge(siteId, 'ping');
      if (error) return fail(error);
      if (!result.ok) return fail(`Ping failed: ${result.error}`);
      return ok(result.data);
    }
  );

  // -- get_snapshot -------------------------------------------------------
  server.tool(
    'wix_get_snapshot',
    'Get a structural snapshot of the current Wix page. Returns a tree of all components ' +
    'with their types, IDs, text content, and layout dimensions.',
    { siteId: z.string().describe('The Wix site ID') },
    async ({ siteId }) => {
      const { result, error } = await requestBridge(siteId, 'snapshot');
      if (error) return fail(error);
      if (!result.ok) return fail(`Snapshot failed: ${result.error}`);
      const d = result.data;
      const pageLabel = d.pageInfo?.name ? `Page: ${d.pageInfo.name}\n\n` : '';
      return ok(`${pageLabel}${d.summary}\n\n${d.componentCount} components total.`);
    }
  );

  // -- list_pages ---------------------------------------------------------
  server.tool(
    'wix_list_pages',
    'List all pages on the Wix site with their IDs and titles.',
    { siteId: z.string().describe('The Wix site ID') },
    async ({ siteId }) => {
      const { result, error } = await requestBridge(siteId, 'list_pages');
      if (error) return fail(error);
      if (!result.ok) return fail(`List pages failed: ${result.error}`);
      return ok(result.data);
    }
  );

  // -- switch_page --------------------------------------------------------
  server.tool(
    'wix_switch_page',
    'Navigate the Wix editor to a different page.',
    {
      siteId: z.string().describe('The Wix site ID'),
      pageId: z.string().describe('The page ID to switch to'),
    },
    async ({ siteId, pageId }) => {
      const { result, error } = await requestBridge(siteId, 'switch_page', { pageId });
      if (error) return fail(error);
      if (!result.ok) return fail(`Switch page failed: ${result.error}`);
      return ok(result.data);
    }
  );

  // -- build_section ------------------------------------------------------
  server.tool(
    'wix_build_section',
    'Add a section with components to the Wix page. Takes a tree of components ' +
    'where each node has a type, optional text, layout, and children. ' +
    'Types: Section, Container, Heading, Paragraph, Text, Button, Image.',
    {
      siteId: z.string().describe('The Wix site ID'),
      tree: z.record(z.any()).describe(
        'Root element: { type, text?, layout?: { width, height, x, y }, ' +
        'headingLevel?, href?, src?, alt?, children?: [...] }'
      ),
      insertAfterSectionId: z.string().optional().describe(
        'Component ID of the section to insert after'
      ),
    },
    async ({ siteId, tree, insertAfterSectionId }) => {
      const payload = { tree };
      if (insertAfterSectionId) payload.insertAfterSectionId = insertAfterSectionId;

      const { result, error } = await requestBridge(siteId, 'build_section', payload, 30_000);
      if (error) return fail(error);
      if (!result.ok) return fail(`Build failed: ${result.error}`);

      const d = result.data;
      const parts = [`Added ${d.nodeCount} components.`];
      if (d.rootId) parts.push(`Root: ${d.rootId}`);
      if (d.rootType) parts.push(`Type: ${d.rootType}`);
      return ok(parts.join(' '));
    }
  );

  // -- delete_elements ----------------------------------------------------
  server.tool(
    'wix_delete_elements',
    'Remove components from the Wix page by their IDs (from get_snapshot).',
    {
      siteId: z.string().describe('The Wix site ID'),
      elementIds: z.array(z.string()).describe('Array of component IDs to remove'),
    },
    async ({ siteId, elementIds }) => {
      const { result, error } = await requestBridge(siteId, 'delete', { elementIds }, 30_000);
      if (error) return fail(error);
      if (!result.ok) return fail(`Delete failed: ${result.error}`);
      const d = result.data;
      const parts = [`Deleted ${d.deleted} component(s).`];
      if (d.errors && d.errors.length > 0) parts.push(`Errors: ${d.errors.join('; ')}`);
      return ok(parts.join(' '));
    }
  );

  // -- get_component ------------------------------------------------------
  server.tool(
    'wix_get_component',
    'Get detailed information about a component: type, data, layout, style, design, and children.',
    {
      siteId: z.string().describe('The Wix site ID'),
      elementId: z.string().describe('The component ID'),
    },
    async ({ siteId, elementId }) => {
      const { result, error } = await requestBridge(siteId, 'get_component', { elementId });
      if (error) return fail(error);
      if (!result.ok) return fail(result.error);
      return ok(result.data);
    }
  );

  // -- update_component ---------------------------------------------------
  server.tool(
    'wix_update_component',
    'Update a component\'s data, layout, style, or design properties.',
    {
      siteId: z.string().describe('The Wix site ID'),
      elementId: z.string().describe('The component ID to update'),
      data: z.record(z.any()).optional().describe('Data properties to update'),
      layout: z.record(z.any()).optional().describe('Layout properties to update (x, y, width, height)'),
      style: z.record(z.any()).optional().describe('Style properties to update'),
      design: z.record(z.any()).optional().describe('Design properties to update'),
    },
    async ({ siteId, elementId, data, layout, style, design }) => {
      const { result, error } = await requestBridge(siteId, 'update_component', { elementId, data, layout, style, design });
      if (error) return fail(error);
      if (!result.ok) return fail(result.error);
      return ok(result.data);
    }
  );

  // -- update_styles ------------------------------------------------------
  server.tool(
    'wix_update_styles',
    'Update CSS properties on a Wix component via its cssStyle.',
    {
      siteId: z.string().describe('The Wix site ID'),
      elementId: z.string().describe('The component ID'),
      cssProperties: z.record(z.string()).describe('CSS properties to set (e.g. {"background-color": "red"})'),
    },
    async ({ siteId, elementId, cssProperties }) => {
      const { result, error } = await requestBridge(siteId, 'update_styles', { elementId, cssProperties });
      if (error) return fail(error);
      if (!result.ok) return fail(result.error);
      return ok(result.data);
    }
  );

  // -- get_theme ----------------------------------------------------------
  server.tool(
    'wix_get_theme',
    'Get the Wix site theme including colors, fonts, and text themes.',
    { siteId: z.string().describe('The Wix site ID') },
    async ({ siteId }) => {
      const { result, error } = await requestBridge(siteId, 'get_theme');
      if (error) return fail(error);
      if (!result.ok) return fail(result.error);
      return ok(result.data);
    }
  );

  // -- update_theme_color -------------------------------------------------
  server.tool(
    'wix_update_theme_color',
    'Update a Wix theme color (color_0 through color_35).',
    {
      siteId: z.string().describe('The Wix site ID'),
      colorId: z.string().describe('Color ID (e.g. "color_5")'),
      value: z.string().describe('New color value (hex or rgba)'),
    },
    async ({ siteId, colorId, value }) => {
      const { result, error } = await requestBridge(siteId, 'update_theme_color', { colorId, value });
      if (error) return fail(error);
      if (!result.ok) return fail(result.error);
      return ok(result.data);
    }
  );

  // -- get_text_themes ----------------------------------------------------
  server.tool(
    'wix_get_text_themes',
    'Get all Wix text themes (font_0 through font_10) defining typography styles.',
    { siteId: z.string().describe('The Wix site ID') },
    async ({ siteId }) => {
      const { result, error } = await requestBridge(siteId, 'get_text_themes');
      if (error) return fail(error);
      if (!result.ok) return fail(result.error);
      return ok(result.data);
    }
  );

  // -- create_page --------------------------------------------------------
  server.tool(
    'wix_create_page',
    'Create a new page in the Wix site.',
    {
      siteId: z.string().describe('The Wix site ID'),
      name: z.string().describe('Page name'),
    },
    async ({ siteId, name }) => {
      const { result, error } = await requestBridge(siteId, 'add_page', { name });
      if (error) return fail(error);
      if (!result.ok) return fail(result.error);
      return ok(result.data);
    }
  );

  // -- duplicate_component ------------------------------------------------
  server.tool(
    'wix_duplicate_component',
    'Duplicate a component on the Wix page.',
    {
      siteId: z.string().describe('The Wix site ID'),
      elementId: z.string().describe('The component ID to duplicate'),
    },
    async ({ siteId, elementId }) => {
      const { result, error } = await requestBridge(siteId, 'duplicate_component', { elementId });
      if (error) return fail(error);
      if (!result.ok) return fail(result.error);
      return ok(result.data);
    }
  );

  // -- list_component_types -----------------------------------------------
  server.tool(
    'wix_list_component_types',
    'List all available Wix component types that can be added to the page.',
    { siteId: z.string().describe('The Wix site ID') },
    async ({ siteId }) => {
      const { result, error } = await requestBridge(siteId, 'list_component_types');
      if (error) return fail(error);
      if (!result.ok) return fail(result.error);
      return ok(result.data);
    }
  );
}

module.exports = { registerTools };
