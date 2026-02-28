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
cd mcp-server && cp .env.example .env  # add WEBFLOW_API_TOKEN
npm install && npm start

# Start the extension (in separate terminal)
cd extension && npm install && npm run dev
# Then in Webflow: Apps → Add Extension → localhost:1337
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
