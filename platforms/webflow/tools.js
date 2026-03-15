'use strict';

const { z } = require('zod');
const { writeToClipboard } = require('../../core/lib/clipboard');
const { takeScreenshot, checkAvailability } = require('../../core/lib/screenshot');

/**
 * Register all Webflow-specific MCP tools.
 */
function registerTools(server, registry, { ok, fail, requestBridge, log }) {

  // -- health_check ---------------------------------------------------
  server.tool(
    'wf_health_check',
    'Verify connectivity to Webflow and the content script bridge for all configured sites. ' +
    'Returns site names, API connection status, and bridge availability.',
    {},
    async () => {
      const sites = registry.summary().filter(s => s.platform === 'webflow');
      const checks = await Promise.all(
        sites.map(async ({ siteId, name }) => {
          const client = registry.getClient(siteId);
          const apiResult = await client.healthCheck();

          let bridgeOk = false;
          let bridgeError = null;
          try {
            const { result, error } = await requestBridge(siteId, 'ping', {}, 5_000);
            if (error) {
              bridgeError = error;
            } else if (result && result.ok) {
              bridgeOk = true;
            } else {
              bridgeError = result?.error || 'ping returned not-ok';
            }
          } catch (e) {
            bridgeError = e.message;
          }

          return {
            name,
            siteId,
            api: apiResult.connected ? 'connected' : apiResult.error,
            bridge: bridgeOk ? 'connected' : (bridgeError || 'not connected'),
          };
        })
      );
      return ok(checks);
    }
  );

  // -- list_pages -----------------------------------------------------
  server.tool(
    'wf_list_pages',
    'List all pages on a Webflow site with their IDs, titles, and slugs. ' +
    'Use this to identify which page to target and get the pageId needed for get_page_dom.',
    {
      siteId: z.string().describe('The Webflow site ID'),
    },
    async ({ siteId }) => {
      let client;
      try { client = registry.getClient(siteId); } catch (e) { return fail(e.message); }

      let pages;
      try {
        pages = await client.listPages();
      } catch (e) {
        return fail(`Failed to list pages: ${e.message}`);
      }

      const summary = pages
        .filter((p) => !p.collectionId)
        .map((p) => ({
          id: p.id,
          title: p.title,
          slug: p.slug || '(home)',
          lastUpdated: p.lastUpdated,
        }));

      return ok(summary);
    }
  );

  // -- get_page_dom ---------------------------------------------------
  server.tool(
    'wf_get_page_dom',
    'Get the content and class names on a Webflow page via the Data API. Returns all text ' +
    'nodes with their CSS class names and text content. Use this to see what exists on a page ' +
    'without needing the bridge connected.',
    {
      siteId: z.string().describe('The Webflow site ID'),
      pageId: z.string().describe('The page ID (from list_pages)'),
    },
    async ({ siteId, pageId }) => {
      let client;
      try { client = registry.getClient(siteId); } catch (e) { return fail(e.message); }

      let allNodes = [];
      let offset = 0;
      const limit = 100;
      try {
        while (true) {
          const data = await client.getPageContent(pageId, { limit, offset });
          const nodes = (data && data.nodes) ? data.nodes : [];
          allNodes = allNodes.concat(nodes);
          if (!data.pagination || allNodes.length >= data.pagination.total) break;
          offset += limit;
        }
      } catch (e) {
        return fail(`Failed to get page content: ${e.message}`);
      }

      if (allNodes.length === 0) {
        return ok('Page has no content nodes. It may be empty or unpublished.');
      }

      const classPattern = /class="([^"]+)"/g;
      const allClasses = new Set();
      const lines = [];

      for (const node of allNodes) {
        const html = node.text?.html || '';
        const text = node.text?.text?.trim().replace(/\s+/g, ' ') || '';
        if (!text) continue;

        let match;
        const nodeClasses = [];
        classPattern.lastIndex = 0;
        while ((match = classPattern.exec(html)) !== null) {
          for (const cls of match[1].split(/\s+/)) {
            if (cls) { nodeClasses.push(cls); allClasses.add(cls); }
          }
        }

        const clsStr = nodeClasses.length ? ' .' + nodeClasses.join('.') : '';
        const snippet = text.length > 80 ? text.slice(0, 80) + '…' : text;
        lines.push(`${clsStr || '(no class)'} — "${snippet}"`);
      }

      const classList = [...allClasses].sort().join(', ');
      const summary = [
        `${allNodes.length} content nodes on page:\n`,
        lines.join('\n'),
        `\n── Class names in use ──`,
        classList || '(none)',
      ].join('\n');

      return ok(summary);
    }
  );

  // -- list_styles ----------------------------------------------------
  server.tool(
    'wf_list_styles',
    'List all CSS class names used on a Webflow page via the Data API. ' +
    'Use this to see what styles exist before building — reference them rather than recreating.',
    {
      siteId: z.string().describe('The Webflow site ID'),
      pageId: z.string().describe('The page ID (from list_pages)'),
    },
    async ({ siteId, pageId }) => {
      let client;
      try { client = registry.getClient(siteId); } catch (e) { return fail(e.message); }

      let allNodes = [];
      let offset = 0;
      const limit = 100;
      try {
        while (true) {
          const data = await client.getPageContent(pageId, { limit, offset });
          const nodes = (data && data.nodes) ? data.nodes : [];
          allNodes = allNodes.concat(nodes);
          if (!data.pagination || allNodes.length >= data.pagination.total) break;
          offset += limit;
        }
      } catch (e) {
        return fail(`Failed to get page content: ${e.message}`);
      }

      const classPattern = /class="([^"]+)"/g;
      const allClasses = new Set();
      for (const node of allNodes) {
        const html = node.text?.html || '';
        let match;
        classPattern.lastIndex = 0;
        while ((match = classPattern.exec(html)) !== null) {
          for (const cls of match[1].split(/\s+/)) {
            if (cls) allClasses.add(cls);
          }
        }
      }

      const classes = [...allClasses].sort();
      return ok({ count: classes.length, classes });
    }
  );

  // -- create_page ----------------------------------------------------
  server.tool(
    'wf_create_page',
    'Create a new static page via the Designer bridge (UI simulation). ' +
    'Returns the new page ID. Optionally sets SEO/OG metadata after creation.',
    {
      siteId: z.string().describe('The Webflow site ID'),
      name: z.string().describe('Page name (e.g. "About Us")'),
      slug: z.string().optional().describe('URL slug'),
      seoTitle: z.string().optional().describe('SEO meta title'),
      seoDescription: z.string().optional().describe('SEO meta description'),
      ogTitle: z.string().optional().describe('Open Graph title'),
      ogDescription: z.string().optional().describe('Open Graph description'),
    },
    async ({ siteId, name, slug, seoTitle, seoDescription, ogTitle, ogDescription }) => {
      try {
        const createResult = await requestBridge(siteId, 'create_page', { name });
        if (!createResult.created) {
          return fail(`Page creation failed: ${createResult.error || 'unknown error'}`);
        }

        const pageId = createResult.pageId;
        const result = { created: true, name, pageId };

        if (pageId && (slug || seoTitle || seoDescription || ogTitle || ogDescription)) {
          try {
            const savePayload = { pageId };
            if (slug) savePayload.slug = slug;
            if (seoTitle) savePayload.seoTitle = seoTitle;
            if (seoDescription) savePayload.seoDescription = seoDescription;
            if (ogTitle) savePayload.ogTitle = ogTitle;
            if (ogDescription) savePayload.ogDescription = ogDescription;
            const saveResult = await requestBridge(siteId, 'save_page', savePayload);
            result.metadataSaved = saveResult.saved || false;
          } catch (e) {
            result.metadataError = e.message;
          }
        }

        return ok(result);
      } catch (e) {
        return fail(`Failed to create page: ${e.message}`);
      }
    }
  );

  // -- update_page ----------------------------------------------------
  server.tool(
    'wf_update_page',
    'Update a page\'s settings (name, slug, SEO, Open Graph, custom code) via the Designer bridge.',
    {
      siteId: z.string().describe('The Webflow site ID'),
      pageId: z.string().describe('The page ID to update'),
      name: z.string().optional().describe('New page name'),
      slug: z.string().optional().describe('New URL slug'),
      seoTitle: z.string().optional().describe('SEO meta title'),
      seoDescription: z.string().optional().describe('SEO meta description'),
      ogTitle: z.string().optional().describe('Open Graph title'),
      ogDescription: z.string().optional().describe('Open Graph description'),
      head: z.string().optional().describe('Custom code in <head> tag'),
      postBody: z.string().optional().describe('Custom code before </body> tag'),
    },
    async ({ siteId, pageId, name, slug, seoTitle, seoDescription, ogTitle, ogDescription, head, postBody }) => {
      try {
        const payload = { pageId };
        if (name) payload.name = name;
        if (slug) payload.slug = slug;
        if (seoTitle) payload.seoTitle = seoTitle;
        if (seoDescription) payload.seoDescription = seoDescription;
        if (ogTitle) payload.ogTitle = ogTitle;
        if (ogDescription) payload.ogDescription = ogDescription;
        if (head) payload.head = head;
        if (postBody) payload.postBody = postBody;
        const result = await requestBridge(siteId, 'save_page', payload);
        return ok(result);
      } catch (e) {
        return fail(`Failed to update page: ${e.message}`);
      }
    }
  );

  // -- switch_page ----------------------------------------------------
  server.tool(
    'wf_switch_page',
    'Switch the Designer to a different page. Required before building content on a non-current page.',
    {
      siteId: z.string().describe('The Webflow site ID'),
      pageId: z.string().describe('The page ID to switch to'),
    },
    async ({ siteId, pageId }) => {
      try {
        const result = await requestBridge(siteId, 'switch_page', { pageId });
        return ok(result);
      } catch (e) {
        return fail(`Failed to switch page: ${e.message}`);
      }
    }
  );

  // -- ping -----------------------------------------------------------
  server.tool(
    'wf_ping',
    'Check if the content script bridge is connected and can reach _webflow.creators. ' +
    'Returns { ready, creatorsAvailable, creatorsCount }.',
    {
      siteId: z.string().describe('The Webflow site ID'),
    },
    async ({ siteId }) => {
      const { result, error } = await requestBridge(siteId, 'ping');
      if (error) return fail(error);
      if (!result.ok) return fail(`Ping failed: ${result.error}`);
      return ok(result.data);
    }
  );

  // -- execute --------------------------------------------------------
  server.tool(
    'wf_execute',
    'Execute a _webflow.creators action via the content script bridge. ' +
    'Calls _webflow.creators[namespace][method](...args) in the Designer page context.',
    {
      siteId:    z.string().describe('The Webflow site ID'),
      namespace: z.string().describe('Creator namespace (e.g. "StyleActionCreators")'),
      method:    z.string().describe('Method name on the namespace (e.g. "setStyle")'),
      args:      z.array(z.any()).optional().describe('Arguments to pass to the method. Default: []'),
    },
    async ({ siteId, namespace, method, args = [] }) => {
      const { result, error } = await requestBridge(siteId, 'execute', { namespace, method, args });
      if (error) return fail(error);
      if (!result.ok) return fail(`Execute failed: ${result.error}`);
      return ok(result.data);
    }
  );

  // -- probe ----------------------------------------------------------
  server.tool(
    'wf_probe',
    'Evaluate a JavaScript expression in the Designer page context with access to _webflow. ' +
    'Use for debugging and inspecting internal state.',
    {
      siteId: z.string().describe('The Webflow site ID'),
      expr: z.string().describe(
        'JavaScript expression to evaluate. Has access to _webflow. ' +
        'Example: "_webflow.state.PageStore.currentPage"'
      ),
    },
    async ({ siteId, expr }) => {
      const { result, error } = await requestBridge(siteId, 'probe', { expr });
      if (error) return fail(error);
      if (!result.ok) return fail(`Probe failed: ${result.error}`);
      return ok(result.data);
    }
  );

  // -- get_snapshot ---------------------------------------------------
  server.tool(
    'wf_get_snapshot',
    'Get a structural snapshot of the current Webflow page via the content script bridge. ' +
    'Returns an indented tree of all elements with their types, IDs, class names, and text content.',
    {
      siteId: z.string().describe('The Webflow site ID'),
    },
    async ({ siteId }) => {
      const { result, error } = await requestBridge(siteId, 'snapshot');
      if (error) return fail(error);
      if (!result.ok) return fail(`Snapshot failed: ${result.error}`);
      const d = result.data;
      const pageLabel = d.pageInfo?.name ? `Page: ${d.pageInfo.name}\n\n` : '';
      return ok(`${pageLabel}${d.summary}`);
    }
  );

  // -- build_section --------------------------------------------------
  server.tool(
    'wf_build_section',
    'Build a section on the Webflow canvas via XscpData paste — the primary build tool. ' +
    'Takes a SectionSpec tree where each node has inline CSS in a `styles` string. ' +
    'Variable references ($var-name) are resolved to Webflow variable UUIDs automatically.',
    {
      siteId: z.string().describe('The Webflow site ID'),
      tree: z.record(z.any()).describe(
        'Root element: { type, className, styles: "CSS string", ' +
        'responsive?: { medium?: "CSS overrides", small?: "CSS overrides", tiny?: "CSS overrides" }, ' +
        'text?, headingLevel?, href?, src?, alt?, children?: [...] }'
      ),
      sharedStyles: z.array(z.record(z.any())).optional().describe(
        'Styles not attached to elements in this section'
      ),
      insertAfterSectionClass: z.string().optional().describe(
        'CSS class of the section to insert after'
      ),
      insertAfterElementId: z.string().optional().describe(
        'Element ID to insert after (from get_snapshot)'
      ),
      parentElementId: z.string().optional().describe(
        'Element ID to paste inside as a child'
      ),
      ix2: z.record(z.any()).optional().describe(
        'IX2 interaction data to merge into the XscpData'
      ),
    },
    async ({ siteId, tree, sharedStyles, insertAfterSectionClass, insertAfterElementId, parentElementId, ix2 }) => {
      const payload = { tree };
      if (sharedStyles) payload.sharedStyles = sharedStyles;
      if (insertAfterSectionClass) payload.insertAfterSectionClass = insertAfterSectionClass;
      if (insertAfterElementId) payload.insertAfterElementId = insertAfterElementId;
      if (parentElementId) payload.parentElementId = parentElementId;
      if (ix2) payload.ix2 = ix2;

      const { result, error } = await requestBridge(siteId, 'build_v2', payload, 30_000);
      if (error) return fail(error);
      if (!result.ok) return fail(`Build failed: ${result.error}`);

      const d = result.data;
      const parts = [`Pasted ${d.nodeCount} nodes, ${d.styleCount} styles.`];
      if (d.reordered) parts.push('Reordered to requested position.');
      if (d.rootId) parts.push(`Root: ${d.rootId.substring(0, 8)}…`);

      return ok(parts.join(' '));
    }
  );

  // -- delete_elements ------------------------------------------------
  server.tool(
    'wf_delete_elements',
    'Delete elements from the Webflow canvas by their IDs (from get_snapshot).',
    {
      siteId: z.string().describe('The Webflow site ID'),
      elementIds: z.array(z.string()).describe('Array of element IDs to delete'),
    },
    async ({ siteId, elementIds }) => {
      const { result, error } = await requestBridge(siteId, 'delete', { elementIds }, 120_000);
      if (error) return fail(error);
      if (!result.ok) return fail(`Delete failed: ${result.error}`);

      const d = result.data;
      const parts = [`Deleted ${d.deleted} element(s).`];
      if (d.errors && d.errors.length > 0) parts.push(`Errors: ${d.errors.join('; ')}`);
      return ok(parts.join(' '));
    }
  );

  // -- update_styles --------------------------------------------------
  server.tool(
    'wf_update_styles',
    'Update CSS properties on existing Webflow styles via the content script bridge. ' +
    'Optional "breakpoint" field targets a specific breakpoint (medium, small, tiny).',
    {
      siteId: z.string().describe('The Webflow site ID'),
      styles: z.array(z.object({
        name: z.string().describe('Style/class name (must already exist in Webflow)'),
        properties: z.record(z.string()).describe('CSS properties to set (longhand only)'),
        breakpoint: z.enum(['main', 'medium', 'small', 'tiny']).optional().describe('Target breakpoint (default: main/desktop)'),
      })).describe('Array of styles to update'),
    },
    async ({ siteId, styles }) => {
      const timeout = 10_000 + styles.length * 2_000;
      const { result, error } = await requestBridge(siteId, 'update_styles', { styles }, timeout);
      if (error) return fail(error);
      if (!result.ok) return fail(`Update styles failed: ${result.error}`);

      const d = result.data;
      return ok({
        updated: d.updated,
        failed: d.failed,
        results: d.results
      });
    }
  );

  // -- connect_collection ---------------------------------------------
  server.tool(
    'wf_connect_collection',
    'Connect a Collection List (DynamoWrapper) to a CMS collection.',
    {
      siteId: z.string().describe('The Webflow site ID'),
      elementId: z.string().describe('UUID of the DynamoWrapper element'),
      collectionId: z.string().describe('CMS collection ID to connect'),
    },
    async ({ siteId, elementId, collectionId }) => {
      const { result, error } = await requestBridge(siteId, 'connect_collection', { elementId, collectionId });
      if (error) return fail(error);
      if (!result.ok) return fail(`Connect collection failed: ${result.error}`);

      const d = result.data;
      return ok(`Connected DynamoWrapper ${d.elementId.substring(0, 8)} to collection ${d.collectionId}`);
    }
  );

  // -- bind_field -----------------------------------------------------
  server.tool(
    'wf_bind_field',
    'Bind a CMS collection field to an element inside a Collection List (DynamoItem).',
    {
      siteId: z.string().describe('The Webflow site ID'),
      elementId: z.string().describe('UUID of the element to bind the field to'),
      fieldSlug: z.string().describe('CMS collection field slug (e.g. "name", "quote")'),
      gateway: z.string().optional().describe('DynamoGateway function name (default: dynamoPlainTextToListOfElements)'),
    },
    async ({ siteId, elementId, fieldSlug, gateway }) => {
      const payload = { elementId, fieldSlug };
      if (gateway) payload.gateway = gateway;
      const { result, error } = await requestBridge(siteId, 'bind', payload);
      if (error) return fail(error);
      if (!result.ok) return fail(`Bind failed: ${result.error}`);
      const d = result.data;
      if (!d.bound) return fail(d.error || 'Bind returned false');
      return ok(`Bound field "${d.fieldSlug}" to element ${d.elementId.substring(0, 8)} via ${d.gateway}`);
    }
  );

  // -- paste_xscp -----------------------------------------------------
  server.tool(
    'wf_paste_xscp',
    'Paste a @webflow/XscpData payload into the Webflow Designer via synthetic paste event.',
    {
      siteId: z.string().describe('The Webflow site ID'),
      xscpData: z.record(z.any()).describe(
        'Complete @webflow/XscpData object'
      ),
      targetElementId: z.string().describe(
        'Element ID to select before pasting'
      ),
    },
    async ({ siteId, xscpData, targetElementId }) => {
      if (xscpData.type !== '@webflow/XscpData') {
        return fail('xscpData.type must be "@webflow/XscpData"');
      }
      if (!xscpData.payload?.nodes || !Array.isArray(xscpData.payload.nodes)) {
        return fail('xscpData.payload.nodes must be an array');
      }
      const payload = { xscpData, targetElementId };
      const { result, error } = await requestBridge(siteId, 'paste', payload);
      if (error) return fail(error);
      if (!result.ok) return fail(`Paste failed: ${result.error}`);
      const d = result.data;
      if (!d.pasted) return fail(d.error || 'Paste returned false');
      return ok(`Pasted ${d.nodeCount} nodes (target: ${d.targetElementId.substring(0, 8)}…)`);
    }
  );

  // -- list_variables -------------------------------------------------
  server.tool(
    'wf_list_variables',
    'List all style variables defined in the Webflow site.',
    {
      siteId: z.string().describe('The Webflow site ID'),
    },
    async ({ siteId }) => {
      const { result, error } = await requestBridge(siteId, 'list_variables', {});
      if (error) return fail(error);
      if (!result.ok) return fail(`List variables failed: ${result.error}`);

      const d = result.data;
      if (d.error) {
        return ok(`Found ${d.count || 0} variables (with warning: ${d.error}):\n${JSON.stringify(d.variables, null, 2)}`);
      }
      return ok(`Found ${d.count} variables:\n${JSON.stringify(d.variables, null, 2)}`);
    }
  );

  // -- create_variables -----------------------------------------------
  server.tool(
    'wf_create_variables',
    'Create style variables in the Webflow Designer.',
    {
      siteId: z.string().describe('The Webflow site ID'),
      variables: z.array(z.object({
        name: z.string().describe('Variable name (e.g. "Brand Blue")'),
        type: z.enum(['color', 'length', 'font-family', 'number', 'percentage']).default('color')
          .describe('Variable type'),
        value: z.any().describe('Variable value'),
      })).describe('Array of variables to create'),
      collectionId: z.string().optional()
        .describe('Variable collection ID. Omit to use the first non-default collection.'),
    },
    async ({ siteId, variables, collectionId }) => {
      const payload = { variables };
      if (collectionId) payload.collectionId = collectionId;

      const { result, error } = await requestBridge(siteId, 'create_variables', payload);
      if (error) return fail(error);
      if (!result.ok) return fail(`Create variables failed: ${result.error}`);

      const d = result.data;
      if (d.error) return fail(d.error);

      let msg = `Created ${d.count} variable(s) in collection ${d.collectionId}:\n`;
      msg += JSON.stringify(d.created, null, 2);
      if (d.errors) msg += `\nErrors:\n${JSON.stringify(d.errors, null, 2)}`;
      return ok(msg);
    }
  );

  // -- capture_xscp ---------------------------------------------------
  server.tool(
    'wf_capture_xscp',
    'Capture the XscpData (copy payload) for an element on the Webflow canvas.',
    {
      siteId: z.string().describe('The Webflow site ID'),
      elementId: z.string().describe('UUID of the element to capture'),
    },
    async ({ siteId, elementId }) => {
      const { result, error } = await requestBridge(siteId, 'capture_xscp', { elementId }, 15_000);
      if (error) return fail(error);
      if (!result.ok) return fail(`Capture failed: ${result.error}`);

      const d = result.data;
      if (!d.captured) return fail(d.error || 'Capture returned false');

      return ok({
        captured: true,
        elementId: d.elementId,
        nodeCount: d.nodeCount,
        styleCount: d.styleCount,
        xscpData: d.xscpData
      });
    }
  );

  // -- copy_to_webflow ------------------------------------------------
  server.tool(
    'wf_copy_to_webflow',
    'Copy a @webflow/XscpData payload to the system clipboard for manual paste.',
    {
      payload: z
        .record(z.any())
        .describe('The complete @webflow/XscpData object to copy to clipboard'),
    },
    async ({ payload }) => {
      if (payload.type !== '@webflow/XscpData') {
        return fail('payload.type must be "@webflow/XscpData"');
      }
      if (!payload.payload?.nodes || !Array.isArray(payload.payload.nodes)) {
        return fail('payload.payload.nodes must be an array');
      }
      if (!payload.payload?.styles || !Array.isArray(payload.payload.styles)) {
        return fail('payload.payload.styles must be an array');
      }

      const json = JSON.stringify(payload);

      let method;
      try {
        ({ method } = writeToClipboard(json, 'application/json'));
      } catch (e) {
        return fail(`Clipboard write failed: ${e.message}`);
      }

      const nodeCount  = payload.payload.nodes.length;
      const styleCount = payload.payload.styles.length;

      return ok(
        `Copied to clipboard via ${method} (${nodeCount} nodes, ${styleCount} styles).\n` +
        `Switch to Webflow Designer and press Ctrl+V (or Cmd+V) to paste.`,
      );
    }
  );

  // -- add_interactions ------------------------------------------------
  server.tool(
    'wf_add_interactions',
    'Add IX2 interactions to existing elements by class name. ' +
    'Pastes IX2 data via a carrier div (auto-deleted). Each entry targets a class. ' +
    'Triggers: scroll-into-view, scroll-out-of-view, mouse-hover-in, mouse-hover-out, mouse-click, page-load, page-scroll. ' +
    'Animations: fade, fade-up, fade-down, fade-left, fade-right, slide, grow, shrink, spin, fly, pop, flip, bounce, drop. ' +
    'Compound animations (fade-up etc.) combine opacity + transform.',
    {
      siteId: z.string().describe('The Webflow site ID'),
      interactions: z.array(z.object({
        className: z.string().describe('CSS class to target (must exist on page)'),
        trigger: z.string().describe('Trigger type: scroll-into-view, page-load, mouse-hover-in, etc.'),
        animation: z.string().describe('Animation: fade-up, fade, slide, grow, pop, etc.'),
        duration: z.number().optional().describe('Animation duration in ms (default: 500)'),
        easing: z.string().optional().describe('Easing function (default: ease)'),
        delay: z.number().optional().describe('Delay before animation in ms (default: 0)'),
        distance: z.number().optional().describe('Move distance in px for fade-up/down/left/right (default: 28)'),
      })).describe('Array of interactions to add'),
    },
    async ({ siteId, interactions }) => {
      const { result, error } = await requestBridge(siteId, 'add_interactions', { interactions }, 15_000);
      if (error) return fail(error);
      if (!result.ok) return fail(result.error);
      const d = result.data;

      const snap = await requestBridge(siteId, 'snapshot', {}, 10_000);
      if (snap.error) return fail(`Built IX2 but snapshot failed: ${snap.error}`);
      const tree = snap.result?.data?.summary;
      const bodyMatch = tree && tree.match(/^Body#([a-f0-9-]+)/);
      if (!bodyMatch) return fail('Built IX2 but could not find body element ID');
      const bodyId = bodyMatch[1];

      const paste = await requestBridge(siteId, 'paste', {
        xscpData: d.xscpData,
        targetElementId: bodyId,
      }, 15_000);
      if (paste.error) return fail(`Built IX2 but paste failed: ${paste.error}`);

      await new Promise(r => setTimeout(r, 1000));
      const snap2 = await requestBridge(siteId, 'snapshot', {}, 10_000);
      const tree2 = snap2.result?.data?.summary;
      if (tree2) {
        const lines = tree2.split('\n');
        const bodyChildren = [];
        let inBody = false;
        for (const line of lines) {
          if (line.startsWith('Body#')) { inBody = true; continue; }
          if (inBody && !line.startsWith('  ')) break;
          if (inBody && line.startsWith('  ') && !line.startsWith('    ')) {
            const m = line.match(/#([a-f0-9-]+)/);
            const hasClass = line.includes('.');
            if (m) bodyChildren.push({ id: m[1], hasClass });
          }
        }
        const last = bodyChildren[bodyChildren.length - 1];
        if (last && !last.hasClass) {
          const del = await requestBridge(siteId, 'delete', { elementIds: [last.id] }, 10_000);
          if (del.result?.ok) {
            return ok(`Added ${d.added} interaction(s). Carrier div removed.`);
          }
        }
      }

      return ok(`Added ${d.added} interaction(s). Carrier div may need manual deletion.`);
    }
  );

  // -- list_interactions ------------------------------------------------
  server.tool(
    'wf_list_interactions',
    'List all IX2 interactions on the current page. Returns events (triggers), ' +
    'action lists (animations), and interactions. Use to audit existing interactions.',
    {
      siteId: z.string().describe('The Webflow site ID'),
    },
    async ({ siteId }) => {
      const { result, error } = await requestBridge(siteId, 'list_interactions', {}, 10_000);
      if (error) return fail(error);
      if (!result.ok) return fail(result.error);
      const d = result.data;
      let msg = `Events: ${d.events.length}, Action Lists: ${d.actionLists.length}, Interactions: ${d.interactions.length}`;
      if (d.events.length > 0) {
        msg += '\n\nEvents:';
        for (const e of d.events) {
          msg += `\n  ${e.id}: ${e.eventTypeId} → ${e.actionTypeId} on .${e.targetClass} (${e.appliesTo})`;
        }
      }
      if (d.actionLists.length > 0) {
        msg += '\n\nAction Lists:';
        for (const a of d.actionLists) {
          msg += `\n  ${a.id}: ${a.title}`;
        }
      }
      return ok(msg);
    }
  );

  // -- remove_interactions ------------------------------------------------
  server.tool(
    'wf_remove_interactions',
    'Remove IX2 interactions. Pass eventIds to remove specific events (and their action lists), ' +
    'or omit to clear all interactions on the page.',
    {
      siteId: z.string().describe('The Webflow site ID'),
      eventIds: z.array(z.string()).optional().describe('Specific event IDs to remove (omit to clear all)'),
    },
    async ({ siteId, eventIds }) => {
      const payload = eventIds ? { eventIds } : {};
      const { result, error } = await requestBridge(siteId, 'remove_interactions', payload, 10_000);
      if (error) return fail(error);
      if (!result.ok) return fail(result.error);
      const d = result.data;
      return ok(`Done. Remaining: ${d.remaining.events} events, ${d.remaining.actionLists} action lists`);
    }
  );

  // -- take_screenshot ------------------------------------------------
  server.tool(
    'wf_take_screenshot',
    'Publish the site to its Webflow staging subdomain (.webflow.io) then take a screenshot.',
    {
      siteId: z.string().describe('The Webflow site ID'),
      sectionClass: z.string().optional().describe(
        'CSS class of the section to screenshot. If omitted, screenshots the full page.'
      ),
      pageSlug: z.string().optional().describe(
        'Page slug to navigate to (e.g. "about"). Omit for the home page.'
      ),
      skipPublish: z.boolean().optional().describe(
        'Skip the publish step and screenshot the current live staging URL. Default: false.'
      ),
    },
    async ({ siteId, sectionClass, pageSlug, skipPublish = false }) => {
      const availability = checkAvailability();
      if (!availability.available) {
        return fail(
          `Screenshot unavailable: ${availability.reason}.\n` +
          `Fix: ${availability.install}`
        );
      }

      let client;
      try { client = registry.getClient(siteId); } catch (e) { return fail(e.message); }

      let siteInfo;
      try {
        siteInfo = await client.getSiteInfo();
      } catch (e) {
        return fail(`Could not get site info: ${e.message}`);
      }

      const shortName = siteInfo.shortName || siteInfo.name;
      if (!shortName) {
        return fail('Could not determine the site\'s Webflow subdomain from the API response.');
      }

      const slug     = pageSlug ? `/${pageSlug.replace(/^\//, '')}` : '';
      const stageUrl = `https://${shortName}.webflow.io${slug}`;

      if (!skipPublish) {
        try {
          log(`Publishing ${siteId} to ${stageUrl}…`);
          await client.publishToStaging();
        } catch (e) {
          return fail(`Failed to publish to staging: ${e.message}`);
        }

        log('Waiting 20 s for staging build to complete…');
        await new Promise((r) => setTimeout(r, 20_000));
      }

      log(`Screenshotting ${stageUrl}${sectionClass ? ` (section: .${sectionClass})` : ' (full page)'}…`);
      let base64;
      try {
        base64 = await takeScreenshot(stageUrl, { sectionClass });
      } catch (e) {
        return fail(`Screenshot failed: ${e.message}`);
      }

      const label = sectionClass
        ? `Section .${sectionClass} on ${stageUrl}`
        : `Full page: ${stageUrl}`;

      return {
        content: [
          { type: 'text', text: label },
          { type: 'image', data: base64, mimeType: 'image/png' },
        ],
      };
    }
  );
}

module.exports = { registerTools };
