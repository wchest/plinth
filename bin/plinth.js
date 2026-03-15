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
${c.bold}plinth${c.reset} — multi-platform page builder

${c.bold}Usage:${c.reset}
  plinth <command> [options]

${c.bold}Commands:${c.reset}
  ${c.cyan}init${c.reset}          Bootstrap a new project (creates .plinth.json, registers MCP)
  ${c.cyan}mcp${c.reset}           Start the MCP stdio server ${c.dim}(used by Claude Code)${c.reset}
  ${c.cyan}dev${c.reset}           Start the relay server on localhost:3847
  ${c.cyan}health${c.reset}        Check API + bridge connectivity

${c.bold}Config:${c.reset}
  Reads .plinth.json in the current directory, or set PLINTH_CONFIG=/path/to/config.json

${c.bold}Examples:${c.reset}
  ${c.dim}# Set up a new project${c.reset}
  mkdir my-site && cd my-site && plinth init

  ${c.dim}# Set up with a specific platform${c.reset}
  plinth init --platform wix

  ${c.dim}# Start the relay (leave running)${c.reset}
  plinth dev

  ${c.dim}# Check everything is working${c.reset}
  plinth health
`);
}

const command = process.argv[2];

switch (command) {
  case 'init':
    process.argv.splice(2, 1);
    require('../core/init-base.js');
    break;

  case 'mcp':
    process.argv.splice(2, 1);
    require('../core/mcp-base.js');
    break;

  case 'dev':
  case 'server': // alias
    process.argv.splice(2, 1);
    require('../core/relay.js');
    break;

  case 'health':
    require('./commands/health.js');
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
