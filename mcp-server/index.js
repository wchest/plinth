'use strict';

require('dotenv').config();

const path = require('path');
const fs   = require('fs');
const express = require('express');
const cors = require('cors');

const { version } = require('../package.json');

const LOG_FILE  = path.join(require('os').tmpdir(), 'plinth-relay.log');
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

function writeLog(line) {
  const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  const stripped = line.replace(/\x1b\[[0-9;]*m/g, ''); // strip ANSI
  logStream.write(`[${ts}] ${stripped}\n`);
}

const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
};
const ok   = (s) => `  ${c.green}✓${c.reset}  ${s}`;
const fail = (s) => `  ${c.red}✗${c.reset}  ${s}`;

const SiteRegistry = require('./lib/site-registry');
const queueRouter    = require('./routes/queue');
const statusRouter   = require('./routes/status');
const healthRouter   = require('./routes/health');
const snapshotRouter = require('./routes/snapshot');
const deleteRouter   = require('./routes/delete');
const logRouter      = require('./routes/log');
const updatesRouter  = require('./routes/updates');
const insertRouter   = require('./routes/insert');
const moveRouter     = require('./routes/move');

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
  console.error(fail(err.message));
  process.exit(1);
}
app.locals.siteRegistry = registry;
app.locals.writeLog = writeLog;

// --- Request logging --------------------------------------------------

app.use((req, res, next) => {
  const start  = Date.now();
  const method = req.method;
  const path   = req.path; // capture before Express rewrites it for sub-routers
  res.on('finish', () => {
    // Skip noisy heartbeat polls
    if (res.statusCode === 200 && (
      path === '/snapshot/pending' ||
      path === '/delete/pending' ||
      path === '/updates/pending' ||
      path === '/insert/pending' ||
      path === '/move/pending'
    )) return;
    if (res.statusCode === 200 && method === 'POST' && path.startsWith('/log/')) return;
    const ms = Date.now() - start;
    const qs = req.query && Object.keys(req.query).length
      ? '?' + new URLSearchParams(req.query).toString() : '';
    const color = res.statusCode >= 400 ? c.red : c.dim;
    const line = `  ${method} ${path}${qs} → ${res.statusCode} ${ms}ms`;
    process.stdout.write(`${color}${line}${c.reset}\n`);
    writeLog(line);
  });
  next();
});

// --- Routes -----------------------------------------------------------

app.use('/queue',    queueRouter);
app.use('/status',   statusRouter);
app.use('/health',   healthRouter);
app.use('/snapshot', snapshotRouter);
app.use('/delete',   deleteRouter);
app.use('/log',      logRouter);
app.use('/updates',  updatesRouter);
app.use('/insert',   insertRouter);
app.use('/move',     moveRouter);

// --- 404 handler ------------------------------------------------------

app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// --- Error handler ----------------------------------------------------

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
});

// --- Startup ----------------------------------------------------------

async function start() {
  const sites = registry.summary();
  const siteLabel = sites.map((s) => s.name).join(', ');

  console.log('');
  console.log(`  ${c.bold}plinth${c.reset} v${version}  ${c.dim}${siteLabel}${c.reset}`);
  console.log('');

  await new Promise((resolve) => {
    app.listen(PORT, '127.0.0.1', () => {
      const msg = ok(`Relay listening on http://localhost:${PORT}`);
      console.log(msg);
      writeLog(`=== plinth relay started on :${PORT} === log: ${LOG_FILE}`);
      resolve();
    });
  });

  // Discover _Build Queue collections
  const results = await registry.discoverAll();
  for (const r of results) {
    if (r.ok) {
      console.log(ok(`${r.name} — queue ready`));
    } else {
      console.log(fail(`${r.name} — ${r.error}`));
    }
  }

  const allReady = results.every((r) => r.ok);
  console.log('');
  if (allReady) {
    console.log(`  Waiting for BuildPlans…  ${c.dim}Press Ctrl+C to quit${c.reset}`);
  } else {
    console.log(`  ${c.red}Some sites failed to connect. Check your .plinth.json.${c.reset}`);
  }
  console.log('');
}

start().catch((err) => {
  console.error('[plinth] Fatal startup error:', err);
  process.exit(1);
});

module.exports = app;
