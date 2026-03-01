'use strict';

const express = require('express');
const router = express.Router();

// In-memory log store.
// Key: itemId, Value: { messages: string[], ts: number }
const logStore = new Map();

const MAX_MESSAGES = 500;       // cap per build item
const TTL_MS = 2 * 60 * 60 * 1000; // 2 hours — auto-expire

function pruneExpired() {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, entry] of logStore) {
    if (entry.ts < cutoff) logStore.delete(id);
  }
}

// POST /log/:itemId — append a log message (called by Designer Extension)
router.post('/:itemId', (req, res) => {
  const { itemId } = req.params;
  const { message } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message is required' });
  }

  pruneExpired();

  if (!logStore.has(itemId)) {
    logStore.set(itemId, { messages: [], ts: Date.now() });
  }
  const entry = logStore.get(itemId);
  entry.ts = Date.now();

  if (entry.messages.length >= MAX_MESSAGES) {
    entry.messages.shift(); // drop oldest when full
  }
  entry.messages.push(message);

  return res.json({ ok: true });
});

// GET /log/:itemId — retrieve log messages
router.get('/:itemId', (req, res) => {
  const entry = logStore.get(req.params.itemId);
  return res.json({ messages: entry ? entry.messages : [] });
});

// DELETE /log/:itemId — clear log for an item (called on cleanup)
router.delete('/:itemId', (req, res) => {
  logStore.delete(req.params.itemId);
  return res.json({ ok: true });
});

module.exports = router;
