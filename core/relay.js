'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');

const { version } = require('../package.json');
const log = require('./lib/logger')('relay');

const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
};

const bridgeRouter = require('./routes/bridge');

const PORT = parseInt(process.env.PORT || '3847', 10);

// --- App --------------------------------------------------------------

const app = express();

app.use(cors());
app.use(express.json({ limit: '100kb' }));

// --- Request logging --------------------------------------------------

app.use((req, res, next) => {
  const start  = Date.now();
  const method = req.method;
  const reqPath = req.path;
  res.on('finish', () => {
    // Skip noisy heartbeat polls
    if (res.statusCode === 200 && reqPath === '/bridge/pending') return;
    const ms = Date.now() - start;
    const site = req.query.siteId ? ` [${req.query.siteId.substring(0, 8)}…]` : '';
    const line = `${method} ${reqPath}${site} → ${res.statusCode} ${ms}ms`;
    log.debug(line);  // file only
    const color = res.statusCode >= 400 ? c.red : c.dim;
    process.stdout.write(`  ${color}${line}${c.reset}\n`);
  });
  next();
});

// --- Routes -----------------------------------------------------------

app.use('/bridge', bridgeRouter);

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
  console.log('');
  console.log(`  ${c.bold}plinth${c.reset} v${version}  ${c.dim}relay${c.reset}`);
  console.log('');

  await new Promise((resolve) => {
    app.listen(PORT, '127.0.0.1', () => {
      log.debug(`Relay listening on http://localhost:${PORT}`);
      console.log(`  ${c.green}✓${c.reset}  Relay listening on http://localhost:${PORT}`);
      resolve();
    });
  });

  console.log('');
  console.log(`  ${c.dim}Log: ${log.file}${c.reset}`);
  console.log(`  Waiting for bridge connections…  ${c.dim}Press Ctrl+C to quit${c.reset}`);
  console.log('');
}

start().catch((err) => {
  log.error('Fatal startup error:', err.message);
  process.exit(1);
});

module.exports = app;
