# Plinth — Webflow Page Builder

Build complete Webflow pages from Claude Code. Describe what you want, and Claude generates SectionSpec trees with inline CSS that get pasted atomically into the Webflow Designer (~50ms per section).

No Designer Extension needed — just a Chrome extension and a local relay.

## How It Works

```
Claude Code → MCP tools → Relay (localhost:3847) → Content Script Bridge → Webflow Designer
```

1. Claude generates a **SectionSpec** — a JSON tree describing elements, classes, styles, and text
2. The content script bridge converts it to **XscpData** (Webflow's internal clipboard format)
3. A synthetic paste event injects it into the Designer canvas
4. Variables (`$Forest`, `$Cream`) are resolved to Webflow variable UUIDs automatically
5. Existing styles are reused by name — no duplicates

| Component | Path | Purpose |
|-----------|------|---------|
| MCP Server | `mcp-server/mcp.js` | Claude Code tool definitions (stdio) |
| Relay | `mcp-server/index.js` | HTTP relay on localhost:3847 |
| Inspector Extension | `inspector/` | Chrome extension with content scripts |
| Skill Reference | `skill/SKILL.md` | SectionSpec format, tools, workflow |

The Inspector Chrome extension runs two content scripts:
- **content-bridge.js** (MAIN world): Accesses `_webflow.creators`, builds XscpData, executes paste
- **content-isolated.js** (ISOLATED world): Polls the relay for commands, relays results back

## Prerequisites

- **Node.js** 18+
- **Chrome** (for the Inspector extension)
- **Webflow site-level API token** — Site Settings → Apps & Integrations → API Access → Generate Token (needs read/write on Sites, Pages, CMS, and Assets)
- **Webflow site ID** — visible in the Designer URL: `https://<site-id>.design.webflow.com`

## Quick Start

### 1. Install Plinth

```bash
git clone <repo-url> plinth
cd plinth
npm install
npm link          # makes `plinth` CLI available globally
```

### 2. Install the Chrome Extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `plinth/inspector/` directory
4. The extension icon should appear — no configuration needed

### 3. Set Up a Project

In your project directory (not the plinth source directory):

```bash
cd ~/projects/my-webflow-site
plinth init
```

This will:
- Prompt for your **Site ID** and **API token**
- Verify credentials against the Webflow API
- Create `.plinth.json` (credentials — gitignored automatically)
- Register the MCP server with Claude Code (`.mcp.json`)
- Write `CLAUDE.md` with tool reference and workflow
- Symlink the build skill into `.claude/skills/plinth/SKILL.md`

You can also pass arguments: `plinth init --site 699b... --token xxx`

### 4. Build Pages

```bash
# Terminal 1: start the relay (leave running — works for all projects)
plinth dev

# Terminal 2: open Claude Code in your project directory
cd ~/projects/my-webflow-site
claude
```

Open the Webflow Designer for your site in Chrome. Then tell Claude what to build:

> "Build a hero section with a heading, subheading, and two CTA buttons. Use a dark green background with cream text."

Claude will:
1. Generate a SectionSpec tree
2. Call `build_section` to paste it into the Designer
3. Call `get_snapshot` to verify the structure
4. Call `take_screenshot` to visually confirm
5. Fix any issues before moving to the next section

## Tools

### Build & Verify
| Tool | Description |
|------|-------------|
| `build_section` | Build a section via XscpData paste (primary build tool) |
| `get_snapshot` | Structural DOM snapshot — types, IDs, classes, text |
| `take_screenshot` | Publish to staging + screenshot for visual verification |
| `delete_elements` | Delete elements by ID (from get_snapshot) |

### Style & Variables
| Tool | Description |
|------|-------------|
| `update_styles` | Update CSS properties on existing named styles |
| `list_variables` | List all style variables (names, IDs, values, types) |
| `create_variables` | Create new style variables (color, length, font-family, etc.) |

### Page Management
| Tool | Description |
|------|-------------|
| `list_pages` | List pages with id, title, slug |
| `create_page` | Create a new page via UI simulation |
| `update_page` | Update page settings, SEO, OG, custom code |
| `switch_page` | Navigate the Designer to a different page |
| `get_page_dom` | Content nodes via Data API (no bridge needed) |
| `list_styles` | CSS class names via Data API (no bridge needed) |

### CMS Binding
| Tool | Description |
|------|-------------|
| `connect_collection` | Connect a Collection List to a CMS collection |
| `bind_field` | Bind a CMS field to an element |

### Advanced / Debugging
| Tool | Description |
|------|-------------|
| `ping` | Check bridge connectivity |
| `probe` | Evaluate JS in Designer context with `_webflow` access |
| `execute` | Call `_webflow.creators` action directly |
| `capture_xscp` | Capture an element's XscpData for replay |
| `paste_xscp` | Raw XscpData paste |
| `copy_to_webflow` | Copy XscpData to system clipboard for manual Ctrl+V |

See `skill/SKILL.md` for the complete reference: SectionSpec format, CSS rules, responsive breakpoints, variable management, and examples.

## SectionSpec Format (Summary)

```json
{
  "type": "Section",
  "className": "hero-section",
  "styles": "padding-top: 120px; padding-bottom: 120px; background-color: $Forest;",
  "responsive": {
    "medium": "padding-top: 80px; padding-bottom: 80px;",
    "small": "padding-top: 48px; padding-bottom: 48px;"
  },
  "children": [
    {
      "type": "Heading",
      "className": "hero-heading",
      "headingLevel": 1,
      "text": "Welcome",
      "styles": "font-size: 64px; color: $Cream; font-weight: 700;"
    }
  ]
}
```

- **CSS**: longhand only (`padding-top`, not `padding`)
- **Variables**: `$Variable Name` — resolved to Webflow variable UUIDs
- **Fonts**: use a `CodeEmbed` with a `<style>` tag (Webflow strips `font-family` from paste)
- **Responsive**: `medium` (tablet), `small` (mobile landscape), `tiny` (mobile portrait)
- **Element types**: Section, DivBlock, Container, Heading, Paragraph, TextBlock, Link, Button, Image, Grid, HFlex, VFlex, List, ListItem, RichText, CodeEmbed, and more

## Concurrent Builds

Multiple projects can share one relay. Each routes commands by `siteId`:

```
~/projects/site-a/   →  .plinth.json (siteId: "abc...")  →  plinth dev on :3847
~/projects/site-b/   →  .plinth.json (siteId: "def...")  ↗
```

Run separate Claude Code sessions in separate project directories. They all hit the same relay on localhost:3847, and the bridge routes by siteId.

## CLI Commands

```
plinth init      # Bootstrap a new project (credentials, MCP, CLAUDE.md, skill)
plinth dev       # Start the relay server (run from any directory, leave running)
plinth health    # Check API + bridge connectivity
plinth mcp       # Start MCP stdio server (used by Claude Code automatically)
```

## Troubleshooting

**Bridge not connecting**: Make sure the Webflow Designer is open in Chrome and the Inspector extension is loaded. Check `chrome://extensions` for errors. The console should show `[plinth-bridge] ISOLATED content script loaded`.

**Tools not available in Claude Code**: Run `claude` from the project directory where `plinth init` was run (not the plinth source directory). Check that `.mcp.json` exists.

**Relay not running**: Start with `plinth dev` in any terminal. It runs on localhost:3847. Check `/tmp/plinth-relay.log` for output.

**Styles showing " 2" suffix**: A style with that class name already exists. The bridge reuses existing styles automatically — don't worry about duplicates in the SectionSpec.

**Font-family not applying**: Webflow strips `font-family` from XscpData paste. Use a `CodeEmbed` element with a `<style>` tag to apply fonts to classes. Add the font in Webflow's Typography panel first.

**Screenshot fails**: `take_screenshot` uses staging publish. If it fails, check that `puppeteer-core` is installed and Chrome/Chromium is available.

## Publishing

REST API publish does NOT reliably update the live site. Use the manual **Publish** button in the Webflow Designer for production deploys. `take_screenshot` uses staging publish which works for verification.

## Using with claude.ai (no CLI)

No MCP server required. Add `skill/SKILL.md` as a knowledge file in a claude.ai Project, generate SectionSpec JSON, then use `copy_to_webflow` or paste manually into the Designer.
