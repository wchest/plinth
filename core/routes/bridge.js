'use strict';

/**
 * /bridge — relay endpoints for content script bridge.
 *
 * Flow:
 *   1. MCP tool  POST /bridge/request?siteId=  -> stores pending command
 *   2. Content script (ISOLATED) GET /bridge/pending?siteId= -> sees { pending: true, ... }
 *   3. Content script executes in MAIN world, POST /bridge/result?siteId= with result
 *   4. MCP tool  GET  /bridge/result?siteId=   -> gets result, consumes it
 *
 * Platform-agnostic — routes by siteId only.
 */

const crypto  = require('crypto');
const express = require('express');
const router  = express.Router();

const pendingCommands = new Map(); // siteId -> { id, type, payload, ts }
const results         = new Map(); // siteId -> { id, ok, data, error, ts }

const REQUEST_TTL_MS = 120_000;

// -- POST /bridge/request?siteId= -----------------------------------------
router.post('/request', (req, res) => {
  const { siteId } = req.query;
  if (!siteId) return res.status(400).json({ error: 'siteId required' });

  const { type, payload } = req.body;
  if (!type) return res.status(400).json({ error: 'type required' });

  const id = crypto.randomUUID();
  pendingCommands.set(String(siteId), { id, type, payload: payload || {}, ts: Date.now() });
  results.delete(String(siteId));
  res.json({ ok: true, id });
});

// -- GET /bridge/pending?siteId= ------------------------------------------
router.get('/pending', (req, res) => {
  const { siteId } = req.query;
  if (!siteId) return res.status(400).json({ error: 'siteId required' });

  const cmd = pendingCommands.get(String(siteId));
  if (!cmd || Date.now() - cmd.ts > REQUEST_TTL_MS) {
    pendingCommands.delete(String(siteId));
    return res.set('Cache-Control', 'no-store').json({ pending: false });
  }
  res.set('Cache-Control', 'no-store').json({ pending: true, ...cmd });
});

// -- POST /bridge/result?siteId= ------------------------------------------
router.post('/result', (req, res) => {
  const { siteId } = req.query;
  if (!siteId) return res.status(400).json({ error: 'siteId required' });

  pendingCommands.delete(String(siteId));
  results.set(String(siteId), { ...req.body, ts: Date.now() });
  res.json({ ok: true });
});

// -- GET /bridge/result?siteId= -------------------------------------------
router.get('/result', (req, res) => {
  const { siteId } = req.query;
  if (!siteId) return res.status(400).json({ error: 'siteId required' });

  const result = results.get(String(siteId));
  if (!result) return res.json({ ready: false });
  results.delete(String(siteId));
  res.json({ ready: true, ...result });
});

module.exports = router;
