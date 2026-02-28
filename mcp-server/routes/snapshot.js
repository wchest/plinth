'use strict';

/**
 * /snapshot — relay endpoints for DOM snapshot flow.
 *
 * Flow:
 *   1. MCP tool calls  POST /snapshot/request?siteId=   → marks a request pending
 *   2. Extension polls GET  /snapshot/pending?siteId=   → sees { pending: true }
 *   3. Extension captures DOM, calls POST /snapshot?siteId= with { summary, pageInfo }
 *   4. MCP tool polls GET  /snapshot?siteId=            → gets { summary, pageInfo, timestamp }
 */

const express = require('express');
const router  = express.Router();

// Per-site in-memory state
const pending   = new Map(); // siteId → request timestamp (ms)
const snapshots = new Map(); // siteId → { timestamp, summary, pageInfo }

const REQUEST_TTL_MS  = 90_000;  // pending request expires after 90 s
const SNAPSHOT_TTL_MS = 300_000; // cached snapshot stale after 5 min

// ── POST /snapshot/request?siteId= ────────────────────────────────
// Called by the MCP tool to trigger a capture in the extension.
router.post('/request', (req, res) => {
  const { siteId } = req.query;
  if (!siteId) return res.status(400).json({ error: 'siteId required' });
  pending.set(siteId, Date.now());
  snapshots.delete(siteId); // clear old snapshot so we wait for a fresh one
  res.json({ ok: true });
});

// ── GET /snapshot/pending?siteId= ─────────────────────────────────
// Polled by the extension every few seconds.
router.get('/pending', (req, res) => {
  const { siteId } = req.query;
  if (!siteId) return res.status(400).json({ error: 'siteId required' });
  const ts = pending.get(siteId);
  const isPending = !!ts && (Date.now() - ts) < REQUEST_TTL_MS;
  if (!isPending) pending.delete(siteId);
  res.json({ pending: isPending });
});

// ── POST /snapshot?siteId= ────────────────────────────────────────
// Extension submits the captured DOM summary here.
router.post('/', (req, res) => {
  const { siteId } = req.query;
  if (!siteId) return res.status(400).json({ error: 'siteId required' });
  const { summary, pageInfo } = req.body;
  if (typeof summary !== 'string' || !summary) {
    return res.status(400).json({ error: 'summary (string) required' });
  }
  snapshots.set(siteId, {
    timestamp: Date.now(),
    summary,
    pageInfo: pageInfo || null,
  });
  pending.delete(siteId);
  res.json({ ok: true });
});

// ── GET /snapshot?siteId= ─────────────────────────────────────────
// MCP tool polls this until the snapshot arrives.
router.get('/', (req, res) => {
  const { siteId } = req.query;
  if (!siteId) return res.status(400).json({ error: 'siteId required' });
  const snap = snapshots.get(siteId);
  if (!snap) return res.status(404).json({ error: 'no snapshot available yet' });
  if (Date.now() - snap.timestamp > SNAPSHOT_TTL_MS) {
    snapshots.delete(siteId);
    return res.status(404).json({ error: 'snapshot expired' });
  }
  res.json(snap);
});

module.exports = router;
