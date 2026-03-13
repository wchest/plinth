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
 * Array (multi-site):
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
        'Create it with: plinth init'
      );
    }

    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
    } catch (err) {
      throw new Error(`Failed to parse ${this.configPath}: ${err.message}`);
    }

    // Optional top-level relayUrl (defaults to localhost:3847)
    this.relayUrl = (!Array.isArray(raw) && raw.relayUrl)
      ? raw.relayUrl.replace(/\/$/, '')
      : 'http://localhost:3847';

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

  // Returns a summary of all configured sites (no secrets).
  summary() {
    return [...this.clients.entries()].map(([siteId]) => ({
      siteId,
      name: this.siteNames.get(siteId),
    }));
  }
}

module.exports = SiteRegistry;
