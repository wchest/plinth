'use strict';

const express = require('express');

const router = express.Router();

// In-memory status overrides — used when Webflow CMS option names don't match
// our expected values and PATCH updates don't persist.
// Key: itemId, Value: { status, errorMessage, buildStats, ts }
const statusOverrides = new Map();

// GET /status?siteId=...
// Returns all queue items for a site.
router.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { siteId } = req.query;

  if (!siteId) {
    return res.status(400).json({ error: 'siteId query parameter is required' });
  }

  let client;
  try {
    client = req.app.locals.siteRegistry.getClient(siteId);
  } catch (err) {
    return res.status(err.status || 404).json({ error: err.message });
  }

  let items;
  try {
    items = await client.getQueueItems();
  } catch (err) {
    return res.status(500).json({ error: `Failed to fetch queue: ${err.message}` });
  }

  return res.json(items.map((item) => {
    const override = statusOverrides.get(item.id);
    return {
      id: item.id,
      name: item.name,
      status: override ? override.status : item.status,
      order: item.order,
    };
  }));
});

// GET /status/:itemId?siteId=...
// Returns a single queue item.
router.get('/:itemId', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { itemId } = req.params;
  const { siteId } = req.query;

  if (!siteId) {
    return res.status(400).json({ error: 'siteId query parameter is required' });
  }

  let client;
  try {
    client = req.app.locals.siteRegistry.getClient(siteId);
  } catch (err) {
    return res.status(err.status || 404).json({ error: err.message });
  }

  let item;
  try {
    item = await client.getItem(itemId);
  } catch (err) {
    return res.status(err.status === 404 ? 404 : 500).json({ error: err.message });
  }

  const override = statusOverrides.get(itemId);
  const response = {
    id: item.id,
    name: item.name,
    status: override ? override.status : item.status,
    order: item.order,
    plan: item.plan,
  };
  const errorMessage = override ? override.errorMessage : item.errorMessage;
  if (errorMessage) response.errorMessage = errorMessage;
  if (override?.buildStats) response.buildStats = override.buildStats;

  return res.json(response);
});

// PATCH /status/:itemId?siteId=...
// Updates a queue item's status. Called by the Designer Extension.
router.patch('/:itemId', async (req, res) => {
  const { itemId } = req.params;
  const { siteId } = req.query;
  const { status, errorMessage, buildStats } = req.body;

  if (!siteId) {
    return res.status(400).json({ error: 'siteId query parameter is required' });
  }
  if (!status) {
    return res.status(400).json({ error: 'status is required in body' });
  }

  let client;
  try {
    client = req.app.locals.siteRegistry.getClient(siteId);
  } catch (err) {
    return res.status(err.status || 404).json({ error: err.message });
  }

  // Always store in-memory so the GET reflects it even if Webflow rejects the option value
  statusOverrides.set(itemId, { status, errorMessage, buildStats: buildStats ?? null, ts: Date.now() });

  try {
    await client.updateItemStatus(itemId, status, errorMessage);
  } catch (err) {
    return res.status(err.status === 404 ? 404 : 500).json({ error: err.message });
  }

  return res.json({ id: itemId, status });
});

module.exports = router;
