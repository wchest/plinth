'use strict';

/**
 * /delete — relay endpoints for element deletion flow.
 *
 * Flow:
 *   1. MCP tool calls  POST /delete/request?siteId=  with { elementIds } or { sectionClass }
 *   2. Extension polls GET  /delete/pending?siteId=  → sees { pending: true, elementIds, sectionClass }
 *   3. Extension removes matching elements, calls POST /delete/done?siteId= with { deleted, errors }
 *   4. MCP tool polls  GET  /delete/done?siteId=     → gets { deleted, errors }
 */

const express = require('express');
const router  = express.Router();

const pending = new Map(); // siteId → { timestamp, elementIds, sectionClass }
const results = new Map(); // siteId → { timestamp, deleted, errors }

const REQUEST_TTL_MS = 90_000;
const RESULT_TTL_MS  = 300_000;

// ── POST /delete/request?siteId= ───────────────────────────────────
router.post('/request', (req, res) => {
  const { siteId } = req.query;
  if (!siteId) return res.status(400).json({ error: 'siteId required' });
  const { elementIds, sectionClass } = req.body;
  if (!elementIds?.length && !sectionClass) {
    return res.status(400).json({ error: 'elementIds (array) or sectionClass (string) required' });
  }
  pending.set(siteId, { timestamp: Date.now(), elementIds: elementIds || null, sectionClass: sectionClass || null });
  results.delete(siteId);
  res.json({ ok: true });
});

// ── GET /delete/pending?siteId= ────────────────────────────────────
router.get('/pending', (req, res) => {
  const { siteId } = req.query;
  if (!siteId) return res.status(400).json({ error: 'siteId required' });
  const req_ = pending.get(siteId);
  if (!req_ || Date.now() - req_.timestamp >= REQUEST_TTL_MS) {
    pending.delete(siteId);
    return res.set('Cache-Control', 'no-store').json({ pending: false });
  }
  res.set('Cache-Control', 'no-store').json({
    pending: true,
    elementIds:   req_.elementIds   || null,
    sectionClass: req_.sectionClass || null,
  });
});

// ── POST /delete/done?siteId= ──────────────────────────────────────
router.post('/done', (req, res) => {
  const { siteId } = req.query;
  if (!siteId) return res.status(400).json({ error: 'siteId required' });
  const { deleted, errors } = req.body;
  results.set(siteId, { timestamp: Date.now(), deleted: deleted || 0, errors: errors || [] });
  pending.delete(siteId);
  res.json({ ok: true });
});

// ── GET /delete/done?siteId= ───────────────────────────────────────
router.get('/done', (req, res) => {
  const { siteId } = req.query;
  if (!siteId) return res.status(400).json({ error: 'siteId required' });
  const result = results.get(siteId);
  if (!result) return res.status(404).json({ error: 'no result yet' });
  if (Date.now() - result.timestamp > RESULT_TTL_MS) {
    results.delete(siteId);
    return res.status(404).json({ error: 'result expired' });
  }
  res.json(result);
});

module.exports = router;
