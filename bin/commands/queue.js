'use strict';

const path = require('path');
const fs   = require('fs');
const SiteRegistry = require('../../mcp-server/lib/site-registry');

const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
};

const STATUS_ICON = {
  pending:  `${c.dim}⏳${c.reset}`,
  building: `${c.yellow}🔨${c.reset}`,
  done:     `${c.green}✅${c.reset}`,
  error:    `${c.red}❌${c.reset}`,
};

function resolveConfigPath() {
  if (process.env.PLINTH_CONFIG) return path.resolve(process.env.PLINTH_CONFIG);
  const local = path.join(process.cwd(), '.plinth.json');
  if (fs.existsSync(local)) return local;
  const central = path.join(__dirname, '../../mcp-server/sites.json');
  if (fs.existsSync(central)) return central;
  throw new Error('No config found. Run plinth init or create .plinth.json');
}

async function cmdList(registry) {
  const sites = registry.summary();
  console.log('');

  for (const { siteId, name } of sites) {
    const client = registry.getClient(siteId);

    let items;
    try {
      items = await client.getQueueItems();
    } catch (e) {
      console.error(`  ${c.red}✗${c.reset} ${name}: ${e.message}`);
      continue;
    }

    console.log(`  ${c.bold}${name}${c.reset} ${c.dim}(${siteId})${c.reset}`);

    if (items.length === 0) {
      console.log(`    ${c.dim}Queue is empty${c.reset}`);
    } else {
      items
        .sort((a, b) => a.order - b.order)
        .forEach((item) => {
          const icon   = STATUS_ICON[item.status] || '❓';
          const order  = String(item.order).padStart(2);
          const name_  = item.name.padEnd(20);
          const status = item.status.padEnd(10);
          const err    = item.errorMessage ? ` ${c.red}— ${item.errorMessage}${c.reset}` : '';
          console.log(`    ${icon}  ${c.dim}${order}.${c.reset} ${name_} ${c.dim}${status}${c.reset}${err}`);
        });
    }
    console.log('');
  }
}

async function cmdClear(registry) {
  const sites = registry.summary();
  console.log('');

  for (const { siteId, name } of sites) {
    const client = registry.getClient(siteId);

    let items;
    try {
      items = await client.getQueueItems();
    } catch (e) {
      console.error(`  ${c.red}✗${c.reset} ${name}: ${e.message}`);
      continue;
    }

    const clearable = items.filter((i) => i.status === 'done' || i.status === 'error');

    if (clearable.length === 0) {
      console.log(`  ${name}: ${c.dim}nothing to clear${c.reset}`);
      continue;
    }

    const results = await Promise.allSettled(clearable.map((i) => client.deleteItem(i.id)));
    const cleared = results.filter((r) => r.status === 'fulfilled').length;
    const failed  = results.length - cleared;

    const msg = failed > 0
      ? `${c.green}✓${c.reset} cleared ${cleared}, ${c.red}✗${c.reset} failed ${failed}`
      : `${c.green}✓${c.reset} cleared ${cleared} item${cleared !== 1 ? 's' : ''}`;

    console.log(`  ${c.bold}${name}${c.reset}: ${msg}`);
  }

  console.log('');
}

async function main() {
  const subcommand = process.argv[3];

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(`\nUsage: plinth queue <list|clear>\n`);
    return;
  }

  let registry;
  try {
    registry = new SiteRegistry(resolveConfigPath());
  } catch (e) {
    console.error(`${c.red}✗${c.reset} ${e.message}`);
    process.exit(1);
  }

  // Discover queue collections silently
  await registry.discoverAll();

  switch (subcommand) {
    case 'list':
      await cmdList(registry);
      break;
    case 'clear':
      await cmdClear(registry);
      break;
    default:
      console.error(`${c.yellow}Unknown queue subcommand: ${subcommand}${c.reset}`);
      console.error('Usage: plinth queue <list|clear>');
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`${c.red}✗${c.reset} ${e.message}`);
  process.exit(1);
});
