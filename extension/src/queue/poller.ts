import { executeBuildPlan, BuildResult } from '../builder/executor';
import { getQueueItems, setItemStatus, QueueItem } from './status';

export interface PollerConfig {
  siteId: string;
  collectionId: string;
  apiToken: string;
  onStatusChange?: (items: QueueItem[]) => void;
  onBuildStart?: (item: QueueItem) => void;
  onBuildComplete?: (item: QueueItem, result: BuildResult) => void;
  onError?: (error: Error) => void;
}

const POLL_INTERVAL_MS = 5000;

export class BuildQueuePoller {
  private config: PollerConfig;
  private running: boolean = false;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(config: PollerConfig) {
    this.config = config;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext(0);
  }

  stop(): void {
    this.running = false;
    if (this.timeoutHandle !== null) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  async processNext(): Promise<void> {
    const { siteId, collectionId, apiToken } = this.config;

    let items: QueueItem[];
    try {
      items = await getQueueItems(siteId, collectionId, apiToken);
    } catch (err) {
      this.config.onError?.(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    this.config.onStatusChange?.(items);

    // Find the first pending item sorted by order
    const pending = items
      .filter((item) => item.status === 'pending')
      .sort((a, b) => a.order - b.order);

    if (pending.length === 0) return;

    const item = pending[0];

    try {
      await setItemStatus(collectionId, item.id, 'building', apiToken);
      const updatedItem: QueueItem = { ...item, status: 'building' };
      this.config.onBuildStart?.(updatedItem);

      // Re-fetch items so the UI reflects the building state
      try {
        const refreshed = await getQueueItems(siteId, collectionId, apiToken);
        this.config.onStatusChange?.(refreshed);
      } catch {
        // Non-fatal — continue with build even if refresh fails
      }

      let plan: unknown;
      try {
        plan = JSON.parse(item.plan);
      } catch {
        throw new Error(`Failed to parse BuildPlan JSON for "${item.name}": invalid JSON`);
      }

      const result = await executeBuildPlan(plan);

      if (!result.success) {
        const errorMsg = result.error ?? 'Build failed with no error message';
        throw new Error(errorMsg);
      }

      await setItemStatus(collectionId, item.id, 'done', apiToken);
      this.config.onBuildComplete?.({ ...updatedItem, status: 'done' }, result);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      try {
        await setItemStatus(collectionId, item.id, 'error', apiToken, error.message);
      } catch {
        // Best-effort — report the original build error regardless
      }
      this.config.onError?.(error);
    }

    // Re-fetch and notify after processing so UI is current
    try {
      const finalItems = await getQueueItems(siteId, collectionId, apiToken);
      this.config.onStatusChange?.(finalItems);
    } catch {
      // Non-fatal
    }
  }

  private scheduleNext(delayMs: number): void {
    this.timeoutHandle = setTimeout(async () => {
      if (!this.running) return;
      await this.processNext();
      if (this.running) {
        this.scheduleNext(POLL_INTERVAL_MS);
      }
    }, delayMs);
  }
}
