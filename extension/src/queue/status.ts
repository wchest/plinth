export type QueueStatus = 'pending' | 'building' | 'done' | 'error';

export interface QueueItem {
  id: string;
  name: string;
  plan: string;
  status: QueueStatus;
  errorMessage?: string;
  order: number;
}

export async function getQueueItems(siteId: string, relayUrl: string): Promise<QueueItem[]> {
  const res = await fetch(`${relayUrl}/status?siteId=${encodeURIComponent(siteId)}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to fetch queue: ${res.status} — ${body}`);
  }
  return res.json();
}

export async function getQueueItem(siteId: string, itemId: string, relayUrl: string): Promise<QueueItem> {
  const res = await fetch(`${relayUrl}/status/${itemId}?siteId=${encodeURIComponent(siteId)}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to fetch item: ${res.status} — ${body}`);
  }
  return res.json();
}

export interface BuildStats {
  elementsCreated: number;
  stylesCreated: number;
  elapsedMs: number;
}

/**
 * Post a single log message to the relay's in-memory log buffer.
 * Fire-and-forget — log failures never affect builds.
 */
export function postLog(
  itemId: string,
  message: string,
  relayUrl: string,
): void {
  fetch(`${relayUrl}/log/${itemId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  }).catch(() => {});
}

export async function setItemStatus(
  siteId: string,
  itemId: string,
  status: QueueStatus,
  relayUrl: string,
  errorMessage?: string,
  buildStats?: BuildStats,
): Promise<void> {
  const res = await fetch(`${relayUrl}/status/${itemId}?siteId=${encodeURIComponent(siteId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, errorMessage, buildStats }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to update status: ${res.status} — ${body}`);
  }
}
