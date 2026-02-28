'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');

const SiteRegistry = require('./lib/site-registry');
const queueRouter = require('./routes/queue');
const statusRouter = require('./routes/status');
const healthRouter = require('./routes/health');

// --- Config path resolution -------------------------------------------
//
// Priority:
//   1. PLINTH_CONFIG env var  → any JSON file you point to
//   2. .plinth.json in cwd   → per-repo config (single or multi site)
//   3. sites.json in mcp-server dir → central multi-site config
//
// This means:
//   cd ~/projects/my-site && PLINTH_CONFIG=.plinth.json npm --prefix ~/plinth/mcp-server start
//   — or just drop a .plinth.json in the project repo and point PLINTH_CONFIG at it.

const fs = require('fs');

function resolveConfigPath() {
  if (process.env.PLINTH_CONFIG) {
    return path.resolve(process.env.PLINTH_CONFIG);
  }
  const cwdConfig = path.join(process.cwd(), '.plinth.json');
  if (fs.existsSync(cwdConfig)) {
    return cwdConfig;
  }
  return path.join(__dirname, 'sites.json');
}

const PORT = parseInt(process.env.PORT || '3847', 10);
const configPath = resolveConfigPath();

// --- App --------------------------------------------------------------

const app = express();

app.use(cors());
app.use(express.json({ limit: '100kb' }));

// Load site registry — throws on bad/missing config
let registry;
try {
  registry = new SiteRegistry(configPath);
} catch (err) {
  console.error('[plinth] ERROR:', err.message);
  process.exit(1);
}
app.locals.siteRegistry = registry;

// --- Routes -----------------------------------------------------------

app.use('/queue', queueRouter);
app.use('/status', statusRouter);
app.use('/health', healthRouter);

// --- 404 handler ------------------------------------------------------

app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// --- Error handler ----------------------------------------------------

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  console.error('[plinth] Unhandled error:', err.message);
  res.status(status).json({ error: err.message || 'Internal server error' });
});

// --- Startup ----------------------------------------------------------

async function start() {
  await new Promise((resolve) => {
    app.listen(PORT, '127.0.0.1', () => {
      console.log(`[plinth] MCP relay server listening at http://127.0.0.1:${PORT}`);
      console.log(`[plinth] Config: ${configPath}`);
      resolve();
    });
  });

  // Discover _Build Queue collection for all configured sites
  await registry.discoverAll();
  console.log('[plinth] Ready.');
}

start().catch((err) => {
  console.error('[plinth] Fatal startup error:', err);
  process.exit(1);
});

module.exports = app;
