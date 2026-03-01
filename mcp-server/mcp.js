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

      const TIMEOUT_MS = 90_000;
      const POLL_INTERVAL_MS = 2_000;
      const deadline = Date.now() + TIMEOUT_MS;

      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        let built;
        try {
          const res = await fetch(statusUrl);
          if (!res.ok) continue;
          built = await res.json();
        } catch (_) {
          continue;
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
      }

      return fail(
        `Build timed out after ${TIMEOUT_MS / 1000}s — the Designer Extension may not be open or connected.\n` +
        `itemId: ${item.id} — check status with get_queue_status, then clear it and re-queue once the Extension is ready.`
      );
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
