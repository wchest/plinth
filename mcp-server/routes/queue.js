'use strict';

const express = require('express');
const { validateBuildPlan, ValidationError } = require('../lib/validator');

const router = express.Router();

// POST /queue
// Accepts a BuildPlan JSON body. Routes to the correct site via plan.siteId.
router.post('/', async (req, res) => {
  const plan = req.body;

  try {
    validateBuildPlan(plan);
  } catch (err) {
    if (err instanceof ValidationError) {
      return res.status(400).json({ error: err.message });
    }
    throw err;
  }

  let client;
  try {
    client = req.app.locals.siteRegistry.getClient(plan.siteId);
  } catch (err) {
    return res.status(err.status || 404).json({ error: err.message });
  }

  const sectionName = plan.sectionName || 'unnamed';

  let order = 1;
  try {
    const existing = await client.getQueueItems();
    order = existing.length + 1;
  } catch (_) {
    // Non-fatal — default to 1
  }

  let item;
  try {
    item = await client.addQueueItem({ name: sectionName, plan: JSON.stringify(plan), order });
  } catch (err) {
    return res.status(500).json({ error: `Failed to write to build queue: ${err.message}` });
  }

  return res.status(201).json({
    itemId: item.id,
    status: item.status || 'pending',
    siteId: plan.siteId,
    sectionName,
    order,
  });
});

// DELETE /queue/:itemId?siteId=...
router.delete('/:itemId', async (req, res) => {
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

  try {
    await client.deleteItem(itemId);
  } catch (err) {
    return res.status(err.status === 404 ? 404 : 500).json({ error: err.message });
  }

  return res.json({ deleted: true });
});

// POST /queue/clear?siteId=...
router.post('/clear', async (req, res) => {
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
    return res.status(500).json({ error: `Failed to fetch queue items: ${err.message}` });
  }

  const clearable = items.filter((i) => i.status === 'done' || i.status === 'error');
  const results = await Promise.allSettled(clearable.map((i) => client.deleteItem(i.id)));

  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length > 0) {
    const messages = failed.map((r) => r.reason?.message).filter(Boolean);
    return res.status(500).json({
      error: `Failed to delete ${failed.length} item(s): ${messages.join('; ')}`,
      cleared: results.length - failed.length,
    });
  }

  return res.json({ cleared: clearable.length });
});

module.exports = router;
