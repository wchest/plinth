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

const { McpServer }            = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');

const SiteRegistry = require('./site-registry');

// --- Config resolution -----------------------------------------------

function resolveConfigPath() {
  if (process.env.PLINTH_CONFIG) return path.resolve(process.env.PLINTH_CONFIG);
  const cwdConfig = path.join(process.cwd(), '.plinth.json');
  if (fs.existsSync(cwdConfig)) return cwdConfig;
  return path.join(__dirname, '..', 'mcp-server', 'sites.json');
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
    description: 'Multi-platform page builder — build sections via content script bridge',
  });

  // -- Bridge helper -------------------------------------------------
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
             'is installed and the Designer/Editor is open.',
    };
  }

  const helpers = { ok, fail, requestBridge, log };

  // -- Load platform tools -------------------------------------------
  const platformNames = registry.getPlatformNames();
  for (const platformName of platformNames) {
    try {
      const platformTools = require(`../platforms/${platformName}/tools`);
      platformTools.registerTools(server, registry, helpers);
      log(`Loaded tools for platform: ${platformName}`);
    } catch (e) {
      err(`Failed to load tools for platform "${platformName}": ${e.message}`);
    }
  }

  // --- Connect stdio transport --------------------------------------

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('MCP server connected via stdio.');
}

main().catch((e) => {
  process.stderr.write(`[plinth] Fatal: ${e.message}\n`);
  process.exit(1);
});
