export interface DiscoveredConfig {
  siteId: string;
  siteName?: string;
}

/**
 * Auto-detect the current site ID from the Designer API, then verify
 * the relay server is reachable and has the site configured.
 */
export async function discoverConfig(relayUrl: string): Promise<DiscoveredConfig> {
  // 1. Get site ID from the Designer context
  const siteInfo = await webflow.getSiteInfo();
  const siteId = siteInfo.siteId;

  if (!siteId) {
    throw new Error('Could not determine site ID from Webflow Designer.');
  }

  // 2. Verify relay is reachable and has this site configured
  let health: { sites?: Array<{ siteId: string; queueReady: boolean }> };
  try {
    const res = await fetch(`${relayUrl}/health`);
    if (!res.ok) {
      throw new Error(`Relay returned ${res.status}`);
    }
    health = await res.json();
  } catch (err) {
    throw new Error(
      `Cannot reach relay at ${relayUrl}. Run "plinth server" and try again.\n${err instanceof Error ? err.message : String(err)}`
    );
  }

  const site = (health.sites ?? []).find((s) => s.siteId === siteId);

  if (!site) {
    throw new Error(
      `Site ${siteId} is not configured in the relay. Add it to your .plinth.json and restart.`
    );
  }

  if (!site.queueReady) {
    throw new Error(
      '_Build Queue collection not yet discovered. Restart the relay after creating the collection.'
    );
  }

  return { siteId, siteName: siteInfo.siteName ?? undefined };
}
