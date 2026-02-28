# Webflow Builder (Plinth)

Build complete Webflow pages by generating structured BuildPlan JSON.
Plans are queued in a CMS collection and executed by a Designer Extension.

## Architecture
- Claude generates BuildPlan JSON (see skill/SKILL.md)
- Plans are written to a "_Build Queue" CMS collection on the target site
- A Designer Extension polls the queue and builds elements via Designer API
- Claude Code uses the MCP server tools directly (queue_buildplan, get_queue_status, etc.)

## Key Files
- `skill/SKILL.md` — How to generate valid BuildPlans
- `skill/examples/` — Reference BuildPlan JSONs
- `extension/` — The Webflow Designer Extension (React/TypeScript)
- `mcp-server/mcp.js` — MCP tool server for Claude Code
- `mcp-server/index.js` — HTTP relay (for manual use / curl)

## MCP Tools Available
When the MCP server is registered, these tools are available:
- `queue_buildplan(plan)` — validate + add a BuildPlan to the queue
- `get_queue_status(siteId)` — list all queue items and their status
- `clear_queue(siteId)` — remove done/error items
- `health_check()` — verify Webflow connectivity for all configured sites
- `list_pages(siteId)` — list all pages with id, title, slug (use to get pageId)
- `get_page_dom(siteId, pageId)` — get the full element tree for a page (use before building to avoid duplicates)
- `list_styles(siteId, pageId)` — list all CSS class names used on a page (use before building to avoid name collisions)

**Note**: `get_page_dom` and `list_styles` reflect the *saved/published* state of a page, not unsaved Designer changes.

## BuildPlan Rules
- All CSS must be longhand (padding-top, not padding)
- Every visible element needs a className (kebab-case)
- Text content goes in the `text` field, not in children
- Headings need `headingLevel` (1-6)
- Links/buttons need `href`
- Images need `src` and `alt`
- Max nesting: 6 levels
- One BuildPlan = one section (Section as root element)

## Workflow
1. Read skill/SKILL.md and the relevant design system doc
2. Generate a BuildPlan for one section
3. Call `queue_buildplan` with the plan
4. Check progress with `get_queue_status`
5. Verify the built section in Webflow Designer
6. Iterate — fix any issues and re-queue

## Setting Up for a New Project
See the full walkthrough in the project README. Short version:
1. Get a Webflow site-level API token (Site Settings → Apps & Integrations → API Access)
2. Create a `.plinth.json` in the project directory
3. Register the MCP server: `claude mcp add plinth -s project -e PLINTH_CONFIG=$(pwd)/.plinth.json -- node /path/to/plinth/mcp-server/mcp.js`
4. Create the `_Build Queue` CMS collection (see README for fields)
5. Install the Designer Extension and open it in Webflow

