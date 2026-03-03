'use strict';

/**
 * /move — relay endpoints for element move / section reorder flow.
 *
 * Flow:
 *   1. MCP tool calls  POST /move/request?siteId=  with one of:
 *        { className, beforeClass|afterClass }  — move a single element
 *        { sectionClasses: string[] }           — reorder sections
 *   2. Extension polls GET  /move/pending?siteId=  → sees the pending request
 *   3. Extension repositions elements, calls POST /move/done?siteId= with { moved, errors }
 *   4. MCP tool polls  GET  /move/done?siteId=     → gets { moved, errors }
 */

const express = require('express');
const router  = express.Router();

const pending = new Map(); // siteId → { timestamp, ...payload }
const results = new Map(); // siteId → { timestamp, moved, errors }

const REQUEST_TTL_MS = 90_000;
const RESULT_TTL_MS  = 300_000;

// ── POST /move/request?siteId= ─────────────────────────────────────
router.post('/request', (req, res) => {
  const { siteId } = req.query;
  if (!siteId) return res.status(400).json({ error: 'siteId required' });

  const { className, beforeClass, afterClass, sectionClasses } = req.body;

  if (sectionClasses) {
    if (!Array.isArray(sectionClasses) || sectionClasses.length < 2) {
      return res.status(400).json({ error: 'sectionClasses must be an array of 2+ class names' });
    }
  } else {
    if (!className) return res.status(400).json({ error: 'className required (or sectionClasses for reorder)' });
    if (!beforeClass && !afterClass) return res.status(400).json({ error: 'beforeClass or afterClass required' });
    if (beforeClass && afterClass)   return res.status(400).json({ error: 'provide beforeClass or afterClass, not both' });
  }

  pending.set(siteId, {
    timestamp: Date.now(),
    className:      className      || null,
    beforeClass:    beforeClass    || null,
    afterClass:     afterClass     || null,
    sectionClasses: sectionClasses || null,
  });
  results.delete(siteId);
  res.json({ ok: true });
});

// ── GET /move/pending?siteId= ──────────────────────────────────────
router.get('/pending', (req, res) => {
  const { siteId } = req.query;
  if (!siteId) return res.status(400).json({ error: 'siteId required' });
  const req_ = pending.get(siteId);
  if (!req_ || Date.now() - req_.timestamp >= REQUEST_TTL_MS) {
    pending.delete(siteId);
    return res.set('Cache-Control', 'no-store').json({ pending: false });
  }
  res.set('Cache-Control', 'no-store').json({
    pending:        true,
    className:      req_.className,
    beforeClass:    req_.beforeClass,
    afterClass:     req_.afterClass,
    sectionClasses: req_.sectionClasses,
  });
});

// ── POST /move/done?siteId= ────────────────────────────────────────
router.post('/done', (req, res) => {
  const { siteId } = req.query;
  if (!siteId) return res.status(400).json({ error: 'siteId required' });
  const { moved, errors } = req.body;
  results.set(siteId, { timestamp: Date.now(), moved: moved || 0, errors: errors || [] });
  pending.delete(siteId);
  res.json({ ok: true });
});

// ── GET /move/done?siteId= ─────────────────────────────────────────
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
