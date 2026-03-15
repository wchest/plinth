'use strict';

const fs   = require('fs');
const path = require('path');

const BASE_URL = 'https://api.webflow.com/v2';

// -- Webflow API helper -------------------------------------------------------
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

// -- Platform init interface --------------------------------------------------

async function collectCredentials(rl, args, ui) {
  const siteId = args.siteId || await ui.prompt(rl, 'Site ID', '');
  const name   = args.name   || await ui.prompt(rl, 'Site name (for display)', path.basename(process.cwd()));

  let apiToken = args.apiToken || process.env.WEBFLOW_API_TOKEN;
  if (!apiToken) {
    rl.close();
    apiToken = await ui.promptSecret('API token');
  } else {
    console.log(`API token: ${ui.dim('(from argument/env)')}`);
  }

  if (!siteId || !apiToken) {
    console.error(ui.fail('Site ID and API token are required.'));
    process.exit(1);
  }

  return { siteId, name, apiToken };
}

async function validateCredentials(config) {
  const { siteId, apiToken } = config;
  try {
    const site = await webflow('GET', `/sites/${siteId}`, null, apiToken);
    return site.displayName || site.name || siteId;
  } catch (e) {
    if (e.status === 401) throw new Error(`${e.message} — token may be invalid or missing permissions.`);
    if (e.status === 404) throw new Error(`${e.message} — site ID not found. Check the ID and token scope.`);
    throw e;
  }
}

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

async function writeProjectFiles(config, cwd, ui) {
  const { siteId, name } = config;

  // Write CLAUDE.md
  process.stdout.write('Writing CLAUDE.md… ');
  try {
    const dest = path.join(cwd, 'CLAUDE.md');
    const content = generateClaudeMd(siteId, name);

    if (!fs.existsSync(dest)) {
      fs.writeFileSync(dest, content);
      console.log(ui.ok('written'));
    } else {
      const existing = fs.readFileSync(dest, 'utf8');
      if (existing.includes('build_section') || existing.includes('SectionSpec')) {
        console.log(ui.ok('already contains plinth config — skipped'));
      } else {
        fs.appendFileSync(dest, '\n---\n\n' + content);
        console.log(ui.ok('appended to existing CLAUDE.md'));
      }
    }
  } catch (e) {
    console.log(ui.warn(`skipped — ${e.message}`));
  }

  // Write skill
  process.stdout.write('Writing Claude Code skill… ');
  try {
    const skillSrc = path.join(__dirname, 'skill', 'SKILL.md');
    if (!fs.existsSync(skillSrc)) {
      console.log(ui.warn('source not found — skipped'));
    } else {
      const skillDir = path.join(cwd, '.claude', 'skills', 'plinth');
      const dest     = path.join(skillDir, 'SKILL.md');

      if (!fs.existsSync(skillDir)) {
        fs.mkdirSync(skillDir, { recursive: true });
      }

      try { fs.unlinkSync(dest); } catch (e) { /* doesn't exist yet */ }
      fs.symlinkSync(skillSrc, dest);
      console.log(ui.ok(dest));
    }
  } catch (e) {
    console.log(ui.warn(`skipped — ${e.message}`));
  }
}

function nextSteps(config) {
  const c = {
    reset:  '\x1b[0m',
    dim:    '\x1b[2m',
    cyan:   '\x1b[36m',
  };
  return [
    `1. Start the relay:         ${c.cyan}plinth dev${c.reset}`,
    `2. Install Inspector ext:   Load unpacked from ${c.dim}plinth/inspector/${c.reset} at ${c.cyan}chrome://extensions${c.reset}`,
    `3. Open Webflow Designer`,
    `4. Start Claude Code:       ${c.cyan}claude${c.reset}`,
    '',
    `${c.dim}Concurrent builds: Run separate Claude Code sessions in separate project dirs.${c.reset}`,
    `${c.dim}Each routes by siteId — they can share one relay on localhost:3847.${c.reset}`,
  ];
}

module.exports = { collectCredentials, validateCredentials, writeProjectFiles, nextSteps };
