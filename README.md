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
| MCP Relay Server | `mcp-server/` | HTTP relay on localhost:3847 for Claude Code |

## Quick Start

```bash
# Start the MCP relay
cd mcp-server && cp .env.example .env  # add your site-level WEBFLOW_API_TOKEN
npm install && npm start

# Start the extension dev server (separate terminal)
cd extension && npm install && npm run dev
```

### Designer Extension setup (one-time)

1. **Create an app** in Webflow Dashboard → Workspace Settings → Apps & Integrations → Develop → New App
   Enable: **Designer Extension** + **Data client** (CMS read/write, Pages, Assets, Publish)

2. **Authenticate the Webflow CLI** when prompted on first `npm run dev`
   Get a **workspace-level** token from Account Settings → Integrations → API Access
   _(This is separate from the site-level token used by the MCP relay)_

3. **Open your site** in Webflow Designer → Apps panel → **Plinth Builder**
   The extension loads automatically from `localhost:1337` while the dev server is running

### Production deployment

To run the extension without a local dev server:

```bash
cd extension && npm run build
# Runs webpack + `webflow extension bundle`, producing a .zip
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
