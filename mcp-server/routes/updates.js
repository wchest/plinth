'use strict';

/**
 * /updates — relay endpoints for style and content update flow.
 *
 * Flow (same pattern as /snapshot and /delete):
 *   1. MCP tool  POST /updates/request?siteId=  → stores pending request
 *   2. Extension GET  /updates/pending?siteId=  → sees { pending: true, type, ... }
 *   3. Extension executes update, POST /updates/done?siteId= with result
 *   4. MCP tool  GET  /updates/result?siteId=   → gets result
 *
 * type: 'styles'  → update CSS properties on existing named styles
 * type: 'content' → patch text / href / src / alt on elements by className
 */

const express = require('express');
const router  = express.Router();

// Per-site in-memory state
const pendingRequests = new Map(); // siteId → { type, ...payload, ts }
const results         = new Map(); // siteId → result object

const REQUEST_TTL_MS = 60_000; // pending request expires after 60s

// ── POST /updates/request?siteId= ─────────────────────────────────
router.post('/request', (req, res) => {
  const { siteId } = req.query;
  if (!siteId) return res.status(400).json({ error: 'siteId required' });

  const { type, styles, updates } = req.body;
  if (type !== 'styles' && type !== 'content') {
    return res.status(400).json({ error: 'type must be "styles" or "content"' });
  }

  pendingRequests.set(String(siteId), { type, styles, updates, ts: Date.now() });
  results.delete(String(siteId));
  res.json({ ok: true });
});

// ── GET /updates/pending?siteId= ──────────────────────────────────
// Polled by the extension every tick.
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

// ── POST /updates/done?siteId= ────────────────────────────────────
// Extension posts result here after executing the update.
router.post('/done', (req, res) => {
  const { siteId } = req.query;
  if (!siteId) return res.status(400).json({ error: 'siteId required' });

  pendingRequests.delete(String(siteId));
  results.set(String(siteId), req.body);
  res.json({ ok: true });
});

// ── GET /updates/result?siteId= ───────────────────────────────────
// MCP tool polls this until the result arrives.
router.get('/result', (req, res) => {
  const { siteId } = req.query;
  if (!siteId) return res.status(400).json({ error: 'siteId required' });

  const result = results.get(String(siteId));
  if (!result) return res.json({ ready: false });
  results.delete(String(siteId));
  res.json({ ready: true, ...result });
});

module.exports = router;
