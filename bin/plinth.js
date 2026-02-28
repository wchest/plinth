#!/usr/bin/env node
'use strict';

const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  cyan:   '\x1b[36m',
  yellow: '\x1b[33m',
};

function usage() {
  console.log(`
${c.bold}plinth${c.reset} — Webflow page builder

${c.bold}Usage:${c.reset}
  plinth <command> [options]

${c.bold}Commands:${c.reset}
  ${c.cyan}init${c.reset}          Bootstrap a new project (creates .plinth.json, _Build Queue, registers MCP)
  ${c.cyan}mcp${c.reset}           Start the MCP stdio server ${c.dim}(used by Claude Code)${c.reset}
  ${c.cyan}server${c.reset}        Start the HTTP relay server on localhost:3847
  ${c.cyan}health${c.reset}        Check Webflow connectivity for configured sites
  ${c.cyan}queue list${c.reset}    Show all items in the build queue
  ${c.cyan}queue clear${c.reset}   Remove completed (done/error) items from the queue

${c.bold}Config:${c.reset}
  Reads .plinth.json in the current directory, or set PLINTH_CONFIG=/path/to/config.json
  For multiple sites: create mcp-server/sites.json (see sites.example.json)

${c.bold}Examples:${c.reset}
  ${c.dim}# Set up a new project${c.reset}
  mkdir my-site && cd my-site && plinth init

  ${c.dim}# Check everything is working${c.reset}
  plinth health

  ${c.dim}# See what's in the queue${c.reset}
  plinth queue list
`);
}

const command = process.argv[2];

switch (command) {
  case 'init':
    process.argv.splice(2, 1);
    require('../mcp-server/init.js');
    break;

  case 'mcp':
    process.argv.splice(2, 1);
    require('../mcp-server/mcp.js');
    break;

  case 'server':
    process.argv.splice(2, 1);
    require('../mcp-server/index.js');
    break;

  case 'health':
    require('./commands/health.js');
    break;

  case 'queue':
    require('./commands/queue.js');
    break;

  case undefined:
  case '--help':
  case '-h':
  case 'help':
    usage();
    break;

  default:
    console.error(`${c.yellow}Unknown command: ${command}${c.reset}\n`);
    usage();
    process.exit(1);
}
