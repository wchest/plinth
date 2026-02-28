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

export async function setItemStatus(
  siteId: string,
  itemId: string,
  status: QueueStatus,
  relayUrl: string,
  errorMessage?: string,
): Promise<void> {
  const res = await fetch(`${relayUrl}/status/${itemId}?siteId=${encodeURIComponent(siteId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, errorMessage }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to update status: ${res.status} — ${body}`);
  }
}
