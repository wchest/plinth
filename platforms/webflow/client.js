'use strict';

const BASE_URL = 'https://api.webflow.com/v2';

class WebflowClient {
  constructor(config) {
    const { apiToken, siteId } = config;
    if (!apiToken) throw new Error('WebflowClient: apiToken is required');
    if (!siteId) throw new Error('WebflowClient: siteId is required');

    this.apiToken = apiToken;
    this.siteId = siteId;
  }

  _headers() {
    return {
      'Authorization': `Bearer ${this.apiToken}`,
      'accept-version': '1.0.0',
      'Content-Type': 'application/json',
    };
  }

  async _request(method, path, body) {
    const url = `${BASE_URL}${path}`;
    const options = {
      method,
      headers: this._headers(),
    };

    if (body !== undefined) {
      options.body = JSON.stringify(body);
    }

    const res = await fetch(url, options);

    if (!res.ok) {
      let message = `Webflow API error ${res.status}`;
      try {
        const data = await res.json();
        message = data.message || data.msg || JSON.stringify(data) || message;
      } catch (_) {
        // ignore parse errors, keep generic message
      }
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }

    // 204 No Content
    if (res.status === 204) return null;

    return res.json();
  }

  async listPages() {
    const data = await this._request('GET', `/sites/${this.siteId}/pages`);
    return (data && data.pages) ? data.pages : [];
  }

  async getPageDom(pageId) {
    return this._request('GET', `/pages/${pageId}/dom`);
  }

  async getPageContent(pageId, { limit = 100, offset = 0 } = {}) {
    return this._request(
      'GET', `/pages/${pageId}/dom?limit=${limit}&offset=${offset}`
    );
  }

  async listStylesFromDom(pageId) {
    const data = await this._request('GET', `/pages/${pageId}/dom`);
    const nodes = (data && data.nodes) ? data.nodes : [];
    const classes = new Set();
    for (const node of nodes) {
      for (const cls of (node.classes || [])) classes.add(cls);
    }
    return { classes: [...classes].sort(), nodeCount: nodes.length };
  }

  async getSiteInfo() {
    return this._request('GET', `/sites/${this.siteId}`);
  }

  async publishToStaging() {
    return this._request('POST', `/sites/${this.siteId}/publish`, {
      publishToWebflowSubdomain: true,
      customDomains: [],
    });
  }

  async healthCheck() {
    try {
      const data = await this._request('GET', `/sites/${this.siteId}`);
      return {
        connected: true,
        siteId: this.siteId,
        siteName: (data && data.displayName) || (data && data.name) || undefined,
      };
    } catch (err) {
      return {
        connected: false,
        siteId: this.siteId,
        error: err.message,
      };
    }
  }
}

module.exports = WebflowClient;
