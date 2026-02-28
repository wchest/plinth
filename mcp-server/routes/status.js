'use strict';

const express = require('express');

const router = express.Router();

// GET /status?siteId=...
// Returns all queue items for a site.
router.get('/', async (req, res) => {
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

  return res.json(items.map((item) => ({
    id: item.id,
    name: item.name,
    status: item.status,
    order: item.order,
  })));
});

// GET /status/:itemId?siteId=...
// Returns a single queue item.
router.get('/:itemId', async (req, res) => {
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

  const response = { id: item.id, name: item.name, status: item.status, order: item.order };
  if (item.errorMessage) response.errorMessage = item.errorMessage;

  return res.json(response);
});

module.exports = router;
