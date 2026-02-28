import React, { useState, useEffect, useRef, useCallback } from 'react';
import { BuildQueuePoller } from './queue/poller';
import { QueueItem } from './queue/status';
import { discoverConfig, DiscoveredConfig } from './queue/discovery';
import { executeBuildPlan } from './builder/executor';

export type { BuildResult } from './builder/executor';

// ─── Config (persisted) ───────────────────────────────────────────────────────
// Only the relay URL is stored — siteId is auto-discovered from the Designer.

const DEFAULT_RELAY_URL = 'http://localhost:3847';

interface StoredConfig {
  relayUrl: string;
}

const CONFIG_KEY = 'plinth-config';

function loadStoredConfig(): StoredConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredConfig>;
    if (parsed.relayUrl) return parsed as StoredConfig;
    return null;
  } catch {
    return null;
  }
}

function saveStoredConfig(config: StoredConfig): void {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function statusIcon(status: QueueItem['status']): string {
  switch (status) {
    case 'pending':  return '⏳';
    case 'building': return '🔨';
    case 'done':     return '✅';
    case 'error':    return '❌';
    default:         return '❓';
  }
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const s = {
  root: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize: '13px',
    color: '#1a1a1a',
    backgroundColor: '#fff',
    padding: '16px',
    maxWidth: '320px',
    boxSizing: 'border-box' as const,
    lineHeight: '1.4',
  },
  heading: { fontSize: '15px', fontWeight: 700, margin: '0 0 16px 0', color: '#000' },
  section: { marginBottom: '16px' },
  row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' },
  label: { fontWeight: 600, color: '#444' },
  btn: {
    display: 'inline-flex', alignItems: 'center', gap: '4px',
    padding: '5px 10px', fontSize: '12px', fontWeight: 600,
    border: '1px solid #d0d0d0', borderRadius: '4px',
    backgroundColor: '#f5f5f5', cursor: 'pointer', color: '#1a1a1a', lineHeight: '1',
  } as React.CSSProperties,
  btnPrimary: { backgroundColor: '#0057ff', borderColor: '#0057ff', color: '#fff' } as React.CSSProperties,
  queueList: { border: '1px solid #e0e0e0', borderRadius: '6px', overflow: 'hidden', marginBottom: '8px' },
  queueItem: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '7px 10px', borderBottom: '1px solid #f0f0f0', fontSize: '12px',
  } as React.CSSProperties,
  queueItemName: { fontFamily: 'monospace', color: '#333' },
  queueItemStatus: { color: '#666', fontSize: '11px' },
  divider: { border: 'none', borderTop: '1px solid #e8e8e8', margin: '16px 0' },
  metaRow: { display: 'flex', gap: '16px', fontSize: '12px', color: '#555', marginTop: '4px' },
  metaItem: { display: 'flex', flexDirection: 'column' as const, gap: '1px' },
  metaLabel: { fontSize: '10px', textTransform: 'uppercase' as const, letterSpacing: '0.04em', color: '#999', fontWeight: 600 },
  metaValue: { fontWeight: 700, color: '#1a1a1a' },
  textarea: {
    width: '100%', height: '100px', fontSize: '11px', fontFamily: 'monospace',
    border: '1px solid #d0d0d0', borderRadius: '4px', padding: '8px',
    resize: 'vertical' as const, boxSizing: 'border-box' as const, color: '#222',
  },
  errorText: { color: '#c0392b', fontSize: '11px', marginTop: '6px' },
  mutedText: { color: '#999', fontSize: '11px', marginTop: '6px' },
  input: {
    width: '100%', padding: '6px 8px', fontSize: '12px',
    border: '1px solid #d0d0d0', borderRadius: '4px',
    boxSizing: 'border-box' as const, marginBottom: '8px',
  },
  inputLabel: {
    display: 'block', fontSize: '11px', fontWeight: 600, color: '#666',
    marginBottom: '3px', textTransform: 'uppercase' as const, letterSpacing: '0.04em',
  } as React.CSSProperties,
  emptyQueue: { padding: '20px', textAlign: 'center' as const, color: '#aaa', fontSize: '12px' },
  resetLink: {
    background: 'none', border: 'none', padding: 0, fontSize: '11px',
    color: '#aaa', cursor: 'pointer', textDecoration: 'underline',
  } as React.CSSProperties,
};

// ─── Relay URL Form ───────────────────────────────────────────────────────────

function RelayForm({ onSave }: { onSave: (relayUrl: string) => void }) {
  const [url, setUrl] = useState(DEFAULT_RELAY_URL);
  return (
    <div style={s.root}>
      <p style={s.heading}>Plinth Builder — Setup</p>
      <div style={s.section}>
        <label style={s.inputLabel}>Relay Server URL</label>
        <input
          style={s.input}
          type="text"
          placeholder={DEFAULT_RELAY_URL}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          autoFocus
        />
        <p style={{ ...s.mutedText, marginTop: 0, marginBottom: '12px' }}>
          Run <code style={{ fontFamily: 'monospace' }}>plinth server</code> locally first.
          Site ID is auto-discovered from this page.
        </p>
        <button
          style={{ ...s.btn, ...s.btnPrimary, width: '100%', justifyContent: 'center' }}
          onClick={() => { if (url.trim()) onSave(url.trim().replace(/\/$/, '')); }}
          disabled={!url.trim()}
        >
          Connect
        </button>
      </div>
    </div>
  );
}

// ─── Discovering View ────────────────────────────────────────────────────────

function DiscoveringView({ error, onRetry, onReset }: {
  error: string | null;
  onRetry: () => void;
  onReset: () => void;
}) {
  return (
    <div style={s.root}>
      <p style={s.heading}>Plinth Builder</p>
      {error ? (
        <div style={s.section}>
          <div style={s.errorText}>{error}</div>
          <div style={{ marginTop: '10px', display: 'flex', gap: '8px' }}>
            <button style={{ ...s.btn, ...s.btnPrimary }} onClick={onRetry}>Retry</button>
            <button style={s.btn} onClick={onReset}>Change Token</button>
          </div>
        </div>
      ) : (
        <div style={{ ...s.mutedText, marginTop: 0 }}>
          Discovering site and queue collection…
        </div>
      )}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

export default function App() {
  const [storedConfig, setStoredConfig] = useState<StoredConfig | null>(() => loadStoredConfig());
  const [discovered, setDiscovered] = useState<DiscoveredConfig | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);

  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [isPolling, setIsPolling] = useState(false);
  const [lastResult, setLastResult] = useState<import('./builder/executor').BuildResult | null>(null);
  const [lastBuiltName, setLastBuiltName] = useState('');
  const [manualJson, setManualJson] = useState('');
  const [manualError, setManualError] = useState('');
  const [manualBuilding, setManualBuilding] = useState(false);

  const pollerRef = useRef<BuildQueuePoller | null>(null);

  // Run discovery whenever we have a relay URL
  const runDiscovery = useCallback(async (relayUrl: string) => {
    setDiscovering(true);
    setDiscoveryError(null);
    try {
      const result = await discoverConfig(relayUrl);
      setDiscovered(result);
    } catch (err) {
      setDiscoveryError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiscovering(false);
    }
  }, []);

  useEffect(() => {
    if (storedConfig) {
      runDiscovery(storedConfig.relayUrl);
    }
  }, [storedConfig, runDiscovery]);

  // Build / destroy poller when discovered config changes
  useEffect(() => {
    if (!storedConfig || !discovered) return;

    const poller = new BuildQueuePoller({
      siteId: discovered.siteId,
      relayUrl: storedConfig.relayUrl,
      onStatusChange: (items) => setQueueItems(items),
      onBuildComplete: (item, result) => {
        setLastBuiltName(item.name);
        setLastResult(result);
      },
      onError: (err) => console.error('[Plinth] Poller error:', err.message),
    });

    pollerRef.current = poller;
    return () => { poller.stop(); pollerRef.current = null; };
  }, [storedConfig, discovered]);

  // Start/stop poller
  useEffect(() => {
    const poller = pollerRef.current;
    if (!poller) return;
    if (isPolling && !poller.isRunning()) poller.start();
    else if (!isPolling && poller.isRunning()) poller.stop();
  }, [isPolling]);

  const handleSaveToken = useCallback((relayUrl: string) => {
    const config = { relayUrl };
    saveStoredConfig(config);
    setStoredConfig(config);
  }, []);

  const handleReset = useCallback(() => {
    localStorage.removeItem(CONFIG_KEY);
    setStoredConfig(null);
    setDiscovered(null);
    setDiscoveryError(null);
    setQueueItems([]);
    pollerRef.current?.stop();
    pollerRef.current = null;
  }, []);

  const handleBuildNext = useCallback(async () => {
    await pollerRef.current?.processNext();
  }, []);

  const handleManualBuild = useCallback(async () => {
    setManualError('');
    if (!manualJson.trim()) { setManualError('Paste a BuildPlan JSON document first.'); return; }
    let plan: unknown;
    try { plan = JSON.parse(manualJson); }
    catch (err) { setManualError('Invalid JSON: ' + (err instanceof Error ? err.message : String(err))); return; }
    setManualBuilding(true);
    try {
      const result = await executeBuildPlan(plan);
      setLastResult(result);
      setLastBuiltName('(manual)');
      if (result.success) setManualJson('');
      else setManualError(result.error ?? 'Build failed');
    } catch (err) {
      setManualError(err instanceof Error ? err.message : String(err));
    } finally {
      setManualBuilding(false);
    }
  }, [manualJson]);

  // --- Render gates ---

  if (!storedConfig) return <RelayForm onSave={handleSaveToken} />;

  if (discovering || (!discovered && !discoveryError)) {
    return <DiscoveringView error={null} onRetry={() => runDiscovery(storedConfig.relayUrl)} onReset={handleReset} />;
  }

  if (discoveryError) {
    return <DiscoveringView error={discoveryError} onRetry={() => runDiscovery(storedConfig.relayUrl)} onReset={handleReset} />;
  }

  // --- Main UI ---

  return (
    <div style={s.root}>
      <p style={s.heading}>
        Webflow Builder
        {discovered?.siteName && (
          <span style={{ fontWeight: 400, color: '#999', fontSize: '12px', marginLeft: '6px' }}>
            — {discovered.siteName}
          </span>
        )}
      </p>

      {/* Queue */}
      <div style={s.section}>
        <div style={s.row}>
          <span style={s.label}>Queue</span>
          <button style={s.btn} onClick={handleBuildNext} disabled={isPolling}>🔄 Refresh</button>
        </div>
        <div style={s.queueList}>
          {queueItems.length === 0 ? (
            <div style={s.emptyQueue}>Queue is empty</div>
          ) : (
            queueItems.slice().sort((a, b) => a.order - b.order).map((item, idx, arr) => (
              <div
                key={item.id}
                style={{
                  ...s.queueItem,
                  ...(idx === arr.length - 1 ? { borderBottom: 'none' } : {}),
                  backgroundColor: item.status === 'building' ? '#fffbf0' : undefined,
                }}
              >
                <span style={s.queueItemName}>{statusIcon(item.status)} {item.name}</span>
                <span style={s.queueItemStatus}>{item.status}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
        <button style={{ ...s.btn, ...s.btnPrimary }} onClick={handleBuildNext} disabled={isPolling}>
          ▶ Build Next
        </button>
        <button style={s.btn} onClick={() => setIsPolling((p) => !p)}>
          {isPolling ? '⏸ Pause' : '▶ Auto Poll'}
        </button>
      </div>

      {/* Last result */}
      {lastResult && (
        <div style={s.section}>
          <div style={{ fontSize: '12px', color: '#555', marginBottom: '6px' }}>
            Last build: <strong>{lastBuiltName}</strong>
            {!lastResult.success && <span style={{ color: '#c0392b' }}> — failed</span>}
          </div>
          <div style={s.metaRow}>
            <div style={s.metaItem}><span style={s.metaLabel}>Elements</span><span style={s.metaValue}>{lastResult.elementsCreated}</span></div>
            <div style={s.metaItem}><span style={s.metaLabel}>Styles</span><span style={s.metaValue}>{lastResult.stylesCreated}</span></div>
            <div style={s.metaItem}><span style={s.metaLabel}>Time</span><span style={s.metaValue}>{(lastResult.elapsedMs / 1000).toFixed(1)}s</span></div>
          </div>
          {lastResult.error && <div style={s.errorText}>{lastResult.error}</div>}
        </div>
      )}

      <hr style={s.divider} />

      {/* Manual build */}
      <div style={s.section}>
        <div style={{ ...s.label, marginBottom: '8px' }}>Manual Build</div>
        <textarea
          style={s.textarea}
          placeholder="Paste BuildPlan JSON here…"
          value={manualJson}
          onChange={(e) => setManualJson(e.target.value)}
          spellCheck={false}
        />
        <button
          style={{ ...s.btn, ...s.btnPrimary, marginTop: '6px', opacity: manualBuilding ? 0.6 : 1 }}
          onClick={handleManualBuild}
          disabled={manualBuilding}
        >
          {manualBuilding ? '⏳ Building…' : '▶ Build from JSON'}
        </button>
        {manualError && <div style={s.errorText}>{manualError}</div>}
      </div>

      {/* Footer */}
      <div style={{ marginTop: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '10px', color: '#ccc' }}>{storedConfig?.relayUrl}</span>
        <button style={s.resetLink} onClick={handleReset}>Change relay URL</button>
      </div>
    </div>
  );
}
