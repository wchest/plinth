#!/usr/bin/env node
'use strict';

/**
 * plinth init
 *
 * Bootstraps a Webflow project for use with Plinth:
 *   1. Prompts for API token + site ID
 *   2. Verifies credentials against the Webflow API
 *   3. Writes .plinth.json to the current directory
 *   4. Adds .plinth.json to .gitignore
 *   5. Registers the MCP server with Claude Code (project-scoped)
 *   6. Writes CLAUDE.md so Claude Code knows how to use Plinth in this project
 *   7. Writes .claude/skills/plinth/SKILL.md (Claude Code skill for section building)
 *
 * Usage:
 *   plinth init
 *   plinth init --site 699b... --token xxx
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

// ── Scaffold helpers ──────────────────────────────────────────────────────────

const SKILL_SRC = path.join(__dirname, '..', 'skill', 'SKILL.md');

/**
 * Generate the CLAUDE.md content for a project directory.
 * This is what Claude Code reads automatically when opened in the project.
 */
function generateClaudeMd(siteId, name) {
  return `# ${name} — Webflow Builder

Build Webflow pages by generating SectionSpec trees and pasting them via XscpData.
The content script bridge handles variable resolution, style reuse, and atomic paste.

## Site
- **Name**: ${name}
- **Site ID**: \`${siteId}\`
- **MCP relay**: \`localhost:3847\`

## Architecture
- Claude generates SectionSpec trees with inline CSS strings
- The content script bridge converts them to XscpData and pastes atomically (~50ms per section)
- Variable references (\`$Variable Name\`) are resolved to Webflow variable UUIDs automatically
- Existing styles are reused by name (no duplicates)
- No Designer Extension needed — only the Plinth Inspector Chrome extension

## MCP Tools Available
When Claude Code is open in this directory, these tools are registered:

### Build & Verify
- \`build_section(siteId, tree, insertAfterSectionClass?, ...)\` — build a section via XscpData paste
- \`get_snapshot(siteId)\` — structural DOM snapshot (types, IDs, classes, text)
- \`take_screenshot(siteId, sectionClass?)\` — publish to staging + screenshot
- \`delete_elements(siteId, elementIds[])\` — delete elements by ID

### Style & Content
- \`update_styles(siteId, styles[])\` — update CSS on existing named styles
- \`list_variables(siteId)\` — list all style variables
- \`create_variables(siteId, variables[])\` — create new style variables

### Page Management
- \`list_pages(siteId)\` — list pages with id, title, slug
- \`create_page(siteId, name)\` — create a new page
- \`update_page(siteId, pageId, ...)\` — update page settings/SEO
- \`switch_page(siteId, pageId)\` — navigate Designer to a page
- \`get_page_dom(siteId, pageId)\` — content nodes via Data API (no bridge needed)
- \`list_styles(siteId, pageId)\` — CSS class names via Data API

### CMS Binding
- \`connect_collection(siteId, elementId, collectionId)\` — connect Collection List to CMS
- \`bind_field(siteId, elementId, fieldSlug)\` — bind CMS field to element

### Advanced
- \`ping(siteId)\` — check bridge connectivity
- \`probe(siteId, expr)\` — evaluate JS in Designer context
- \`execute(siteId, namespace, method, args?)\` — call _webflow.creators action
- \`capture_xscp(siteId, elementId)\` — capture element's XscpData for replay
- \`paste_xscp(siteId, xscpData, targetElementId)\` — raw XscpData paste
- \`copy_to_webflow(payload)\` — copy XscpData to system clipboard

## Workflow
1. Orient: \`get_snapshot(siteId)\` to see what's on canvas
2. Prepare variables: \`list_variables\` / \`create_variables\` for design tokens
3. Build one section: \`build_section(siteId, tree)\`
4. Verify: \`get_snapshot\` (structure) + \`take_screenshot\` (visual)
5. Fix issues before proceeding
6. Set \`insertAfterSectionClass\` to the just-built section's class for the next section
7. Repeat from step 3

**Never proceed to the next section without completing both verification steps.**

**Editing existing sections**:
- Small tweaks (1–5 properties): \`update_styles\` — supports \`breakpoint\` field for responsive
- Large changes: \`delete_elements\` + \`build_section\` with \`responsive\` fields (atomic, no bleed)
- Keep \`update_styles\` batches to 5–10 entries max

## SectionSpec Format
Each node: \`{ type, className, styles: "CSS string", text?, headingLevel?, children: [...] }\`
- Shorthand CSS allowed
- Variable references: \`$Variable Name\` → resolved automatically
- Font families: \`@raw<|'Instrument Serif', Georgia, serif|>\`
- See the \`plinth\` skill for full reference

## Publishing
REST API publish does NOT reliably update the live site. Use the manual **Publish** button
in the Webflow Designer for production deploys. \`take_screenshot\` uses staging publish
which works for verification.

## Font Workaround
Webflow strips \`font-family\` from XscpData paste. To apply custom fonts:
1. Add fonts in Webflow Designer (Typography panel or Site Settings → Fonts)
2. Use a CodeEmbed element with a \`<style>\` tag to apply font-family to classes
`;
}

/**
 * Write CLAUDE.md to the project directory.
 * - If none exists: write it.
 * - If one exists but has no plinth content: append a plinth section.
 * - If one exists and already has plinth content: skip (idempotent).
 */
function writeClaudeMd(siteId, name) {
  const dest = path.join(CWD, 'CLAUDE.md');
  const content = generateClaudeMd(siteId, name);

  if (!fs.existsSync(dest)) {
    fs.writeFileSync(dest, content);
    return 'written';
  }

  const existing = fs.readFileSync(dest, 'utf8');
  if (existing.includes('build_section') || existing.includes('SectionSpec')) {
    return 'already contains plinth config — skipped';
  }

  fs.appendFileSync(dest, '\n---\n\n' + content);
  return 'appended to existing CLAUDE.md';
}

/**
 * Symlink the Plinth skill reference into .claude/skills/plinth/SKILL.md.
 * Claude auto-discovers it and loads it whenever the task involves building
 * Webflow pages with Plinth. Uses a symlink so upgrading plinth automatically
 * updates the skill in every project.
 */
function writeClaudeSkill() {
  if (!fs.existsSync(SKILL_SRC)) return 'source not found — skipped';

  const skillDir = path.join(CWD, '.claude', 'skills', 'plinth');
  const dest     = path.join(skillDir, 'SKILL.md');

  if (!fs.existsSync(skillDir)) {
    fs.mkdirSync(skillDir, { recursive: true });
  }

  // Remove existing file or broken symlink before creating new one
  try { fs.unlinkSync(dest); } catch (e) { /* doesn't exist yet */ }

  fs.symlinkSync(SKILL_SRC, dest);
  return dest;
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
    if (e.status === 401) console.error('  Token may be invalid or missing permissions.');
    if (e.status === 404) console.error('  Site ID not found — check the ID and token scope.');
    process.exit(1);
  }

  // ── 3. Write .plinth.json ──────────────────────────────────────────────────

  process.stdout.write('Writing .plinth.json… ');
  const configPath = writePlinthJson(siteId, name, apiToken);
  console.log(ok(configPath));

  // ── 4. Update .gitignore ───────────────────────────────────────────────────

  process.stdout.write('Updating .gitignore… ');
  const gitignoreResult = ensureGitignore();
  console.log(ok(gitignoreResult));

  // ── 5. Register MCP server with Claude Code ────────────────────────────────

  process.stdout.write('Registering MCP server with Claude Code… ');
  try {
    registerMcpServer(configPath);
    console.log(ok('.mcp.json updated'));
  } catch (e) {
    console.log(warn('skipped — claude CLI not found in PATH'));
    console.log(dim(`  Run manually: claude mcp add plinth -s project -e PLINTH_CONFIG=${configPath} -- node ${MCP_ENTRY}`));
  }

  // ── 6. Write CLAUDE.md ─────────────────────────────────────────────────────

  process.stdout.write('Writing CLAUDE.md… ');
  try {
    const claudeResult = writeClaudeMd(siteId, name);
    console.log(ok(claudeResult));
  } catch (e) {
    console.log(warn(`skipped — ${e.message}`));
  }

  // ── 7. Write .claude/skills/plinth/SKILL.md ───────────────────────────────

  process.stdout.write('Writing Claude Code skill… ');
  try {
    const skillDest = writeClaudeSkill();
    console.log(ok(skillDest));
  } catch (e) {
    console.log(warn(`skipped — ${e.message}`));
  }

  // ── Done ───────────────────────────────────────────────────────────────────

  console.log(`\n${bold('Done!')} Next steps:\n`);
  console.log(`  1. Start the relay:         ${c.cyan}plinth dev${c.reset}`);
  console.log(`  2. Install Inspector ext:   Load unpacked from ${c.dim}plinth/inspector/${c.reset} at ${c.cyan}chrome://extensions${c.reset}`);
  console.log(`  3. Open Webflow Designer`);
  console.log(`  4. Start Claude Code:       ${c.cyan}claude${c.reset}`);
  console.log('');
  console.log(`${dim('Concurrent builds: Run separate Claude Code sessions in separate project dirs.')}`);
  console.log(`${dim('Each routes by siteId — they can share one relay on localhost:3847.')}`);
  console.log('');
}

main().catch((e) => {
  console.error(fail(e.message));
  process.exit(1);
});
