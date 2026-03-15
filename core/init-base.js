#!/usr/bin/env node
'use strict';

/**
 * plinth init — multi-platform bootstrap.
 *
 * 1. Prompts for platform selection
 * 2. Delegates to platforms/<platform>/init.js for credential collection & validation
 * 3. Writes .plinth.json
 * 4. Adds .plinth.json to .gitignore
 * 5. Registers the MCP server with Claude Code
 * 6. Delegates CLAUDE.md and skill writing to the platform init
 */

const readline = require('readline');
const fs        = require('fs');
const path      = require('path');
const { execSync } = require('child_process');

const CWD = process.cwd();

// -- Colour helpers -----------------------------------------------------------
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

// -- CLI argument parsing -----------------------------------------------------
function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--platform' && args[i + 1]) result.platform = args[++i];
    if (args[i] === '--site'     && args[i + 1]) result.siteId   = args[++i];
    if (args[i] === '--token'    && args[i + 1]) result.apiToken = args[++i];
    if (args[i] === '--name'     && args[i + 1]) result.name     = args[++i];
  }
  return result;
}

// -- Prompt helpers -----------------------------------------------------------
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
      } else if (ch === '\u007f') {
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

// -- File helpers -------------------------------------------------------------
function writePlinthJson(config) {
  const configPath = path.join(CWD, '.plinth.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
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
  try {
    execSync('which plinth', { stdio: 'pipe' });
    return 'plinth mcp';
  } catch (_) {
    const mcpEntry = path.join(__dirname, 'mcp-base.js');
    return `node ${mcpEntry}`;
  }
}

function registerMcpServer(configPath) {
  const mcpCommand = resolveMcpCommand();

  try {
    execSync('claude mcp remove plinth -s project', { stdio: 'pipe' });
  } catch (_) {}

  execSync(
    `claude mcp add plinth -s project -e PLINTH_CONFIG=${configPath} -- ${mcpCommand}`,
    { stdio: 'pipe' }
  );
}

// -- Platform discovery -------------------------------------------------------
function availablePlatforms() {
  const platformsDir = path.join(__dirname, '..', 'platforms');
  try {
    return fs.readdirSync(platformsDir).filter(d => {
      const initPath = path.join(platformsDir, d, 'init.js');
      return fs.existsSync(initPath);
    });
  } catch (_) {
    return [];
  }
}

// -- Main ---------------------------------------------------------------------
async function main() {
  console.log(`\n${bold('Plinth Init')} ${dim('— multi-platform page builder setup')}\n`);

  const args = parseArgs();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // 1. Select platform
  const platforms = availablePlatforms();
  let platformName = args.platform;
  if (!platformName) {
    console.log(`Available platforms: ${platforms.map(p => c.cyan + p + c.reset).join(', ')}`);
    platformName = await prompt(rl, 'Platform', platforms[0] || 'webflow');
  }

  if (!platforms.includes(platformName)) {
    console.error(fail(`Unknown platform: ${platformName}. Available: ${platforms.join(', ')}`));
    process.exit(1);
  }

  // 2. Load platform init module
  const platformInit = require(`../platforms/${platformName}/init`);

  // 3. Collect credentials (platform-specific)
  const config = await platformInit.collectCredentials(rl, args, { prompt, promptSecret, c, ok, warn, fail, bold, dim });

  rl.close();

  // Ensure platform field is set
  config.platform = platformName;

  console.log('');

  // 4. Validate credentials (platform-specific)
  process.stdout.write('Verifying credentials… ');
  try {
    const validationResult = await platformInit.validateCredentials(config);
    console.log(ok(validationResult));
  } catch (e) {
    console.log(fail(e.message));
    process.exit(1);
  }

  // 5. Write .plinth.json
  process.stdout.write('Writing .plinth.json… ');
  const configPath = writePlinthJson(config);
  console.log(ok(configPath));

  // 6. Update .gitignore
  process.stdout.write('Updating .gitignore… ');
  const gitignoreResult = ensureGitignore();
  console.log(ok(gitignoreResult));

  // 7. Register MCP server
  process.stdout.write('Registering MCP server with Claude Code… ');
  try {
    registerMcpServer(configPath);
    console.log(ok('.mcp.json updated'));
  } catch (e) {
    console.log(warn('skipped — claude CLI not found in PATH'));
    console.log(dim(`  Run manually: claude mcp add plinth -s project -e PLINTH_CONFIG=${configPath} -- node ${path.join(__dirname, 'mcp-base.js')}`));
  }

  // 8. Write CLAUDE.md + skill (platform-specific)
  if (platformInit.writeProjectFiles) {
    await platformInit.writeProjectFiles(config, CWD, { ok, warn, dim });
  }

  // 9. Done
  const nextSteps = platformInit.nextSteps ? platformInit.nextSteps(config) : [
    `1. Start the relay:         ${c.cyan}plinth dev${c.reset}`,
    `2. Open the ${platformName} editor`,
    `3. Start Claude Code:       ${c.cyan}claude${c.reset}`,
  ];

  console.log(`\n${bold('Done!')} Next steps:\n`);
  for (const step of nextSteps) {
    console.log(`  ${step}`);
  }
  console.log('');
}

main().catch((e) => {
  console.error(fail(e.message));
  process.exit(1);
});
