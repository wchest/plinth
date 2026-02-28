'use strict';

const BASE_URL = 'https://api.webflow.com/v2';

class WebflowClient {
  constructor({ apiToken, siteId }) {
    if (!apiToken) throw new Error('WebflowClient: apiToken is required');
    if (!siteId) throw new Error('WebflowClient: siteId is required');

    this.apiToken = apiToken;
    this.siteId = siteId;
    this.queueCollectionId = null;
  }

  // Fetch all collections for the site and find _Build Queue by name.
  // Sets this.queueCollectionId and returns it. Safe to call multiple times.
  async discoverQueueCollection() {
    const data = await this._request('GET', `/sites/${this.siteId}/collections`);
    const collections = (data && data.collections) ? data.collections : [];
    const queue = collections.find(
      (c) => c.displayName === '_Build Queue' || c.slug === '-build-queue'
    );
    if (!queue) {
      throw new Error(
        '_Build Queue collection not found on site. ' +
        'Create it in the Webflow dashboard first (see README).'
      );
    }
    this.queueCollectionId = queue.id;
    return queue.id;
  }

  _ensureQueue() {
    if (!this.queueCollectionId) {
      const err = new Error(
        'Queue collection not yet discovered. ' +
        'Server is still starting up or _Build Queue collection does not exist.'
      );
      err.status = 503;
      throw err;
    }
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

  _mapItem(item) {
    const fd = item.fieldData || {};
    return {
      id: item.id,
      name: fd.name || fd['name'] || '',
      plan: fd.plan || '',
      status: fd.status || 'pending',
      errorMessage: fd['error-message'] || '',
      order: fd.order != null ? fd.order : 0,
    };
  }

  async getQueueItems() {
    this._ensureQueue();
    const data = await this._request(
      'GET',
      `/collections/${this.queueCollectionId}/items?limit=100`
    );
    const items = (data && data.items) ? data.items : [];
    return items.map((item) => this._mapItem(item));
  }

  async addQueueItem({ name, plan, order }) {
    this._ensureQueue();
    const data = await this._request(
      'POST',
      `/collections/${this.queueCollectionId}/items`,
      {
        fieldData: {
          name,
          plan,
          status: 'pending',
          order: order != null ? order : 0,
        },
      }
    );
    return {
      id: data.id,
      status: (data.fieldData && data.fieldData.status) || 'pending',
    };
  }

  async updateItemStatus(itemId, status, errorMessage) {
    this._ensureQueue();
    const fieldData = { status };
    if (errorMessage !== undefined && errorMessage !== null) {
      fieldData['error-message'] = errorMessage;
    }
    await this._request(
      'PATCH',
      `/collections/${this.queueCollectionId}/items/${itemId}`,
      { fieldData }
    );
  }

  async publishItem(itemId) {
    this._ensureQueue();
    await this._request(
      'POST',
      `/collections/${this.queueCollectionId}/items/${itemId}/live`,
      {}
    );
  }

  async getItem(itemId) {
    this._ensureQueue();
    const data = await this._request(
      'GET',
      `/collections/${this.queueCollectionId}/items/${itemId}`
    );
    return this._mapItem(data);
  }

  async deleteItem(itemId) {
    this._ensureQueue();
    await this._request(
      'DELETE',
      `/collections/${this.queueCollectionId}/items/${itemId}`
    );
  }

  async healthCheck() {
    try {
      const data = await this._request('GET', `/sites/${this.siteId}`);
      return {
        connected: true,
        siteId: this.siteId,
        queueCollectionId: this.queueCollectionId,
        queueReady: !!this.queueCollectionId,
        siteName: (data && data.displayName) || (data && data.name) || undefined,
      };
    } catch (err) {
      return {
        connected: false,
        siteId: this.siteId,
        queueCollectionId: this.queueCollectionId,
        queueReady: false,
        error: err.message,
      };
    }
  }
}

module.exports = WebflowClient;
