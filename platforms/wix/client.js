'use strict';

/**
 * WixClient — placeholder for Wix API integration.
 *
 * Wix does not expose a design/layout REST API like Webflow does.
 * Available REST APIs cover business data (CMS, eCommerce, CRM) only.
 *
 * Authentication options:
 *   - API Keys: Created in API Keys Manager, sent via Authorization header + wix-site-id header
 *   - OAuth: Client Credentials flow using App ID + App Secret + Instance ID
 *
 * Future work:
 *   - Reverse-engineer the Wix Editor's internal state for editor automation
 *   - Use Wix Headless for programmatic site building (bypasses editor)
 *   - Investigate Wix Studio's VS Code integration for API access
 */
class WixClient {
  constructor(config) {
    const { siteId, apiKey } = config;
    if (!siteId) throw new Error('WixClient: siteId is required');

    this.siteId = siteId;
    this.apiKey = apiKey || null;
  }

  async healthCheck() {
    if (!this.apiKey) {
      return {
        connected: false,
        siteId: this.siteId,
        error: 'No API key configured (Wix support is experimental)',
      };
    }

    try {
      const res = await fetch('https://www.wixapis.com/site-properties/v4/properties', {
        headers: {
          'Authorization': this.apiKey,
          'wix-site-id': this.siteId,
        },
      });

      if (!res.ok) {
        return {
          connected: false,
          siteId: this.siteId,
          error: `Wix API returned ${res.status}`,
        };
      }

      const data = await res.json();
      return {
        connected: true,
        siteId: this.siteId,
        siteName: data.properties?.siteDisplayName || this.siteId,
      };
    } catch (e) {
      return {
        connected: false,
        siteId: this.siteId,
        error: e.message,
      };
    }
  }
}

module.exports = WixClient;
