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
- `get_page_dom(siteId, pageId)` — get all text/content nodes with class names via Data API (always works, no extension needed)
- `list_styles(siteId, pageId)` — list all CSS class names used on a page via Data API
- `get_page_snapshot(siteId)` — get the full structural DOM (sections, containers, all elements) via the Designer Extension (requires extension open + connected)
- `delete_elements(siteId, elementIds[])` — delete elements by ID (IDs from get_page_snapshot)
- `delete_section(siteId, sectionClass)` — delete all Sections with a given class name
- `update_styles(siteId, styles[])` — update CSS properties on existing named styles
- `update_content(siteId, updates[])` — patch text/href/src/alt on elements by class name
- `insert_elements(siteId, nodes[], parentClass?, afterClass?)` — add elements inside or after an existing element

**Note**: `get_page_dom` and `list_styles` use the Webflow Data API and reflect saved content nodes only (no structural elements). All other extension tools require the Designer Extension to be open and connected.

## BuildPlan Rules
- All CSS must be longhand (padding-top, not padding)
- Every visible element needs a className (kebab-case)
- Text content goes in the `text` field, not in children
- Headings need `headingLevel` (1-6)
- Links/buttons need `href`
- Images need `src` and `alt`
- Max nesting: 6 levels
- One BuildPlan = one section (Section as root element)
- Use `insertAfterSectionClass` to place a section after an existing one (by class name — no element ID needed)
- Use `insertAfterElementId` when you need precision (element ID from `get_page_snapshot`)

## Workflow
1. Read skill/SKILL.md and the relevant design system doc
2. Orient: `get_page_snapshot` to see what's on canvas, `get_queue_status` to check for pending items
3. Generate a BuildPlan for **one section at a time**
4. Call `queue_buildplan(plan, wait=true)` — blocks until built, returns errors inline
5. **Verify immediately**: call `get_page_snapshot` — confirm the section exists and structure is correct
6. Use the section's element ID as `insertAfterElementId` for the next section
7. Repeat from step 3

**Editing existing sections**: use `update_styles`, `update_content`, or `replacesSectionClass` in BuildPlan — see skill/SKILL.md for the decision guide.

## Setting Up for a New Project
See the full walkthrough in the project README. Short version:
1. Get a Webflow site-level API token (Site Settings → Apps & Integrations → API Access)
2. Create a `.plinth.json` in the project directory
3. Register the MCP server: `claude mcp add plinth -s project -e PLINTH_CONFIG=$(pwd)/.plinth.json -- node /path/to/plinth/mcp-server/mcp.js`
4. Create the `_Build Queue` CMS collection (see README for fields)
5. Install the Designer Extension and open it in Webflow

