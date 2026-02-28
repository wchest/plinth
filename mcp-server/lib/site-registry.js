'use strict';

const fs = require('fs');
const path = require('path');
const WebflowClient = require('./webflow-client');

/**
 * Loads site credentials from a JSON config file and manages one
 * WebflowClient per site. Routes use getClient(siteId) to get the
 * right client for each request.
 *
 * Config file formats supported:
 *
 * Array (multi-site, default sites.json):
 *   [
 *     { "siteId": "abc123", "name": "my-site", "apiToken": "..." },
 *     { "siteId": "def456", "name": "other",  "apiToken": "..." }
 *   ]
 *
 * Object (single-site, .plinth.json in a project repo):
 *   { "siteId": "abc123", "name": "my-site", "apiToken": "..." }
 */
class SiteRegistry {
  constructor(configPath) {
    this.configPath = configPath;
    this.clients = new Map();   // siteId → WebflowClient
    this.siteNames = new Map(); // siteId → name (for logging)
    this._load();
  }

  _load() {
    if (!fs.existsSync(this.configPath)) {
      throw new Error(
        `Plinth config not found: ${this.configPath}\n` +
        'Create it from sites.example.json (multi-site) or .plinth.example.json (single-site).'
      );
    }

    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
    } catch (err) {
      throw new Error(`Failed to parse ${this.configPath}: ${err.message}`);
    }

    // Normalise to array
    const entries = Array.isArray(raw) ? raw : [raw];

    for (const entry of entries) {
      const { siteId, name, apiToken } = entry;
      if (!siteId || !apiToken) {
        throw new Error(`Invalid config entry — every site needs "siteId" and "apiToken": ${JSON.stringify(entry)}`);
      }
      this.clients.set(siteId, new WebflowClient({ apiToken, siteId }));
      this.siteNames.set(siteId, name || siteId);
    }

    console.log(
      `[plinth] Loaded ${this.clients.size} site(s) from ${path.basename(this.configPath)}:`,
      [...this.siteNames.values()].join(', ')
    );
  }

  // Returns the WebflowClient for a given siteId. Throws 404 if not configured.
  getClient(siteId) {
    const client = this.clients.get(siteId);
    if (!client) {
      const known = [...this.siteNames.values()].join(', ');
      const err = new Error(
        `Site ${siteId} is not configured. ` +
        `Known sites: ${known || '(none)'}. ` +
        `Add it to ${path.basename(this.configPath)}.`
      );
      err.status = 404;
      throw err;
    }
    return client;
  }

  // Discover the _Build Queue collection for every configured site.
  async discoverAll() {
    const results = [];
    for (const [siteId, client] of this.clients) {
      const name = this.siteNames.get(siteId);
      try {
        const collectionId = await client.discoverQueueCollection();
        console.log(`[plinth] ${name}: queue collection ${collectionId}`);
        results.push({ siteId, name, collectionId, ok: true });
      } catch (err) {
        console.warn(`[plinth] ${name}: ${err.message}`);
        results.push({ siteId, name, ok: false, error: err.message });
      }
    }
    return results;
  }

  // Returns a summary of all configured sites (no secrets).
  summary() {
    return [...this.clients.entries()].map(([siteId, client]) => ({
      siteId,
      name: this.siteNames.get(siteId),
      queueReady: !!client.queueCollectionId,
      queueCollectionId: client.queueCollectionId,
    }));
  }
}

module.exports = SiteRegistry;
