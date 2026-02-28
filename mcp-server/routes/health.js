'use strict';

const express = require('express');

const router = express.Router();

// GET /health
// Returns status of all configured sites.
router.get('/', async (req, res) => {
  const registry = req.app.locals.siteRegistry;
  const sites = registry.summary();

  // Run healthCheck on all sites in parallel
  const checks = await Promise.all(
    sites.map(async ({ siteId, name, queueReady, queueCollectionId }) => {
      const client = registry.getClient(siteId);
      const result = await client.healthCheck();
      return { name, ...result, queueReady, queueCollectionId };
    })
  );

  const allConnected = checks.every((c) => c.connected);
  return res.status(allConnected ? 200 : 502).json({ sites: checks });
});

module.exports = router;
