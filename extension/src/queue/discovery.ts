const BASE_URL = 'https://api.webflow.com/v2';

export interface DiscoveredConfig {
  siteId: string;
  collectionId: string;
  siteName?: string;
}

/**
 * Auto-detect the current site ID from the Designer API, then query the
 * Webflow Data API to find the _Build Queue collection by name.
 */
export async function discoverConfig(apiToken: string): Promise<DiscoveredConfig> {
  // 1. Get site ID from the Designer context — no manual input needed
  const siteInfo = await webflow.getSiteInfo();
  const siteId = siteInfo.siteId;

  if (!siteId) {
    throw new Error('Could not determine site ID from Webflow Designer.');
  }

  // 2. List all collections on the site via the Data API
  const res = await fetch(`${BASE_URL}/sites/${siteId}/collections`, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'accept-version': '1.0.0',
    },
  });

  if (!res.ok) {
    let msg = `Webflow API error ${res.status}`;
    try {
      const body = await res.json();
      msg = body.message || body.msg || msg;
    } catch (_) { /* ignore */ }
    throw new Error(msg);
  }

  const data = await res.json();
  const collections: Array<{ id: string; displayName: string; slug?: string }> =
    data.collections ?? [];

  // 3. Find _Build Queue by display name or slug
  const queue = collections.find(
    (c) => c.displayName === '_Build Queue' || c.slug === '-build-queue'
  );

  if (!queue) {
    throw new Error(
      '_Build Queue collection not found on this site.\n' +
      'Create it in the Webflow CMS dashboard first.'
    );
  }

  return {
    siteId,
    collectionId: queue.id,
    siteName: siteInfo.siteName ?? undefined,
  };
}
