# Plinth — Webflow Page Builder

A queue-based Webflow page building system. Claude generates structured **BuildPlan JSON** describing one section at a time, queues it in a Webflow CMS collection, and a custom Designer Extension polls that queue and materializes the elements on the canvas.

## Why

Direct MCP-to-Designer connections are fragile (tab-focus-dependent, timeout-prone). This system decouples generation from execution: Claude produces a complete section description as JSON, which persists in CMS until the extension processes it.

## Components

| Component | Path | Purpose |
|-----------|------|---------|
| BuildPlan Schema | `skill/schemas/buildplan.schema.json` | Validates generated plans |
| Skill Instructions | `skill/SKILL.md` | Claude's rules for generating BuildPlans |
| Example Plans | `skill/examples/` | Reference BuildPlan JSONs |
| Designer Extension | `extension/` | React app that reads queue + builds elements |
| MCP Relay | `mcp-server/` | Local relay on `localhost:3847` for Claude Code |

## Quick Start

```bash
# 1. Install globally (once)
npm install -g plinth

# 2. Set up a project
cd my-webflow-project
plinth init          # prompts for site ID + API token, creates .plinth.json,
                     # sets up _Build Queue CMS collection, registers MCP

# 3. Start the relay (leave running)
plinth dev

# 4. Open Claude Code in the same folder (separate terminal)
claude
```

The Plinth MCP tools (`queue_buildplan`, `get_queue_status`, etc.) are available automatically in Claude Code because `plinth init` registers them project-scoped via `.mcp.json`.

### Designer Extension setup (one-time per Webflow workspace)

1. **Create an app** in Webflow Dashboard → Workspace Settings → Apps & Integrations → Develop → New App
   Enable: **Designer Extension** + **Data client** (CMS read/write, Pages, Assets, Publish)

2. **Authenticate the Webflow CLI** when prompted on first run:
   ```bash
   cd extension && npm run dev
   ```
   Get a **workspace-level** token from Account Settings → Integrations → API Access.
   _(Separate from the site-level token used by the relay)_

3. **Open your site** in Webflow Designer → Apps panel → **Plinth Builder**
   Enter `http://localhost:3847` as the relay URL → Connect.
   The extension connects to the running `plinth dev` relay — no API token needed.

### Production deployment (extension without local dev server)

```bash
cd extension && npm run build
# Produces a .zip via `webflow extension bundle`
# Upload via Webflow Dashboard → your app → Hosting
```

## BuildPlan Format

```json
{
  "version": "1.0",
  "siteId": "your-site-id",
  "sectionName": "hero",
  "order": 1,
  "styles": [...],
  "tree": {
    "type": "Section",
    "className": "hero-section",
    "children": [...]
  }
}
```

See `skill/SKILL.md` and `skill/schemas/buildplan.schema.json` for full spec.

## Using with claude.ai

No MCP server required. Add `skill/SKILL.md` as a knowledge file in a claude.ai Project, ask Claude to generate BuildPlan JSON, then paste it into the extension's manual input area in Webflow Designer.
