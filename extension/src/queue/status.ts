export type QueueStatus = 'pending' | 'building' | 'done' | 'error';

export interface QueueItem {
  id: string;
  name: string;
  plan: string;
  status: QueueStatus;
  errorMessage?: string;
  order: number;
}

interface WebflowCmsItem {
  id: string;
  fieldData: {
    name: string;
    plan: string;
    status: QueueStatus;
    'error-message'?: string;
    order: number;
  };
}

interface WebflowCmsResponse {
  items: WebflowCmsItem[];
}

function makeHeaders(apiToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiToken}`,
    'accept-version': '1.0.0',
    'Content-Type': 'application/json',
  };
}

export async function getQueueItems(
  siteId: string,
  collectionId: string,
  apiToken: string
): Promise<QueueItem[]> {
  const url = `https://api.webflow.com/v2/collections/${collectionId}/items?limit=100`;

  const response = await fetch(url, {
    method: 'GET',
    headers: makeHeaders(apiToken),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Failed to fetch queue items: ${response.status} ${response.statusText} — ${body}`
    );
  }

  const data: WebflowCmsResponse = await response.json();

  return data.items.map((item) => ({
    id: item.id,
    name: item.fieldData.name ?? '',
    plan: item.fieldData.plan ?? '',
    status: item.fieldData.status ?? 'pending',
    errorMessage: item.fieldData['error-message'] || undefined,
    order: item.fieldData.order ?? 0,
  }));
}

export async function setItemStatus(
  collectionId: string,
  itemId: string,
  status: QueueStatus,
  apiToken: string,
  errorMessage?: string
): Promise<void> {
  const patchUrl = `https://api.webflow.com/v2/collections/${collectionId}/items/${itemId}`;

  const patchResponse = await fetch(patchUrl, {
    method: 'PATCH',
    headers: makeHeaders(apiToken),
    body: JSON.stringify({
      fieldData: {
        status,
        'error-message': errorMessage ?? '',
      },
    }),
  });

  if (!patchResponse.ok) {
    const body = await patchResponse.text();
    throw new Error(
      `Failed to update item status: ${patchResponse.status} ${patchResponse.statusText} — ${body}`
    );
  }

  // Publish the item to make the update live
  const publishUrl = `https://api.webflow.com/v2/collections/${collectionId}/items/${itemId}/live`;

  const publishResponse = await fetch(publishUrl, {
    method: 'POST',
    headers: makeHeaders(apiToken),
  });

  if (!publishResponse.ok) {
    const body = await publishResponse.text();
    throw new Error(
      `Failed to publish item: ${publishResponse.status} ${publishResponse.statusText} — ${body}`
    );
  }
}
