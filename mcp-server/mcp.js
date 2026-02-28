'use strict';

// IMPORTANT: stdout is reserved for the MCP JSON-RPC protocol.
// All logging must go to stderr or it will corrupt the message stream.
const log  = (...a) => process.stderr.write('[plinth] ' + a.join(' ') + '\n');
const warn = (...a) => process.stderr.write('[plinth:warn] ' + a.join(' ') + '\n');
const err  = (...a) => process.stderr.write('[plinth:error] ' + a.join(' ') + '\n');
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
const { validateBuildPlan, ValidationError } = require('./lib/validator');

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

  await registry.discoverAll();

  // --- MCP Server ---------------------------------------------------

  const server = new McpServer({
    name: 'plinth',
    version: '1.0.0',
    description: 'Webflow page builder — queue BuildPlans for the Designer Extension to build',
  });

  // ── queue_buildplan ───────────────────────────────────────────────
  server.tool(
    'queue_buildplan',
    'Validate a BuildPlan and add it to the _Build Queue CMS collection. ' +
    'The Webflow Designer Extension polls the queue and materializes the section on canvas. ' +
    'Returns the queue item ID and status. The plan must include version, siteId, sectionName, order, and tree.',
    {
      plan: z
        .record(z.any())
        .describe('The complete BuildPlan object'),
    },
    async ({ plan }) => {
      try {
        validateBuildPlan(plan);
      } catch (e) {
        return fail(`Validation error: ${e.message}`);
      }

      let client;
      try {
        client = registry.getClient(plan.siteId);
      } catch (e) {
        return fail(e.message);
      }

      // Use plan.order if provided; otherwise auto-assign
      let order = typeof plan.order === 'number' ? plan.order : null;
      if (order === null) {
        try {
          const existing = await client.getQueueItems();
          order = existing.length + 1;
        } catch (_) {
          order = 1;
        }
      }

      let item;
      try {
        item = await client.addQueueItem({
          name: plan.sectionName || 'unnamed',
          plan: JSON.stringify(plan),
          order,
        });
      } catch (e) {
        return fail(`Failed to write to queue: ${e.message}`);
      }

      return ok({
        itemId: item.id,
        status: item.status || 'pending',
        siteId: plan.siteId,
        sectionName: plan.sectionName,
        order,
      });
    }
  );

  // ── get_queue_status ──────────────────────────────────────────────
  server.tool(
    'get_queue_status',
    'Get all items in the build queue for a site, ordered by build sequence. ' +
    'Statuses: pending (waiting), building (in progress), done (complete), error (failed).',
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

      let items;
      try {
        items = await client.getQueueItems();
      } catch (e) {
        return fail(`Failed to fetch queue: ${e.message}`);
      }

      return ok(
        items
          .sort((a, b) => a.order - b.order)
          .map(({ id, name, status, order: o, errorMessage }) => ({
            id, name, status, order: o,
            ...(errorMessage ? { errorMessage } : {}),
          }))
      );
    }
  );

  // ── clear_queue ───────────────────────────────────────────────────
  server.tool(
    'clear_queue',
    'Remove all completed (done) and failed (error) items from the build queue for a site.',
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

      let items;
      try {
        items = await client.getQueueItems();
      } catch (e) {
        return fail(`Failed to fetch queue: ${e.message}`);
      }

      const clearable = items.filter((i) => i.status === 'done' || i.status === 'error');
      if (clearable.length === 0) return ok('Queue already clean — no completed items to remove.');

      const results = await Promise.allSettled(clearable.map((i) => client.deleteItem(i.id)));
      const cleared = results.filter((r) => r.status === 'fulfilled').length;
      const failed  = results.length - cleared;

      return ok(
        failed > 0
          ? `Cleared ${cleared} items. ${failed} failed to delete.`
          : `Cleared ${cleared} items.`
      );
    }
  );

  // ── health_check ──────────────────────────────────────────────────
  server.tool(
    'health_check',
    'Verify connectivity to Webflow for all configured sites. ' +
    'Returns site names, connection status, and whether the _Build Queue collection was found.',
    {},
    async () => {
      const sites = registry.summary();
      const checks = await Promise.all(
        sites.map(async ({ siteId, name, queueReady, queueCollectionId }) => {
          const client = registry.getClient(siteId);
          const result = await client.healthCheck();
          return { name, siteId, queueReady, queueCollectionId, ...result };
        })
      );
      return ok(checks);
    }
  );

  // ── list_pages ────────────────────────────────────────────────────
  server.tool(
    'list_pages',
    'List all pages on a Webflow site with their IDs, titles, and slugs. ' +
    'Use this before building to identify which page to target and get the pageId needed for get_page_dom.',
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
    'Get the full element tree of a Webflow page. Returns a structured summary showing all ' +
    'sections, containers, and elements with their types and class names. Use this to understand ' +
    'what already exists on a page before queuing a BuildPlan — prevents building duplicate sections.',
    {
      siteId:  z.string().describe('The Webflow site ID'),
      pageId:  z.string().describe('The page ID (from list_pages)'),
    },
    async ({ siteId, pageId }) => {
      let client;
      try {
        client = registry.getClient(siteId);
      } catch (e) {
        return fail(e.message);
      }

      let dom;
      try {
        dom = await client.getPageDom(pageId);
      } catch (e) {
        return fail(`Failed to get page DOM: ${e.message}`);
      }

      // Debug: show top-level keys when nodes are missing
      const nodes = dom.nodes || [];
      if (nodes.length === 0) {
        const keys = Object.keys(dom || {});
        const firstNode = dom.nodes !== undefined ? '(nodes key exists but empty)' : '(no nodes key)';
        return ok(
          `Page DOM returned 0 nodes.\n` +
          `Response keys: ${keys.join(', ')}\n` +
          `Notes key: ${firstNode}\n` +
          `Raw sample: ${JSON.stringify(dom).slice(0, 500)}\n\n` +
          `NOTE: The Webflow Data API reflects the *saved* state of a page, not live Designer changes. ` +
          `If you built content via the Designer Extension but haven't saved/published, the DOM API ` +
          `will show an empty or older version.`
        );
      }

      // Webflow DOM API returns flat nodes with parentId references — build a tree
      const pagination = dom.pagination;

      function summariseNode(node, depth = 0) {
        const indent = '  '.repeat(depth);
        const tag = node.type || node.tag || '?';
        // classes may be IDs or names depending on API version
        const cls = node.classes && node.classes.length
          ? '.' + node.classes.join('.')
          : '';
        const textVal = node.text || (node.data && node.data.text) || '';
        const text = textVal ? ` "${String(textVal).slice(0, 60)}${String(textVal).length > 60 ? '…' : ''}"` : '';
        const label = `${indent}${tag}${cls}${text}`;
        const children = (node.children || []).map((c) => summariseNode(c, depth + 1));
        return [label, ...children].join('\n');
      }

      const nodeMap = {};
      for (const n of nodes) nodeMap[n.id] = { ...n, children: [] };
      const roots = [];
      for (const n of nodes) {
        if (n.parentId && nodeMap[n.parentId]) {
          nodeMap[n.parentId].children.push(nodeMap[n.id]);
        } else {
          roots.push(nodeMap[n.id]);
        }
      }

      const tree = roots.map((r) => summariseNode(r)).join('\n');
      const paginationNote = pagination && pagination.total > nodes.length
        ? `\n\n(Showing ${nodes.length} of ${pagination.total} nodes — page is truncated)`
        : '';

      return ok(`Page DOM (${nodes.length} nodes):\n\n${tree}${paginationNote}`);
    }
  );

  // ── list_styles ───────────────────────────────────────────────────
  server.tool(
    'list_styles',
    'List all CSS class names used on a specific Webflow page. Use this before generating a BuildPlan to see ' +
    'which class names already exist — reference existing styles in your BuildPlan rather than ' +
    'recreating them, and avoid name collisions. Requires a pageId (get one from list_pages).',
    {
      siteId:  z.string().describe('The Webflow site ID'),
      pageId:  z.string().describe('The page ID (from list_pages)'),
    },
    async ({ siteId, pageId }) => {
      let client;
      try {
        client = registry.getClient(siteId);
      } catch (e) {
        return fail(e.message);
      }

      let result;
      try {
        result = await client.listStylesFromDom(pageId);
      } catch (e) {
        return fail(`Failed to list styles: ${e.message}`);
      }

      return ok({
        count: result.classes.length,
        nodeCount: result.nodeCount,
        classes: result.classes,
      });
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
