import { executeBuildPlan, BuildResult } from '../builder/executor';
import { getQueueItems, getQueueItem, setItemStatus, QueueItem } from './status';
import { checkAndSendSnapshot } from './snapshot';

export interface PollerConfig {
  siteId: string;
  relayUrl: string;
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
    const { siteId, relayUrl } = this.config;

    // Check for pending DOM snapshot requests (for get_page_dom / list_styles MCP tools)
    await checkAndSendSnapshot(siteId, relayUrl);

    let items: QueueItem[];
    try {
      items = await getQueueItems(siteId, relayUrl);
    } catch (err) {
      this.config.onError?.(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    this.config.onStatusChange?.(items);

    const pending = items
      .filter((item) => item.status === 'pending')
      .sort((a, b) => a.order - b.order);

    if (pending.length === 0) return;

    const item = pending[0];

    try {
      await setItemStatus(siteId, item.id, 'building', relayUrl);
      const updatedItem: QueueItem = { ...item, status: 'building' };
      this.config.onBuildStart?.(updatedItem);

      // Refresh UI to show building state
      try {
        const refreshed = await getQueueItems(siteId, relayUrl);
        this.config.onStatusChange?.(refreshed);
      } catch {
        // Non-fatal
      }

      // Fetch full item to get plan JSON
      const fullItem = await getQueueItem(siteId, item.id, relayUrl);

      let plan: unknown;
      try {
        plan = JSON.parse(fullItem.plan);
      } catch {
        throw new Error(`Failed to parse BuildPlan JSON for "${item.name}": invalid JSON`);
      }

      const result = await executeBuildPlan(plan);

      if (!result.success) {
        throw new Error(result.error ?? 'Build failed with no error message');
      }

      await setItemStatus(siteId, item.id, 'done', relayUrl);
      this.config.onBuildComplete?.({ ...updatedItem, status: 'done' }, result);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      try {
        await setItemStatus(siteId, item.id, 'error', relayUrl, error.message);
      } catch {
        // Best-effort
      }
      this.config.onError?.(error);
    }

    // Final refresh
    try {
      const finalItems = await getQueueItems(siteId, relayUrl);
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
