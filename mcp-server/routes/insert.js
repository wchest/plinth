'use strict';

/**
 * /insert — relay endpoints for surgical element insertion.
 *
 * Flow (same pattern as /delete and /updates):
 *   1. MCP tool  POST /insert/request?siteId=  → stores pending request
 *   2. Extension GET  /insert/pending?siteId=  → sees { pending: true, ... }
 *   3. Extension executes insertion, POST /insert/done?siteId= with result
 *   4. MCP tool  GET  /insert/result?siteId=   → gets result
 *
 * Exactly one of parentClass or afterClass must be set:
 *   parentClass → append nodes as children inside that element
 *   afterClass  → insert nodes as siblings after that element
 */

const express = require('express');
const router  = express.Router();

const pendingRequests = new Map(); // siteId → { parentClass?, afterClass?, nodes, styles, ts }
const results         = new Map(); // siteId → result object

const REQUEST_TTL_MS = 60_000;

// ── POST /insert/request?siteId= ──────────────────────────────────
router.post('/request', (req, res) => {
  const { siteId } = req.query;
  if (!siteId) return res.status(400).json({ error: 'siteId required' });

  const { parentClass, afterClass, nodes, styles } = req.body;

  if (!parentClass && !afterClass) {
    return res.status(400).json({ error: 'parentClass or afterClass is required' });
  }
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return res.status(400).json({ error: 'nodes must be a non-empty array' });
  }

  pendingRequests.set(String(siteId), { parentClass, afterClass, nodes, styles, ts: Date.now() });
  results.delete(String(siteId));
  res.json({ ok: true });
});

// ── GET /insert/pending?siteId= ───────────────────────────────────
router.get('/pending', (req, res) => {
  const { siteId } = req.query;
  if (!siteId) return res.status(400).json({ error: 'siteId required' });

  const req_ = pendingRequests.get(String(siteId));
  if (!req_ || Date.now() - req_.ts > REQUEST_TTL_MS) {
    pendingRequests.delete(String(siteId));
    return res.set('Cache-Control', 'no-store').json({ pending: false });
  }
  res.set('Cache-Control', 'no-store').json({ pending: true, ...req_ });
});

// ── POST /insert/done?siteId= ─────────────────────────────────────
router.post('/done', (req, res) => {
  const { siteId } = req.query;
  if (!siteId) return res.status(400).json({ error: 'siteId required' });

  pendingRequests.delete(String(siteId));
  results.set(String(siteId), req.body);
  res.json({ ok: true });
});

// ── GET /insert/result?siteId= ────────────────────────────────────
router.get('/result', (req, res) => {
  const { siteId } = req.query;
  if (!siteId) return res.status(400).json({ error: 'siteId required' });

  const result = results.get(String(siteId));
  if (!result) return res.json({ ready: false });
  results.delete(String(siteId));
  res.json({ ready: true, ...result });
});

module.exports = router;
