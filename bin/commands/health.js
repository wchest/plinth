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

  // Discover collections + run health checks in parallel per site
  const sites = registry.summary();
  for (const { siteId, name } of sites) {
    const client = registry.getClient(siteId);

    // Discover queue collection
    process.stdout.write(`  ${c.bold}${name}${c.reset} — discovering queue… `);
    try {
      const colId = await client.discoverQueueCollection();
      process.stdout.write(`${c.green}✓${c.reset} ${c.dim}${colId}${c.reset}\n`);
    } catch (e) {
      process.stdout.write(`${c.yellow}⚠${c.reset}  ${e.message}\n`);
    }

    // API connectivity
    process.stdout.write(`  ${c.bold}${name}${c.reset} — Webflow API… `);
    const result = await client.healthCheck();
    if (result.connected) {
      process.stdout.write(`${c.green}✓${c.reset} connected (${result.siteName || siteId})\n`);
    } else {
      process.stdout.write(`${c.red}✗${c.reset} ${result.error}\n`);
    }
  }

  console.log('');
}

main().catch((e) => {
  console.error(`${c.red}✗${c.reset} ${e.message}`);
  process.exit(1);
});
