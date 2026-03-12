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
      wait: z
        .boolean()
        .optional()
        .describe('If true, poll until the build completes and return the result. Default: false.'),
    },
    async ({ plan, wait = false }) => {
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

      if (!wait) {
        return ok({
          itemId: item.id,
          status: item.status || 'pending',
          siteId: plan.siteId,
          sectionName: plan.sectionName,
          order,
        });
      }

      // Poll via the relay HTTP endpoint (sees in-memory overrides + buildStats)
      // rather than the CMS directly.
      const relayUrl = registry.relayUrl;
      const statusUrl = `${relayUrl}/status/${item.id}?siteId=${encodeURIComponent(plan.siteId)}`;

      // Two-phase timeout:
      //   Phase 1 — pending: extension hasn't picked it up yet (30 s max)
      //   Phase 2 — building: extension is working; give it much more time (5 min)
      // This prevents false timeouts on complex sections while still catching
      // the case where the extension is not open at all.
      const POLL_INTERVAL_MS  = 2_000;
      const PICKUP_TIMEOUT_MS = 30_000;  // fail if never picked up within 30 s
      const BUILD_TIMEOUT_MS  = 300_000; // allow up to 5 min once building starts

      const pickupDeadline = Date.now() + PICKUP_TIMEOUT_MS;
      let buildDeadline = null; // set when status transitions to 'building'

      while (true) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        let built;
        try {
          const res = await fetch(statusUrl);
          if (!res.ok) continue;
          built = await res.json();
        } catch (_) {
          continue;
        }

        if (built.status === 'building' && buildDeadline === null) {
          // Extension picked it up — start the build-phase clock
          buildDeadline = Date.now() + BUILD_TIMEOUT_MS;
        }

        if (built.status === 'done' || built.status === 'error') {
          // Fetch build log before cleanup
          let buildLog = [];
          try {
            const logRes = await fetch(`${relayUrl}/log/${built.id}`);
            if (logRes.ok) buildLog = (await logRes.json()).messages ?? [];
          } catch (_) {}

          if (built.status === 'done') {
            // Auto-cleanup
            try { await client.deleteItem(built.id); } catch (_) {}
            try { await fetch(`${relayUrl}/log/${built.id}`, { method: 'DELETE' }); } catch (_) {}
            return ok({
              status: 'done',
              siteId: plan.siteId,
              sectionName: plan.sectionName,
              sectionClass: plan.tree?.className ?? null,
              order,
              ...(built.buildStats ? { buildStats: built.buildStats } : {}),
              log: buildLog,
              next: 'Call get_page_snapshot to verify the section is on canvas, then queue the next section.',
            });
          }

          // error — keep item in queue for inspection
          return fail(
            `Build failed for "${plan.sectionName}": ${built.errorMessage || 'unknown error'}\n\n` +
            `Build log:\n${buildLog.map(m => `  ${m}`).join('\n') || '  (no log entries)'}\n\n` +
            `Fix the plan and re-queue. The failed item (${built.id}) remains in the queue for inspection.`
          );
        }

        // Check timeouts
        const now = Date.now();
        if (buildDeadline !== null && now > buildDeadline) {
          return fail(
            `Build timed out after ${BUILD_TIMEOUT_MS / 60_000} minutes.\n` +
            `The Extension picked up the item but hasn't finished — it may have crashed.\n\n` +
            `DO NOT re-queue yet. First call get_queue_status to check the current state.\n` +
            `itemId: ${item.id}`
          );
        }
        if (buildDeadline === null && now > pickupDeadline) {
          return fail(
            `Build timed out — the Designer Extension did not pick up the item within ${PICKUP_TIMEOUT_MS / 1000}s.\n\n` +
            `The item is still in the queue (itemId: ${item.id}).\n` +
            `DO NOT re-queue. The Extension will pick it up as soon as it connects.\n` +
            `Make sure the Designer Extension panel is open and the relay URL is set to localhost:3847.`
          );
        }
      }
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

  // ── get_build_log ─────────────────────────────────────────────────
  server.tool(
    'get_build_log',
    'Retrieve the build log for a specific queue item. Returns all progress messages ' +
    'emitted by the Designer Extension during the build — element creation, style creation, ' +
    'warnings, and errors. Useful for diagnosing a failed build without waiting for wait=true.',
    {
      itemId: z.string().describe('The queue item ID (from get_queue_status)'),
    },
    async ({ itemId }) => {
      const relayUrl = registry.relayUrl;
      try {
        const res = await fetch(`${relayUrl}/log/${itemId}`);
        if (!res.ok) return fail(`Failed to fetch log: ${res.status}`);
        const { messages } = await res.json();
        if (!messages || messages.length === 0) {
          return ok('(no log entries — build may not have started yet)');
        }
        return ok(messages.join('\n'));
      } catch (e) {
        return fail(`Failed to fetch log: ${e.message}`);
      }
    }
  );

  // ── clear_queue ───────────────────────────────────────────────────
  server.tool(
    'clear_queue',
    'Remove items from the build queue. By default removes only completed (done) and failed (error) items. ' +
    'Set all=true to remove every item including pending ones.',
    {
      siteId: z.string().describe('The Webflow site ID'),
      all: z.boolean().optional().describe('If true, remove all items including pending. Default: false.'),
    },
    async ({ siteId, all = false }) => {
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

      const clearable = all
        ? items
        : items.filter((i) => i.status === 'done' || i.status === 'error');

      if (clearable.length === 0) {
        return ok(all ? 'Queue is already empty.' : 'Nothing to clear — no completed or failed items.');
      }

      const results = await Promise.allSettled(clearable.map((i) => client.deleteItem(i.id)));
      const cleared = results.filter((r) => r.status === 'fulfilled').length;
      const failed  = results.length - cleared;

      return ok(
        failed > 0
          ? `Cleared ${cleared} item(s). ${failed} failed to delete.`
          : `Cleared ${cleared} item(s).`
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

  // ── create_page ──────────────────────────────────────────────────
  server.tool(
    'create_page',
    'Create a new static page via the Designer bridge (UI simulation). ' +
    'Returns the new page ID. Optionally sets SEO/OG metadata via save_page after creation. ' +
    'Requires the Designer to be open with the bridge extension connected.',
    {
      siteId: z.string().describe('The Webflow site ID'),
      name: z.string().describe('Page name (e.g. "About Us")'),
      slug: z.string().optional().describe('URL slug — set after creation via save_page'),
      seoTitle: z.string().optional().describe('SEO meta title'),
      seoDescription: z.string().optional().describe('SEO meta description'),
      ogTitle: z.string().optional().describe('Open Graph title'),
      ogDescription: z.string().optional().describe('Open Graph description'),
    },
    async ({ siteId, name, slug, seoTitle, seoDescription, ogTitle, ogDescription }) => {
      try {
        // Step 1: Create the page via UI simulation
        const createResult = await requestBridge(siteId, 'create_page', { name });
        if (!createResult.created) {
          return fail(`Page creation failed: ${createResult.error || 'unknown error'}`);
        }

        const pageId = createResult.pageId;
        const result = { created: true, name, pageId };

        // Step 2: If any metadata was provided, save it via save_page
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
    'Update a page\'s settings (name, slug, SEO, Open Graph, custom code) via the Designer bridge. ' +
    'Uses savePage with the Immutable page record from the store.',
    {
      siteId: z.string().describe('The Webflow site ID'),
      pageId: z.string().describe('The page ID to update'),
      name: z.string().optional().describe('New page name'),
      slug: z.string().optional().describe('New URL slug'),
      seoTitle: z.string().optional().describe('SEO meta title'),
      seoDescription: z.string().optional().describe('SEO meta description'),
      ogTitle: z.string().optional().describe('Open Graph title'),
      ogDescription: z.string().optional().describe('Open Graph description'),
      head: z.string().optional().describe('Custom code in <head> tag (HTML/CSS/JS)'),
      postBody: z.string().optional().describe('Custom code before </body> tag (HTML/JS)'),
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
    'Get the content and class names on a Webflow page via the Data API. Returns all text ' +
    'nodes with their CSS class names and text content — use this before queuing a BuildPlan ' +
    'to see what sections already exist (by h2 text) and what class names are in use.',
    {
      siteId: z.string().describe('The Webflow site ID'),
      pageId: z.string().describe('The page ID (from list_pages)'),
    },
    async ({ siteId, pageId }) => {
      let client;
      try { client = registry.getClient(siteId); } catch (e) { return fail(e.message); }

      // Fetch all pages (paginated) to build a complete picture
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

      // Extract class names from HTML and build a readable summary
      const classPattern = /class="([^"]+)"/g;
      const allClasses = new Set();
      const lines = [];

      for (const node of allNodes) {
        const html = node.text?.html || '';
        const text = node.text?.text?.trim().replace(/\s+/g, ' ') || '';
        if (!text) continue;

        // Extract classes from this node's HTML
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
    'List all CSS class names used on a Webflow page. Use this before generating a BuildPlan ' +
    'to see what styles already exist — reference them rather than recreating, and avoid name collisions.',
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

  // ── get_page_snapshot ─────────────────────────────────────────────
  server.tool(
    'get_page_snapshot',
    'Get the full structural DOM of the current page via the Designer Extension — sections, ' +
    'containers, divs, headings, all element types with their class names and text. More complete ' +
    'than get_page_dom (which only returns content/text nodes). Requires the Designer Extension ' +
    'to be open and connected to the relay. Use this to see exactly what sections exist before ' +
    'queuing a BuildPlan.',
    {
      siteId: z.string().describe('The Webflow site ID'),
    },
    async ({ siteId }) => {
      const { snapshot, error } = await requestSnapshot(siteId);
      if (error) return fail(error);
      const pageLabel = snapshot.pageInfo?.name ? `Page: ${snapshot.pageInfo.name}\n\n` : '';
      return ok(`${pageLabel}${snapshot.summary}`);
    }
  );

  // ── Delete helper ─────────────────────────────────────────────────
  async function requestDelete(siteId, body) {
    const relayUrl = registry.relayUrl;

    let reqRes;
    try {
      reqRes = await fetch(
        `${relayUrl}/delete/request?siteId=${encodeURIComponent(siteId)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      );
    } catch (e) {
      return { error: `Cannot reach relay at ${relayUrl}. Run 'plinth dev' first.` };
    }
    if (!reqRes.ok) return { error: `Relay returned ${reqRes.status} for delete request.` };

    // Poll up to 30 s for completion
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const doneRes = await fetch(
          `${relayUrl}/delete/done?siteId=${encodeURIComponent(siteId)}`
        );
        if (doneRes.ok) return { result: await doneRes.json() };
      } catch { /* keep polling */ }
    }

    return { error: 'Delete timed out after 30 s. Make sure the Designer Extension is open.' };
  }

  // ── delete_elements ───────────────────────────────────────────────
  server.tool(
    'delete_elements',
    'Delete specific elements from the Webflow canvas by their IDs. ' +
    'Get element IDs from get_page_snapshot — they appear as Type#id .class in the output. ' +
    'Requires the Designer Extension to be open.',
    {
      siteId:     z.string().describe('The Webflow site ID'),
      elementIds: z.array(z.string()).describe('Element IDs to delete (from get_page_snapshot)'),
    },
    async ({ siteId, elementIds }) => {
      const { result, error } = await requestDelete(siteId, { elementIds });
      if (error) return fail(error);
      return ok(
        result.errors.length
          ? `Deleted ${result.deleted} element(s). Errors: ${result.errors.join('; ')}`
          : `Deleted ${result.deleted} element(s).`
      );
    }
  );

  // ── delete_section ────────────────────────────────────────────────
  server.tool(
    'delete_section',
    'Delete all Section elements on the canvas that have a given CSS class name. ' +
    'Use this to remove a previously built section before rebuilding it. ' +
    'The class name should match what appears in get_page_snapshot output (e.g. "hero-section"). ' +
    'Requires the Designer Extension to be open.',
    {
      siteId:       z.string().describe('The Webflow site ID'),
      sectionClass: z.string().describe('CSS class name of the section(s) to delete'),
    },
    async ({ siteId, sectionClass }) => {
      const { result, error } = await requestDelete(siteId, { sectionClass });
      if (error) return fail(error);
      return ok(
        result.errors.length
          ? `Deleted ${result.deleted} section(s). Errors: ${result.errors.join('; ')}`
          : `Deleted ${result.deleted} section(s) with class "${sectionClass}".`
      );
    }
  );

  // ── Updates helper ────────────────────────────────────────────────
  // Sends an update request to the relay and polls for the result.
  async function requestUpdate(siteId, body) {
    const relayUrl = registry.relayUrl;

    let reqRes;
    try {
      reqRes = await fetch(
        `${relayUrl}/updates/request?siteId=${encodeURIComponent(siteId)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      );
    } catch (e) {
      return { error: `Cannot reach relay at ${relayUrl}. Run 'plinth dev' first.` };
    }
    if (!reqRes.ok) return { error: `Relay returned ${reqRes.status} for update request.` };

    // Poll up to 30 s for the extension to respond
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const resultRes = await fetch(
          `${relayUrl}/updates/result?siteId=${encodeURIComponent(siteId)}`
        );
        if (resultRes.ok) {
          const data = await resultRes.json();
          if (data.ready) return { result: data };
        }
      } catch { /* keep polling */ }
    }

    return { error: 'Update timed out after 30 s. Make sure the Designer Extension is open and connected.' };
  }

  // ── update_styles ─────────────────────────────────────────────────
  server.tool(
    'update_styles',
    'Update CSS properties on existing named Webflow styles. Use this for visual tweaks — ' +
    'color, spacing, typography — without rebuilding the whole section. ' +
    'Each entry needs a style "name" (must already exist) and "properties" (longhand CSS only). ' +
    'Optional "breakpoints" and "pseudo" are supported. ' +
    'Requires the Designer Extension to be open.',
    {
      siteId: z.string().describe('The Webflow site ID'),
      styles: z.array(z.object({
        name:        z.string().describe('Style name (must already exist in Webflow)'),
        properties:  z.record(z.string()).optional().describe('CSS properties to set (longhand only)'),
        breakpoints: z.record(z.record(z.string())).optional().describe('Breakpoint overrides'),
        pseudo:      z.record(z.record(z.string())).optional().describe('Pseudo-state overrides'),
      })).describe('Styles to update'),
    },
    async ({ siteId, styles }) => {
      const { result, error } = await requestUpdate(siteId, { type: 'styles', styles });
      if (error) return fail(error);
      return ok(
        result.errors?.length
          ? `Updated ${result.updated} style(s). Errors: ${result.errors.join('; ')}`
          : `Updated ${result.updated} style(s).`
      );
    }
  );

  // ── update_content ────────────────────────────────────────────────
  server.tool(
    'update_content',
    'Patch text, href, src, or alt on existing elements by their CSS class name. ' +
    'Use this for copy changes, link updates, or image swaps without rebuilding the section. ' +
    'Each entry targets all elements that have the given class. ' +
    'Requires the Designer Extension to be open.',
    {
      siteId: z.string().describe('The Webflow site ID'),
      updates: z.array(z.object({
        className:  z.string().describe('CSS class of the element(s) to update'),
        text:       z.string().optional().describe('New text content'),
        href:       z.string().optional().describe('New href attribute'),
        src:        z.string().optional().describe('New src attribute (images)'),
        alt:        z.string().optional().describe('New alt text (images)'),
        attributes: z.array(z.object({
          name:  z.string(),
          value: z.string(),
        })).optional().describe('Arbitrary HTML attributes to set'),
      })).describe('Content updates to apply'),
    },
    async ({ siteId, updates }) => {
      const { result, error } = await requestUpdate(siteId, { type: 'content', updates });
      if (error) return fail(error);
      return ok(
        result.errors?.length
          ? `Updated ${result.updated} element(s). Errors: ${result.errors.join('; ')}`
          : `Updated ${result.updated} element(s).`
      );
    }
  );

  // ── Insert helper ─────────────────────────────────────────────────
  async function requestInsert(siteId, body) {
    const relayUrl = registry.relayUrl;

    let reqRes;
    try {
      reqRes = await fetch(
        `${relayUrl}/insert/request?siteId=${encodeURIComponent(siteId)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      );
    } catch (e) {
      return { error: `Cannot reach relay at ${relayUrl}. Run 'plinth dev' first.` };
    }
    if (!reqRes.ok) return { error: `Relay returned ${reqRes.status} for insert request.` };

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const resultRes = await fetch(
          `${relayUrl}/insert/result?siteId=${encodeURIComponent(siteId)}`
        );
        if (resultRes.ok) {
          const data = await resultRes.json();
          if (data.ready) return { result: data };
        }
      } catch { /* keep polling */ }
    }

    return { error: 'Insert timed out after 30 s. Make sure the Designer Extension is open.' };
  }

  // ── insert_elements ───────────────────────────────────────────────
  server.tool(
    'insert_elements',
    'Add new elements inside or after an existing element — without rebuilding the whole section. ' +
    'Use parentClass to append nodes as children inside a named element (e.g. add a card to a grid). ' +
    'Use afterClass to insert nodes as siblings after a named element (e.g. add a button after a heading). ' +
    'Exactly one of parentClass or afterClass must be provided. ' +
    'Nodes use the same ElementNode format as BuildPlan (type, className, text, href, children, etc). ' +
    'Requires the Designer Extension to be open.',
    {
      siteId: z.string().describe('The Webflow site ID'),
      nodes: z.array(z.record(z.any())).describe(
        'Element nodes to insert (same format as BuildPlan tree nodes — type, className, text, href, children, etc)'
      ),
      parentClass: z.string().optional().describe(
        'CSS class of the parent element to append nodes inside (e.g. "card-grid")'
      ),
      afterClass: z.string().optional().describe(
        'CSS class of the sibling element to insert nodes after (e.g. "hero-badge")'
      ),
      styles: z.array(z.record(z.any())).optional().describe(
        'StyleDef objects to create before inserting (same format as BuildPlan styles)'
      ),
    },
    async ({ siteId, nodes, parentClass, afterClass, styles }) => {
      if (!parentClass && !afterClass) {
        return fail('Provide parentClass (append inside) or afterClass (insert after sibling).');
      }
      if (parentClass && afterClass) {
        return fail('Provide parentClass or afterClass, not both.');
      }

      const { result, error } = await requestInsert(siteId, {
        parentClass, afterClass, nodes, styles,
      });
      if (error) return fail(error);

      const summary = [
        `Inserted ${result.inserted} element(s).`,
        result.stylesCreated > 0 ? `Created ${result.stylesCreated} style(s).` : '',
        result.errors?.length   ? `Errors: ${result.errors.join('; ')}` : '',
      ].filter(Boolean).join(' ');

      return ok(summary);
    }
  );

  // ── Move helper ───────────────────────────────────────────────────
  async function requestMove(siteId, body) {
    const relayUrl = registry.relayUrl;

    let reqRes;
    try {
      reqRes = await fetch(
        `${relayUrl}/move/request?siteId=${encodeURIComponent(siteId)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      );
    } catch (e) {
      return { error: `Cannot reach relay at ${relayUrl}. Run 'plinth dev' first.` };
    }
    if (!reqRes.ok) return { error: `Relay returned ${reqRes.status} for move request.` };

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const doneRes = await fetch(`${relayUrl}/move/done?siteId=${encodeURIComponent(siteId)}`);
        if (doneRes.ok) return { result: await doneRes.json() };
      } catch { /* keep polling */ }
    }

    return { error: 'Move timed out after 30 s. Make sure the Designer Extension is open.' };
  }

  // ── move_element ──────────────────────────────────────────────────
  server.tool(
    'move_element',
    'Move an existing element to a new position on the canvas by CSS class name. ' +
    'Provide either beforeClass (insert before that element) or afterClass (insert after it). ' +
    'Works on any element type. Requires the Designer Extension to be open.',
    {
      siteId:      z.string().describe('The Webflow site ID'),
      className:   z.string().describe('CSS class of the element to move'),
      beforeClass: z.string().optional().describe('Move it immediately before the element with this class'),
      afterClass:  z.string().optional().describe('Move it immediately after the element with this class'),
    },
    async ({ siteId, className, beforeClass, afterClass }) => {
      if (!beforeClass && !afterClass) {
        return fail('Provide beforeClass or afterClass to specify the target position.');
      }
      if (beforeClass && afterClass) {
        return fail('Provide beforeClass or afterClass, not both.');
      }
      const { result, error } = await requestMove(siteId, { className, beforeClass, afterClass });
      if (error) return fail(error);
      return ok(
        result.errors?.length
          ? `Moved ${result.moved} element(s). Errors: ${result.errors.join('; ')}`
          : `Moved "${className}" ${beforeClass ? `before "${beforeClass}"` : `after "${afterClass}"`}.`
      );
    }
  );

  // ── reorder_sections ──────────────────────────────────────────────
  server.tool(
    'reorder_sections',
    'Reorder page sections by providing their CSS class names in the desired top-to-bottom order. ' +
    'Only the listed sections are reordered — unlisted sections stay in place. ' +
    'Use get_page_snapshot first to confirm current section order and class names. ' +
    'Requires the Designer Extension to be open.',
    {
      siteId:         z.string().describe('The Webflow site ID'),
      sectionClasses: z.array(z.string()).min(2).describe(
        'CSS class names of the sections in the desired order (top to bottom), e.g. ["hero-section", "stats-section", "cta-section"]'
      ),
    },
    async ({ siteId, sectionClasses }) => {
      const { result, error } = await requestMove(siteId, { sectionClasses });
      if (error) return fail(error);
      return ok(
        result.errors?.length
          ? `Reordered ${result.moved} section(s). Errors: ${result.errors.join('; ')}`
          : `Reordered ${result.moved} section(s): ${sectionClasses.join(' → ')}`
      );
    }
  );

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

  // ── bridge_snapshot ─────────────────────────────────────────────────
  server.tool(
    'bridge_snapshot',
    'Get a structural snapshot of the current Webflow page via the content script bridge. ' +
    'Returns an indented tree of all elements with their types, IDs, class names, and text content, ' +
    'plus a list of all styles. No Designer Extension panel needed — only the Inspector Chrome extension. ' +
    'Use this to verify builds, check page structure, and confirm element/style presence.',
    {
      siteId: z.string().describe('The Webflow site ID'),
    },
    async ({ siteId }) => {
      const { result, error } = await requestBridge(siteId, 'snapshot');
      if (error) return fail(error);
      if (!result.ok) return fail(`Bridge snapshot failed: ${result.error}`);
      const d = result.data;
      const pageLabel = d.pageInfo?.name ? `Page: ${d.pageInfo.name}\n\n` : '';
      return ok(`${pageLabel}${d.summary}`);
    }
  );

  // ── bridge_ping ─────────────────────────────────────────────────────
  server.tool(
    'bridge_ping',
    'Check if the content script bridge is connected and can reach _webflow.creators. ' +
    'Returns { ready, creatorsAvailable, creatorsCount }. ' +
    'Requires the Plinth Inspector Chrome extension to be installed and the Designer open.',
    {
      siteId: z.string().describe('The Webflow site ID'),
    },
    async ({ siteId }) => {
      const { result, error } = await requestBridge(siteId, 'ping');
      if (error) return fail(error);
      if (!result.ok) return fail(`Bridge ping failed: ${result.error}`);
      return ok(result.data);
    }
  );

  // ── bridge_execute ──────────────────────────────────────────────────
  server.tool(
    'bridge_execute',
    'Execute a _webflow.creators action via the content script bridge. ' +
    'Calls _webflow.creators[namespace][method](...args) in the Designer page context. ' +
    'Use bridge_ping first to verify connectivity. ' +
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
      if (!result.ok) return fail(`Bridge execute failed: ${result.error}`);
      return ok(result.data);
    }
  );

  // ── bridge_probe ─────────────────────────────────────────────────────
  server.tool(
    'bridge_probe',
    'Evaluate a JavaScript expression in the Designer page context with access to _webflow. ' +
    'Use for debugging and inspecting internal state (e.g. _webflow.state.CssVariablesStore, ' +
    '_webflow.state.DesignerStore, element data). The expression receives _webflow as a variable. ' +
    'Return values are serialized (Immutable objects are converted via .toJS()).',
    {
      siteId: z.string().describe('The Webflow site ID'),
      expr: z.string().describe(
        'JavaScript expression to evaluate. Has access to _webflow. ' +
        'Example: "_webflow.state.PageStore.currentPage" or ' +
        '"Object.keys(_webflow.state).filter(k => k.indexOf(\"Variable\") >= 0)"'
      ),
    },
    async ({ siteId, expr }) => {
      const { result, error } = await requestBridge(siteId, 'probe', { expr });
      if (error) return fail(error);
      if (!result.ok) return fail(`Bridge probe failed: ${result.error}`);
      return ok(result.data);
    }
  );

  // ── bridge_build ────────────────────────────────────────────────────
  server.tool(
    'bridge_build',
    'Build a section on the Webflow canvas via the content script bridge — no Designer Extension needed. ' +
    'Takes a BuildPlan-like tree and creates elements via ELEMENT_ADDED dispatch + styles via importSiteData. ' +
    'Requires the Plinth Inspector Chrome extension and the Designer page open. ' +
    'Use bridge_ping first to verify connectivity and webpack capture.',
    {
      siteId: z.string().describe('The Webflow site ID'),
      tree: z.record(z.any()).describe('Root element node (same format as BuildPlan tree)'),
      styles: z.array(z.record(z.any())).optional().describe(
        'Style definitions: [{ name, properties: { camelCase: value } }] or [{ name, styleLess: "..." }]'
      ),
      insertAfterSectionClass: z.string().optional().describe(
        'CSS class of the section to insert after'
      ),
      insertAfterElementId: z.string().optional().describe(
        'Element ID to insert after (from get_page_snapshot)'
      ),
      parentElementId: z.string().optional().describe(
        'Element ID to insert inside as a child (append). Use for adding elements inside a CollectionItem or other container.'
      ),
    },
    async ({ siteId, tree, styles, insertAfterSectionClass, insertAfterElementId, parentElementId }) => {
      const payload = { tree };
      if (styles) payload.styles = styles;
      if (insertAfterSectionClass) payload.insertAfterSectionClass = insertAfterSectionClass;
      if (insertAfterElementId) payload.insertAfterElementId = insertAfterElementId;
      if (parentElementId) payload.parentElementId = parentElementId;

      const { result, error } = await requestBridge(siteId, 'build', payload, 120_000);
      if (error) return fail(error);
      if (!result.ok) return fail(`Bridge build failed: ${result.error}`);

      const d = result.data;
      const parts = [`Created ${d.elementsCreated} element(s).`];
      if (d.stylesApplied > 0) parts.push(`Styled ${d.stylesApplied} element(s).`);
      if (d.errors && d.errors.length > 0) parts.push(`Errors: ${d.errors.join('; ')}`);

      return ok(parts.join(' '));
    }
  );

  // ── bridge_delete ───────────────────────────────────────────────────
  server.tool(
    'bridge_delete',
    'Delete elements from the Webflow canvas via the content script bridge. ' +
    'Takes an array of element IDs (from get_page_snapshot or bridge_build). ' +
    'Elements are deleted one at a time via NODE_CLICKED + DELETE_KEY_PRESSED dispatch.',
    {
      siteId: z.string().describe('The Webflow site ID'),
      elementIds: z.array(z.string()).describe('Array of element IDs to delete'),
    },
    async ({ siteId, elementIds }) => {
      const { result, error } = await requestBridge(siteId, 'delete', { elementIds }, 120_000);
      if (error) return fail(error);
      if (!result.ok) return fail(`Bridge delete failed: ${result.error}`);

      const d = result.data;
      const parts = [`Deleted ${d.deleted} element(s).`];
      if (d.errors && d.errors.length > 0) parts.push(`Errors: ${d.errors.join('; ')}`);
      return ok(parts.join(' '));
    }
  );

  // ── bridge_connect_collection ──────────────────────────────────────
  server.tool(
    'bridge_connect_collection',
    'Connect a Collection List (DynamoWrapper) to a CMS collection. ' +
    'Must be called BEFORE bridge_bind — field bindings require an active collection connection. ' +
    'elementId is the DynamoWrapper UUID (from bridge_build or get_page_snapshot).',
    {
      siteId: z.string().describe('The Webflow site ID'),
      elementId: z.string().describe('UUID of the DynamoWrapper element'),
      collectionId: z.string().describe('CMS collection ID to connect'),
    },
    async ({ siteId, elementId, collectionId }) => {
      const { result, error } = await requestBridge(siteId, 'connect_collection', { elementId, collectionId });
      if (error) return fail(error);
      if (!result.ok) return fail(`Bridge connect_collection failed: ${result.error}`);

      const d = result.data;
      return ok(`Connected DynamoWrapper ${d.elementId.substring(0, 8)} to collection ${d.collectionId}`);
    }
  );

  // ── bridge_bind ────────────────────────────────────────────────────
  server.tool(
    'bridge_bind',
    'Bind a CMS collection field to an element inside a Collection List (DynamoItem). ' +
    'The Collection List must already be connected to a collection (use bridge_connect_collection first). ' +
    'fieldSlug is the CMS field slug (e.g. "name", "quote", "slug"). ' +
    'gateway defaults to "dynamoPlainTextToListOfElements" for plain text fields. ' +
    'Use "dynamoImageToAttributes" for image fields, "dynamoLinkToAttributes" for link fields.',
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
      if (!result.ok) return fail(`Bridge bind failed: ${result.error}`);
      const d = result.data;
      if (!d.bound) return fail(d.error || 'Bind returned false');
      return ok(`Bound field "${d.fieldSlug}" to element ${d.elementId.substring(0, 8)} via ${d.gateway}`);
    }
  );

  // ── bridge_paste ──────────────────────────────────────────────────
  server.tool(
    'bridge_paste',
    'Paste a @webflow/XscpData payload into the Webflow Designer via synthetic paste event. ' +
    'Fully automated — no manual Ctrl+V needed. Works for all element types including ' +
    'complex/factory elements (Navbar, Slider, Tabs, etc.) that crash with ELEMENT_ADDED. ' +
    'The xscpData must have type "@webflow/XscpData" with payload.nodes and payload.styles arrays.',
    {
      siteId: z.string().describe('The Webflow site ID'),
      xscpData: z.record(z.any()).describe(
        'Complete @webflow/XscpData object: { type: "@webflow/XscpData", payload: { nodes: [...], styles: [...], assets: [], ix1: [], ix2: {...} }, meta: {...} }'
      ),
      targetElementId: z.string().describe(
        'Element ID to select before pasting — paste inserts as child of this element. Use body ID to paste at page level.'
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
      if (!result.ok) return fail(`Bridge paste failed: ${result.error}`);
      const d = result.data;
      if (!d.pasted) return fail(d.error || 'Paste returned false');
      return ok(`Pasted ${d.nodeCount} nodes (target: ${d.targetElementId.substring(0, 8)}…)`);
    }
  );

  // ── bridge_build_v2 ──────────────────────────────────────────────
  server.tool(
    'bridge_build_v2',
    'Build a section on the Webflow canvas via XscpData paste — the fast v2 pipeline. ' +
    'Takes a SectionSpec tree where each node has inline CSS in a `styles` string. ' +
    'Variable references ($var-name) are resolved to Webflow variable UUIDs automatically. ' +
    'Existing styles are reused by name (no duplicates). Shorthand CSS is allowed. ' +
    'Returns node/style counts. Use bridge_snapshot + take_screenshot to verify.',
    {
      siteId: z.string().describe('The Webflow site ID'),
      tree: z.record(z.any()).describe(
        'Root element: { type, className, styles: "CSS string", text?, headingLevel?, href?, src?, alt?, children?: [...] }'
      ),
      sharedStyles: z.array(z.record(z.any())).optional().describe(
        'Styles not attached to elements in this section: [{ name, styles: "CSS string" }]'
      ),
      insertAfterSectionClass: z.string().optional().describe(
        'CSS class of the section to insert after (section is reordered post-paste)'
      ),
      insertAfterElementId: z.string().optional().describe(
        'Element ID to insert after (from get_page_snapshot)'
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
      if (!result.ok) return fail(`Bridge build_v2 failed: ${result.error}`);

      const d = result.data;
      const parts = [`Pasted ${d.nodeCount} nodes, ${d.styleCount} styles.`];
      if (d.reordered) parts.push('Reordered to requested position.');
      if (d.rootId) parts.push(`Root: ${d.rootId.substring(0, 8)}…`);

      return ok(parts.join(' '));
    }
  );

  // ── bridge_list_variables ──────────────────────────────────────────
  server.tool(
    'bridge_list_variables',
    'List all style variables defined in the Webflow site. ' +
    'Returns variable names, IDs, values, and types. ' +
    'Use variable names with $name syntax in bridge_build_v2 styles for automatic resolution.',
    {
      siteId: z.string().describe('The Webflow site ID'),
    },
    async ({ siteId }) => {
      const { result, error } = await requestBridge(siteId, 'list_variables', {});
      if (error) return fail(error);
      if (!result.ok) return fail(`Bridge list_variables failed: ${result.error}`);

      const d = result.data;
      if (d.error) {
        return ok(`Found ${d.count || 0} variables (with warning: ${d.error}):\n${JSON.stringify(d.variables, null, 2)}`);
      }
      return ok(`Found ${d.count} variables:\n${JSON.stringify(d.variables, null, 2)}`);
    }
  );

  // ── bridge_create_variables ──────────────────────────────────────────
  server.tool(
    'bridge_create_variables',
    'Create style variables in the Webflow Designer. ' +
    'Variables are persisted to the server and immediately available for use ' +
    'with $name syntax in bridge_build_v2 styles. ' +
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
      if (!result.ok) return fail(`Bridge create_variables failed: ${result.error}`);

      const d = result.data;
      if (d.error) return fail(d.error);

      let msg = `Created ${d.count} variable(s) in collection ${d.collectionId}:\n`;
      msg += JSON.stringify(d.created, null, 2);
      if (d.errors) msg += `\nErrors:\n${JSON.stringify(d.errors, null, 2)}`;
      return ok(msg);
    }
  );

  // ── bridge_capture_xscp ────────────────────────────────────────────
  server.tool(
    'bridge_capture_xscp',
    'Capture the XscpData (copy payload) for an element on the Webflow canvas. ' +
    'Selects the element, triggers copy, and returns the complete XscpData JSON ' +
    'including nodes, styles, and ix2 interactions. ' +
    'Use this to capture templates for replay with bridge_build_v2 or bridge_paste.',
    {
      siteId: z.string().describe('The Webflow site ID'),
      elementId: z.string().describe('UUID of the element to capture'),
    },
    async ({ siteId, elementId }) => {
      const { result, error } = await requestBridge(siteId, 'capture_xscp', { elementId }, 15_000);
      if (error) return fail(error);
      if (!result.ok) return fail(`Bridge capture_xscp failed: ${result.error}`);

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

  // ── bridge_update_styles ──────────────────────────────────────────
  server.tool(
    'bridge_update_styles',
    'Update CSS properties on existing Webflow styles via the content script bridge. ' +
    'Uses the v1 setStyle pipeline (NODE_CLICKED → startSetStyle → setStyle → endSetStyle). ' +
    'Does NOT require the Designer Extension panel — only the Inspector Chrome extension. ' +
    'Each entry needs a style "name" (must already exist) and "properties" (longhand CSS key-value pairs). ' +
    'Example properties: { "background-color": "transparent", "font-size": "60px", "color": "#2C2C2C" }',
    {
      siteId: z.string().describe('The Webflow site ID'),
      styles: z.array(z.object({
        name: z.string().describe('Style/class name (must already exist in Webflow)'),
        properties: z.record(z.string()).describe('CSS properties to set (longhand only, e.g. "background-color": "transparent")'),
      })).describe('Array of styles to update'),
    },
    async ({ siteId, styles }) => {
      const timeout = 10_000 + styles.length * 2_000; // ~2s per style entry
      const { result, error } = await requestBridge(siteId, 'update_styles', { styles }, timeout);
      if (error) return fail(error);
      if (!result.ok) return fail(`Bridge update_styles failed: ${result.error}`);

      const d = result.data;
      return ok({
        updated: d.updated,
        failed: d.failed,
        results: d.results
      });
    }
  );

  // ── copy_to_webflow ───────────────────────────────────────────────
  server.tool(
    'copy_to_webflow',
    'Copy a @webflow/XscpData payload to the system clipboard so it can be pasted ' +
    'directly into the Webflow Designer with Ctrl+V / Cmd+V. ' +
    'Generate the payload using the @webflow/XscpData format: ' +
    '{ type: "@webflow/XscpData", payload: { nodes: [...], styles: [...], assets: [], ix1: [], ix2: {...} }, meta: {...} }. ' +
    'Node types: Section, Block (div), Heading, Paragraph, Link. ' +
    'Styles use a "styleLess" CSS string (shorthand is fine here). ' +
    'Returns a prompt to paste in the Designer.',
    {
      payload: z
        .record(z.any())
        .describe('The complete @webflow/XscpData object to copy to clipboard'),
    },
    async ({ payload }) => {
      // Basic validation
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
    'and return it as an image. Use sectionClass to screenshot just the built section. ' +
    'Requires puppeteer-core and Chrome/Chromium — run: cd plinth/mcp-server && npm install puppeteer-core',
    {
      siteId: z.string().describe('The Webflow site ID'),
      sectionClass: z.string().optional().describe(
        'CSS class of the section to screenshot (e.g. "hero-section"). ' +
        'If omitted, screenshots the full page.'
      ),
      pageSlug: z.string().optional().describe(
        'Page slug to navigate to (e.g. "about"). Omit for the home page.'
      ),
      skipPublish: z.boolean().optional().describe(
        'Skip the publish step and screenshot the current live staging URL. Default: false.'
      ),
    },
    async ({ siteId, sectionClass, pageSlug, skipPublish = false }) => {
      // Check availability upfront
      const availability = checkAvailability();
      if (!availability.available) {
        return fail(
          `Screenshot unavailable: ${availability.reason}.\n` +
          `Fix: ${availability.install}`
        );
      }

      let client;
      try { client = registry.getClient(siteId); } catch (e) { return fail(e.message); }

      // Get site info (shortName → staging URL)
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

      // Publish to staging (unless skipped)
      if (!skipPublish) {
        try {
          log(`Publishing ${siteId} to ${stageUrl}…`);
          await client.publishToStaging();
        } catch (e) {
          return fail(`Failed to publish to staging: ${e.message}`);
        }

        // Wait for Webflow's CDN to propagate the build (~20 s for most sites)
        log('Waiting 20 s for staging build to complete…');
        await new Promise((r) => setTimeout(r, 20_000));
      }

      // Take the screenshot
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
