'use strict';

const path = require('path');
const fs   = require('fs');
const SiteRegistry = require('../../mcp-server/lib/site-registry');

const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
};

function resolveConfigPath() {
  if (process.env.PLINTH_CONFIG) return path.resolve(process.env.PLINTH_CONFIG);
  const local = path.join(process.cwd(), '.plinth.json');
  if (fs.existsSync(local)) return local;
  const central = path.join(__dirname, '../../mcp-server/sites.json');
  if (fs.existsSync(central)) return central;
  throw new Error('No config found. Run plinth init or create .plinth.json');
}

async function main() {
  let registry;
  try {
    registry = new SiteRegistry(resolveConfigPath());
  } catch (e) {
    console.error(`${c.red}✗${c.reset} ${e.message}`);
    process.exit(1);
  }

  console.log('');

  const sites = registry.summary();
  for (const { siteId, name } of sites) {
    const client = registry.getClient(siteId);

    // API connectivity
    process.stdout.write(`  ${c.bold}${name}${c.reset} — Webflow API… `);
    const result = await client.healthCheck();
    if (result.connected) {
      process.stdout.write(`${c.green}✓${c.reset} connected (${result.siteName || siteId})\n`);
    } else {
      process.stdout.write(`${c.red}✗${c.reset} ${result.error}\n`);
    }

    // Bridge connectivity
    process.stdout.write(`  ${c.bold}${name}${c.reset} — Bridge… `);
    const relayUrl = registry.relayUrl;
    try {
      const reqRes = await fetch(
        `${relayUrl}/bridge/request?siteId=${encodeURIComponent(siteId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'ping', payload: {} }),
        }
      );
      if (!reqRes.ok) {
        process.stdout.write(`${c.yellow}⚠${c.reset}  relay returned ${reqRes.status} (is plinth dev running?)\n`);
        continue;
      }

      // Poll for result (5s timeout)
      const deadline = Date.now() + 5_000;
      let bridgeOk = false;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 1000));
        try {
          const resultRes = await fetch(`${relayUrl}/bridge/result?siteId=${encodeURIComponent(siteId)}`);
          if (resultRes.ok) {
            const data = await resultRes.json();
            if (data.ready && data.ok) {
              bridgeOk = true;
              break;
            }
          }
        } catch { /* keep polling */ }
      }

      if (bridgeOk) {
        process.stdout.write(`${c.green}✓${c.reset} connected\n`);
      } else {
        process.stdout.write(`${c.yellow}⚠${c.reset}  no response (Designer open? Inspector extension installed?)\n`);
      }
    } catch (e) {
      process.stdout.write(`${c.red}✗${c.reset} relay not reachable at ${relayUrl} (run plinth dev)\n`);
    }
  }

  console.log('');
}

main().catch((e) => {
  console.error(`${c.red}✗${c.reset} ${e.message}`);
  process.exit(1);
});
