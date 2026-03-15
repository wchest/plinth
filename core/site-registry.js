'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Platform-aware site registry.
 *
 * Loads site credentials from a JSON config file and manages one
 * API client per site. The `platform` field in each config entry
 * determines which client class to instantiate.
 *
 * Config file formats supported:
 *
 * Array (multi-site):
 *   [
 *     { "platform": "webflow", "siteId": "abc123", "name": "my-site", "apiToken": "..." },
 *     { "platform": "wix",     "siteId": "def456", "name": "other",   "apiKey": "..." }
 *   ]
 *
 * Object (single-site, .plinth.json in a project repo):
 *   { "siteId": "abc123", "name": "my-site", "apiToken": "..." }
 *   (platform defaults to "webflow" for backward compatibility)
 */
class SiteRegistry {
  constructor(configPath) {
    this.configPath = configPath;
    this.clients = new Map();    // siteId -> client instance
    this.siteNames = new Map();  // siteId -> name
    this.platforms = new Map();  // siteId -> platform name
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
      const { siteId, name, platform: platformName } = entry;
      // Default to webflow for backward compatibility
      const platform = platformName || 'webflow';

      if (!siteId) {
        throw new Error(`Invalid config entry — every site needs "siteId": ${JSON.stringify(entry)}`);
      }

      // Load the platform's client class
      const Client = this._loadClient(platform);
      this.clients.set(siteId, new Client(entry));
      this.siteNames.set(siteId, name || siteId);
      this.platforms.set(siteId, platform);
    }
  }

  _loadClient(platform) {
    try {
      return require(`../platforms/${platform}/client`);
    } catch (e) {
      throw new Error(
        `Unknown platform "${platform}". ` +
        `Available platforms: ${this._availablePlatforms().join(', ')}`
      );
    }
  }

  _availablePlatforms() {
    const platformsDir = path.join(__dirname, '..', 'platforms');
    try {
      return fs.readdirSync(platformsDir).filter(d =>
        fs.statSync(path.join(platformsDir, d)).isDirectory()
      );
    } catch (_) {
      return [];
    }
  }

  // Returns the client for a given siteId. Throws if not configured.
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

  // Returns the platform name for a given siteId.
  getPlatform(siteId) {
    return this.platforms.get(siteId);
  }

  // Returns the set of distinct platform names in use.
  getPlatformNames() {
    return new Set(this.platforms.values());
  }

  // Returns a summary of all configured sites (no secrets).
  summary() {
    return [...this.clients.entries()].map(([siteId]) => ({
      siteId,
      name: this.siteNames.get(siteId),
      platform: this.platforms.get(siteId),
    }));
  }
}

module.exports = SiteRegistry;
