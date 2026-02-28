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

  // ── Snapshot helper ───────────────────────────────────────────────
  // Signals the Designer Extension to capture the live page DOM,
  // then polls until the snapshot arrives (or times out).
  async function requestSnapshot(siteId) {
    const relayUrl = registry.relayUrl;

    // Ask extension to capture
    let reqRes;
    try {
      reqRes = await fetch(
        `${relayUrl}/snapshot/request?siteId=${encodeURIComponent(siteId)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
      );
    } catch (e) {
      return {
        error: `Cannot reach relay at ${relayUrl}. ` +
               `Run 'plinth dev' in your project folder first.`,
      };
    }
    if (!reqRes.ok) {
      return { error: `Relay returned ${reqRes.status} for snapshot request.` };
    }

    // Poll up to 30 s for the extension to respond
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const snapRes = await fetch(
          `${relayUrl}/snapshot?siteId=${encodeURIComponent(siteId)}`
        );
        if (snapRes.ok) {
          return { snapshot: await snapRes.json() };
        }
      } catch { /* keep polling */ }
    }

    return {
      error: 'Snapshot timed out after 30 s. ' +
             'Make sure the Designer Extension is open and connected to the relay.',
    };
  }

  // ── get_page_dom ──────────────────────────────────────────────────
  server.tool(
    'get_page_dom',
    'Capture a live snapshot of the current page as seen in the Webflow Designer. ' +
    'Triggers the Designer Extension to traverse the element tree and return element types, ' +
    'class names, and text — use this before queuing a BuildPlan to see what sections already ' +
    'exist and avoid duplicates. The extension must be open for this to work.',
    {
      siteId: z.string().describe('The Webflow site ID'),
    },
    async ({ siteId }) => {
      const { snapshot, error } = await requestSnapshot(siteId);
      if (error) return fail(error);

      const pageLabel = snapshot.pageInfo?.name
        ? `Page: ${snapshot.pageInfo.name}\n\n`
        : '';
      return ok(`${pageLabel}${snapshot.summary}`);
    }
  );

  // ── list_styles ───────────────────────────────────────────────────
  server.tool(
    'list_styles',
    'List all CSS class names defined on the Webflow site as seen by the Designer Extension. ' +
    'Use this before generating a BuildPlan to see what styles already exist — reference them ' +
    'rather than recreating, and avoid name collisions. The extension must be open for this to work.',
    {
      siteId: z.string().describe('The Webflow site ID'),
    },
    async ({ siteId }) => {
      const { snapshot, error } = await requestSnapshot(siteId);
      if (error) return fail(error);

      // Extract just the styles section from the snapshot summary
      const parts = snapshot.summary.split('── Site styles ──────────────────────');
      const classLine = parts[1] ? parts[1].trim() : '';
      const classes = classLine
        ? classLine.split(',').map((c) => c.trim()).filter(Boolean)
        : [];

      return ok({
        count: classes.length,
        classes,
        note: 'From Designer Extension snapshot — reflects all styles in the site.',
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
