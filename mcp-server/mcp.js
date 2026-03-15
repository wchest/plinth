'use strict';

// IMPORTANT: stdout is reserved for the MCP JSON-RPC protocol.
// All logging must go to stderr or it will corrupt the message stream.
const logger = require('./lib/logger')('mcp');
const log  = logger.info;
const warn = logger.warn;
const err  = logger.error;
console.log   = log;
console.warn  = warn;
console.error = err;

require('dotenv').config();

const path = require('path');
const fs   = require('fs');

const { McpServer }          = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const SiteRegistry = require('./lib/site-registry');
const { writeToClipboard } = require('./lib/clipboard');
const { takeScreenshot, checkAvailability } = require('./lib/screenshot');

// --- Config resolution -----------------------------------------------
// Same priority order as the HTTP server.

function resolveConfigPath() {
  if (process.env.PLINTH_CONFIG) return path.resolve(process.env.PLINTH_CONFIG);
  const cwdConfig = path.join(process.cwd(), '.plinth.json');
  if (fs.existsSync(cwdConfig)) return cwdConfig;
  return path.join(__dirname, 'sites.json');
}

// --- Helpers ----------------------------------------------------------

function ok(data) {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}

function fail(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// --- Main -------------------------------------------------------------

async function main() {
  const configPath = resolveConfigPath();
  log('Config:', configPath);

  let registry;
  try {
    registry = new SiteRegistry(configPath);
  } catch (e) {
    err(e.message);
    process.exit(1);
  }

  // --- MCP Server ---------------------------------------------------

  const server = new McpServer({
    name: 'plinth',
    version: '2.0.0',
    description: 'Webflow page builder — build sections via content script bridge + XscpData paste',
  });

  // ── Bridge helper ─────────────────────────────────────────────────
  // Sends a command to the content script bridge via the relay and polls for the result.
  async function requestBridge(siteId, type, payload, timeoutMs = 30_000) {
    const relayUrl = registry.relayUrl;

    let reqRes;
    try {
      reqRes = await fetch(
        `${relayUrl}/bridge/request?siteId=${encodeURIComponent(siteId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type, payload: payload || {} }),
        }
      );
    } catch (e) {
      return { error: `Cannot reach relay at ${relayUrl}. Run 'plinth dev' first.` };
    }
    if (!reqRes.ok) return { error: `Relay returned ${reqRes.status} for bridge request.` };

    const { id } = await reqRes.json();

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const resultRes = await fetch(
          `${relayUrl}/bridge/result?siteId=${encodeURIComponent(siteId)}`
        );
        if (resultRes.ok) {
          const data = await resultRes.json();
          if (data.ready) return { result: data };
        }
      } catch { /* keep polling */ }
    }

    return {
      error: `Bridge timed out after ${timeoutMs / 1000} s. Make sure the Plinth Inspector extension ` +
             'is installed and the Webflow Designer is open.',
    };
  }

  // ── health_check ──────────────────────────────────────────────────
  server.tool(
    'health_check',
    'Verify connectivity to Webflow and the content script bridge for all configured sites. ' +
    'Returns site names, API connection status, and bridge availability.',
    {},
    async () => {
      const sites = registry.summary();
      const checks = await Promise.all(
        sites.map(async ({ siteId, name }) => {
          const client = registry.getClient(siteId);
          const apiResult = await client.healthCheck();

          // Check bridge connectivity
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

  // ── list_pages ────────────────────────────────────────────────────
  server.tool(
    'list_pages',
    'List all pages on a Webflow site with their IDs, titles, and slugs. ' +
    'Use this to identify which page to target and get the pageId needed for get_page_dom.',
    {
      siteId: z.string().describe('The Webflow site ID'),
    },
    async ({ siteId }) => {
      let client;
      try {
        client = registry.getClient(siteId);
      } catch (e) {
        return fail(e.message);
      }

      let pages;
      try {
        pages = await client.listPages();
      } catch (e) {
        return fail(`Failed to list pages: ${e.message}`);
      }

      const summary = pages
        .filter((p) => !p.collectionId) // exclude CMS templates
        .map((p) => ({
          id: p.id,
          title: p.title,
          slug: p.slug || '(home)',
          lastUpdated: p.lastUpdated,
        }));

      return ok(summary);
    }
  );

  // ── get_page_dom ──────────────────────────────────────────────────
  server.tool(
    'get_page_dom',
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

  // ── list_styles ───────────────────────────────────────────────────
  server.tool(
    'list_styles',
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

  // ── create_page ──────────────────────────────────────────────────
  server.tool(
    'create_page',
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

  // ── update_page ──────────────────────────────────────────────────
  server.tool(
    'update_page',
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

  // ── switch_page ─────────────────────────────────────────────────
  server.tool(
    'switch_page',
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

  // ── ping ──────────────────────────────────────────────────────────
  server.tool(
    'ping',
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

  // ── execute ───────────────────────────────────────────────────────
  server.tool(
    'execute',
    'Execute a _webflow.creators action via the content script bridge. ' +
    'Calls _webflow.creators[namespace][method](...args) in the Designer page context. ' +
    'Example: namespace="StyleActionCreators", method="setStyle", args=[{path:"backgroundColor",value:"red"}]',
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

  // ── probe ─────────────────────────────────────────────────────────
  server.tool(
    'probe',
    'Evaluate a JavaScript expression in the Designer page context with access to _webflow. ' +
    'Use for debugging and inspecting internal state. ' +
    'Return values are serialized (Immutable objects are converted via .toJS()).',
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

  // ── get_snapshot ──────────────────────────────────────────────────
  server.tool(
    'get_snapshot',
    'Get a structural snapshot of the current Webflow page via the content script bridge. ' +
    'Returns an indented tree of all elements with their types, IDs, class names, and text content, ' +
    'plus a list of all styles. Use this to verify builds and check page structure.',
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

  // ── build_section ─────────────────────────────────────────────────
  server.tool(
    'build_section',
    'Build a section on the Webflow canvas via XscpData paste — the primary build tool. ' +
    'Takes a SectionSpec tree where each node has inline CSS in a `styles` string. ' +
    'Variable references ($var-name) are resolved to Webflow variable UUIDs automatically. ' +
    'Existing styles are reused by name (no duplicates). Shorthand CSS is allowed. ' +
    'Supports responsive breakpoints via `responsive` field on each node. ' +
    'Supports IX2 interactions via `interactions` field on nodes: ' +
    '[{ trigger: "scroll-into-view"|"mouse-hover-in"|"page-load"|..., animation: "fade"|"slide"|"grow"|"pop"|..., duration?: 500, easing?: "ease", delay?: 0 }]. ' +
    'Returns node/style counts. Use get_snapshot + take_screenshot to verify.',
    {
      siteId: z.string().describe('The Webflow site ID'),
      tree: z.record(z.any()).describe(
        'Root element: { type, className, styles: "CSS string", ' +
        'responsive?: { medium?: "CSS overrides", small?: "CSS overrides", tiny?: "CSS overrides" }, ' +
        'interactions?: [{ trigger, animation, duration?, easing?, delay? }], ' +
        'text?, headingLevel?, href?, src?, alt?, children?: [...] }'
      ),
      sharedStyles: z.array(z.record(z.any())).optional().describe(
        'Styles not attached to elements in this section: [{ name, styles: "CSS string", responsive?: {...} }]'
      ),
      insertAfterSectionClass: z.string().optional().describe(
        'CSS class of the section to insert after (section is reordered post-paste)'
      ),
      insertAfterElementId: z.string().optional().describe(
        'Element ID to insert after (from get_snapshot)'
      ),
      parentElementId: z.string().optional().describe(
        'Element ID to paste inside as a child'
      ),
      ix2: z.record(z.any()).optional().describe(
        'IX2 interaction data to merge into the XscpData (from captured templates)'
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

  // ── delete_elements ───────────────────────────────────────────────
  server.tool(
    'delete_elements',
    'Delete elements from the Webflow canvas by their IDs (from get_snapshot). ' +
    'Elements are deleted via NODE_CLICKED + DELETE_KEY_PRESSED dispatch.',
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

  // ── update_styles ─────────────────────────────────────────────────
  server.tool(
    'update_styles',
    'Update CSS properties on existing Webflow styles via the content script bridge. ' +
    'Uses setStyle pipeline (NODE_CLICKED → startSetStyle → setStyle → endSetStyle). ' +
    'Each entry needs a style "name" (must already exist) and "properties" (longhand CSS key-value pairs). ' +
    'Optional "breakpoint" field targets a specific breakpoint (medium, small, tiny). ' +
    'Viewport is switched automatically and returned to desktop after.',
    {
      siteId: z.string().describe('The Webflow site ID'),
      styles: z.array(z.object({
        name: z.string().describe('Style/class name (must already exist in Webflow)'),
        properties: z.record(z.string()).describe('CSS properties to set (longhand only, e.g. "background-color": "transparent")'),
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

  // ── connect_collection ────────────────────────────────────────────
  server.tool(
    'connect_collection',
    'Connect a Collection List (DynamoWrapper) to a CMS collection. ' +
    'Must be called BEFORE bind_field — field bindings require an active collection connection.',
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

  // ── bind_field ────────────────────────────────────────────────────
  server.tool(
    'bind_field',
    'Bind a CMS collection field to an element inside a Collection List (DynamoItem). ' +
    'The Collection List must already be connected (use connect_collection first). ' +
    'Gateway defaults to "dynamoPlainTextToListOfElements" for text fields. ' +
    'Use "dynamoImageToAttributes" for images, "dynamoLinkToAttributes" for links.',
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

  // ── paste_xscp ────────────────────────────────────────────────────
  server.tool(
    'paste_xscp',
    'Paste a @webflow/XscpData payload into the Webflow Designer via synthetic paste event. ' +
    'Works for all element types including complex/factory elements (Navbar, Slider, Tabs, etc.).',
    {
      siteId: z.string().describe('The Webflow site ID'),
      xscpData: z.record(z.any()).describe(
        'Complete @webflow/XscpData object: { type: "@webflow/XscpData", payload: { nodes: [...], styles: [...], assets: [], ix1: [], ix2: {...} }, meta: {...} }'
      ),
      targetElementId: z.string().describe(
        'Element ID to select before pasting — paste inserts as child of this element.'
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

  // ── list_variables ────────────────────────────────────────────────
  server.tool(
    'list_variables',
    'List all style variables defined in the Webflow site. ' +
    'Returns variable names, IDs, values, and types. ' +
    'Use variable names with $name syntax in build_section styles for automatic resolution.',
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

  // ── create_variables ──────────────────────────────────────────────
  server.tool(
    'create_variables',
    'Create style variables in the Webflow Designer. ' +
    'Variables are persisted to the server and immediately available for use ' +
    'with $name syntax in build_section styles. ' +
    'Supported types: color, length (size), font-family, number, percentage.',
    {
      siteId: z.string().describe('The Webflow site ID'),
      variables: z.array(z.object({
        name: z.string().describe('Variable name (e.g. "Brand Blue")'),
        type: z.enum(['color', 'length', 'font-family', 'number', 'percentage']).default('color')
          .describe('Variable type'),
        value: z.any().describe('Variable value. Color: "#FF0000" or "hsla(...)". Length: {value: 16, unit: "px"}. Font-family: "Inter". Number/percentage: 1.5'),
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

  // ── add_interactions ─────────────────────────────────────────────
  server.tool(
    'add_interactions',
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
      // Step 1: Build IX2 XscpData via bridge (no paste — just returns JSON)
      const { result, error } = await requestBridge(siteId, 'add_interactions', { interactions }, 15_000);
      if (error) return fail(error);
      if (!result.ok) return fail(result.error);
      const d = result.data;

      // Step 2: Get body ID from snapshot tree (first line: "Body#<id>")
      const snap = await requestBridge(siteId, 'snapshot', {}, 10_000);
      if (snap.error) return fail(`Built IX2 but snapshot failed: ${snap.error}`);
      const tree = snap.result?.data?.summary;
      const bodyMatch = tree && tree.match(/^Body#([a-f0-9-]+)/);
      if (!bodyMatch) return fail('Built IX2 but could not find body element ID');
      const bodyId = bodyMatch[1];

      // Step 3: Paste XscpData onto body
      const paste = await requestBridge(siteId, 'paste', {
        xscpData: d.xscpData,
        targetElementId: bodyId,
      }, 15_000);
      if (paste.error) return fail(`Built IX2 but paste failed: ${paste.error}`);

      // Step 4: Find and delete carrier (classless DivBlock at end of body)
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

  // ── list_interactions ────────────────────────────────────────────
  server.tool(
    'list_interactions',
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

  // ── remove_interactions ─────────────────────────────────────────
  server.tool(
    'remove_interactions',
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

  // ── capture_xscp ─────────────────────────────────────────────────
  server.tool(
    'capture_xscp',
    'Capture the XscpData (copy payload) for an element on the Webflow canvas. ' +
    'Selects the element, triggers copy, and returns the complete XscpData JSON ' +
    'including nodes, styles, and ix2 interactions. ' +
    'Use this to capture templates for replay with build_section or paste_xscp.',
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

  // ── copy_to_webflow ───────────────────────────────────────────────
  server.tool(
    'copy_to_webflow',
    'Copy a @webflow/XscpData payload to the system clipboard so it can be pasted ' +
    'directly into the Webflow Designer with Ctrl+V / Cmd+V.',
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

  // ── take_screenshot ───────────────────────────────────────────────
  server.tool(
    'take_screenshot',
    'Publish the site to its Webflow staging subdomain (.webflow.io) then take a screenshot ' +
    'and return it as an image. Use sectionClass to screenshot just the built section.',
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

  // --- Connect stdio transport --------------------------------------

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('MCP server connected via stdio.');
}

main().catch((e) => {
  process.stderr.write(`[plinth] Fatal: ${e.message}\n`);
  process.exit(1);
});
