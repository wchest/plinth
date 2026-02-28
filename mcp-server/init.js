#!/usr/bin/env node
'use strict';

/**
 * plinth init
 *
 * Bootstraps a Webflow project for use with Plinth:
 *   1. Prompts for API token + site ID
 *   2. Verifies credentials against the Webflow API
 *   3. Creates the _Build Queue CMS collection if it doesn't exist
 *   4. Writes .plinth.json to the current directory
 *   5. Adds .plinth.json to .gitignore
 *   6. Registers the MCP server with Claude Code (project-scoped)
 *
 * Usage:
 *   node /path/to/plinth/mcp-server/init.js
 *   node /path/to/plinth/mcp-server/init.js --site 699b... --token xxx
 */

const readline = require('readline');
const fs        = require('fs');
const path      = require('path');
const { execSync } = require('child_process');

const BASE_URL    = 'https://api.webflow.com/v2';
const PLINTH_ROOT = path.join(__dirname);          // mcp-server/
const MCP_ENTRY   = path.join(PLINTH_ROOT, 'mcp.js');
const CWD         = process.cwd();

// ── Colour helpers ────────────────────────────────────────────────────────────
const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
};
const ok   = (s) => `${c.green}✓${c.reset} ${s}`;
const warn = (s) => `${c.yellow}⚠${c.reset}  ${s}`;
const fail = (s) => `${c.red}✗${c.reset} ${s}`;
const bold = (s) => `${c.bold}${s}${c.reset}`;
const dim  = (s) => `${c.dim}${s}${c.reset}`;

// ── CLI argument parsing ──────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--site'  && args[i + 1]) result.siteId   = args[++i];
    if (args[i] === '--token' && args[i + 1]) result.apiToken = args[++i];
    if (args[i] === '--name'  && args[i + 1]) result.name     = args[++i];
  }
  return result;
}

// ── Prompt helpers ────────────────────────────────────────────────────────────
function prompt(rl, question, defaultValue) {
  return new Promise((resolve) => {
    const display = defaultValue
      ? `${question} ${dim(`[${defaultValue}]`)}: `
      : `${question}: `;
    rl.question(display, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

function promptSecret(question) {
  return new Promise((resolve) => {
    process.stdout.write(`${question}: `);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let token = '';
    // Mask input with *
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.removeAllListeners('data');
    process.stdin.on('data', function handler(ch) {
      if (ch === '\n' || ch === '\r' || ch === '\u0004') {
        process.stdin.setRawMode(false);
        process.stdin.removeListener('data', handler);
        process.stdout.write('\n');
        rl.close();
        resolve(token);
      } else if (ch === '\u007f') { // backspace
        if (token.length > 0) {
          token = token.slice(0, -1);
          process.stdout.clearLine(0);
          process.stdout.cursorTo(0);
          process.stdout.write(`${question}: ${'*'.repeat(token.length)}`);
        }
      } else {
        token += ch;
        process.stdout.write('*');
      }
    });
  });
}

// ── Webflow API helpers ───────────────────────────────────────────────────────
async function webflow(method, path_, body, token) {
  const res = await fetch(`${BASE_URL}${path_}`, {
    method,
    headers: {
      Authorization:    `Bearer ${token}`,
      'accept-version': '1.0.0',
      'Content-Type':   'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    let msg = `API error ${res.status}`;
    try { const d = await res.json(); msg = d.message || d.msg || msg; } catch (_) {}
    const e = new Error(msg);
    e.status = res.status;
    throw e;
  }

  return res.status === 204 ? null : res.json();
}

async function getSite(siteId, token) {
  return webflow('GET', `/sites/${siteId}`, null, token);
}

async function listCollections(siteId, token) {
  const data = await webflow('GET', `/sites/${siteId}/collections`, null, token);
  return data.collections || [];
}

async function createBuildQueueCollection(siteId, token) {
  return webflow('POST', `/sites/${siteId}/collections`, {
    displayName:  '_Build Queue',
    singularName: 'Build Queue Item',
    fields: [
      {
        type:        'PlainText',
        displayName: 'Plan',
        isRequired:  false,
        helpText:    'BuildPlan JSON (up to 64 KB)',
      },
      {
        type:        'Option',
        displayName: 'Status',
        isRequired:  false,
        metadata: {
          options: [
            { name: 'pending' },
            { name: 'building' },
            { name: 'done' },
            { name: 'error' },
          ],
        },
      },
      {
        type:        'PlainText',
        displayName: 'Error Message',
        isRequired:  false,
      },
      {
        type:        'Number',
        displayName: 'Order',
        isRequired:  false,
        helpText:    'Build sequence — lower numbers build first',
      },
    ],
  }, token);
}

// ── File helpers ──────────────────────────────────────────────────────────────
function writePlinthJson(siteId, name, token) {
  const configPath = path.join(CWD, '.plinth.json');
  fs.writeFileSync(configPath, JSON.stringify({ siteId, name, apiToken: token }, null, 2) + '\n');
  return configPath;
}

function ensureGitignore() {
  const gitignorePath = path.join(CWD, '.gitignore');
  const entry = '.plinth.json';
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf8');
    if (!content.includes(entry)) {
      fs.appendFileSync(gitignorePath, `\n${entry}\n`);
      return 'added';
    }
    return 'already present';
  } else {
    fs.writeFileSync(gitignorePath, `${entry}\n`);
    return 'created';
  }
}

function resolveMcpCommand() {
  // Prefer `plinth mcp` (clean, portable) if the CLI is installed.
  // Fall back to absolute node path if not (e.g. first run before npm link).
  try {
    execSync('which plinth', { stdio: 'pipe' });
    return 'plinth mcp';
  } catch (_) {
    return `node ${MCP_ENTRY}`;
  }
}

function registerMcpServer(configPath) {
  const mcpCommand = resolveMcpCommand();

  // Remove existing entry first (ignore errors — it may not exist)
  try {
    execSync('claude mcp remove plinth -s project', { stdio: 'pipe' });
  } catch (_) {}

  execSync(
    `claude mcp add plinth -s project -e PLINTH_CONFIG=${configPath} -- ${mcpCommand}`,
    { stdio: 'pipe' }
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${bold('Plinth Init')} ${dim('— Webflow page builder setup')}\n`);

  const args = parseArgs();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // ── 1. Collect inputs ──────────────────────────────────────────────────────

  const siteId = args.siteId || await prompt(rl, 'Site ID', '');
  const name   = args.name   || await prompt(rl, 'Site name (for display)', path.basename(CWD));

  let apiToken = args.apiToken || process.env.WEBFLOW_API_TOKEN;
  if (!apiToken) {
    rl.close(); // Close rl before raw mode
    apiToken = await promptSecret('API token');
  } else {
    rl.close();
    console.log(`API token: ${dim('(from argument/env)')}`);
  }

  if (!siteId || !apiToken) {
    console.error(fail('Site ID and API token are required.'));
    process.exit(1);
  }

  console.log('');

  // ── 2. Verify credentials ──────────────────────────────────────────────────

  process.stdout.write('Verifying credentials… ');
  let site;
  try {
    site = await getSite(siteId, apiToken);
    console.log(ok(site.displayName || site.name || siteId));
  } catch (e) {
    console.log(fail(e.message));
    if (e.status === 401) console.error('  Token may be invalid or missing CMS permissions.');
    if (e.status === 404) console.error('  Site ID not found — check the ID and token scope.');
    process.exit(1);
  }

  // ── 3. Check / create _Build Queue collection ──────────────────────────────

  process.stdout.write('Checking _Build Queue collection… ');
  let collections;
  try {
    collections = await listCollections(siteId, apiToken);
  } catch (e) {
    console.log(fail(e.message));
    process.exit(1);
  }

  const existing = collections.find(
    (c) => c.displayName === '_Build Queue' || c.slug === '-build-queue'
  );

  if (existing) {
    console.log(ok(`exists (${existing.id})`));
  } else {
    console.log(dim('not found'));
    process.stdout.write('Creating _Build Queue collection… ');
    try {
      const created = await createBuildQueueCollection(siteId, apiToken);
      console.log(ok(`created (${created.id})`));
    } catch (e) {
      console.log(fail(e.message));
      if (e.status === 401 || e.status === 403) {
        console.error('  Token needs CMS:write permission (Site Settings → API Access).');
      }
      process.exit(1);
    }
  }

  // ── 4. Write .plinth.json ──────────────────────────────────────────────────

  process.stdout.write('Writing .plinth.json… ');
  const configPath = writePlinthJson(siteId, name, apiToken);
  console.log(ok(configPath));

  // ── 5. Update .gitignore ───────────────────────────────────────────────────

  process.stdout.write('Updating .gitignore… ');
  const gitignoreResult = ensureGitignore();
  console.log(ok(gitignoreResult));

  // ── 6. Register MCP server with Claude Code ────────────────────────────────

  process.stdout.write('Registering MCP server with Claude Code… ');
  try {
    registerMcpServer(configPath);
    console.log(ok('.mcp.json updated'));
  } catch (e) {
    console.log(warn('skipped — claude CLI not found in PATH'));
    console.log(dim(`  Run manually: claude mcp add plinth -s project -e PLINTH_CONFIG=${configPath} -- node ${MCP_ENTRY}`));
  }

  // ── Done ───────────────────────────────────────────────────────────────────

  console.log(`\n${bold('Done!')} Start Claude Code in this directory:\n`);
  console.log(`  ${c.cyan}claude${c.reset}\n`);
  console.log('Available tools:');
  console.log(`  ${dim('queue_buildplan')}   — validate + queue a BuildPlan`);
  console.log(`  ${dim('get_queue_status')}  — list queue items and their status`);
  console.log(`  ${dim('clear_queue')}       — remove done/error items`);
  console.log(`  ${dim('health_check')}      — verify Webflow connectivity`);
  console.log('');
  console.log(`Next steps:`);
  console.log(`  1. Run ${c.cyan}plinth dev${c.reset} to start the relay on localhost:3847`);
  console.log(`  2. Open the Webflow Designer and install the Plinth extension`);
  console.log(`  3. Enter ${c.cyan}http://localhost:3847${c.reset} as the relay URL in the extension\n`);
}

main().catch((e) => {
  console.error(fail(e.message));
  process.exit(1);
});
