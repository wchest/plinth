# Plinth — Multi-Platform Page Builder

Build complete pages by generating SectionSpec trees with inline CSS.
Platform-specific content script bridges convert them to native formats and paste atomically.

## Architecture
- `core/` — shared kernel (relay, MCP scaffold, site registry, helpers)
- `platforms/<name>/` — platform-specific code (client, tools, init, inspector, skill)
- `bin/plinth.js` — CLI entry point
- `mcp-server/` — backward-compatible shims (point to core/)

### Supported Platforms
- **webflow** — full support (XscpData paste via _webflow.creators)
- **wix** — experimental stub (editor automation TBD)

### How It Works
1. Claude generates SectionSpec trees (platform-agnostic JSON)
2. MCP tools send them to the relay (localhost:3847)
3. Platform-specific Chrome extension content scripts handle the bridge:
   - content-bridge.js (MAIN world): builds native paste format, resolves variables, pastes
   - content-isolated.js (ISOLATED world): polls relay, relays results
4. Config determines which platform's tools are loaded (`platform` field in .plinth.json)

## Key Files
- `core/mcp-base.js` — MCP tool server (loads platform tools dynamically)
- `core/relay.js` — HTTP relay (localhost:3847)
- `core/site-registry.js` — platform-aware config loader
- `core/init-base.js` — multi-platform init flow
- `platforms/webflow/tools.js` — Webflow MCP tool definitions
- `platforms/webflow/client.js` — Webflow API v2 wrapper
- `platforms/webflow/inspector/` — Chrome extension for Webflow Designer
- `platforms/webflow/skill/SKILL.md` — SectionSpec format reference
- `platforms/wix/` — Wix platform stub

## MCP Tools Available (Webflow)
When the MCP server is registered with a Webflow site, these tools are available:

### Build & Verify
- `build_section(siteId, tree, ...)` — build a section via XscpData paste (primary build tool)
- `get_snapshot(siteId)` — structural DOM snapshot (types, IDs, classes, text)
- `take_screenshot(siteId, sectionClass?)` — publish to staging + screenshot
- `delete_elements(siteId, elementIds[])` — delete elements by ID

### Style & Variables
- `update_styles(siteId, styles[])` — update CSS on existing named styles
- `list_variables(siteId)` — list all style variables
- `create_variables(siteId, variables[])` — create new style variables

### Page Management
- `list_pages(siteId)` — list pages with id, title, slug
- `create_page(siteId, name, ...)` — create a new page
- `update_page(siteId, pageId, ...)` — update page settings/SEO
- `switch_page(siteId, pageId)` — navigate Designer to a page
- `get_page_dom(siteId, pageId)` — content nodes via Data API (no bridge needed)
- `list_styles(siteId, pageId)` — CSS class names via Data API

### CMS Binding
- `connect_collection(siteId, elementId, collectionId)` — connect Collection List to CMS
- `bind_field(siteId, elementId, fieldSlug)` — bind CMS field to element

### Advanced
- `ping(siteId)` — check bridge connectivity
- `probe(siteId, expr)` — evaluate JS in Designer context
- `execute(siteId, namespace, method, args?)` — call _webflow.creators action
- `capture_xscp(siteId, elementId)` — capture element's XscpData for replay
- `paste_xscp(siteId, xscpData, targetElementId)` — raw XscpData paste
- `copy_to_webflow(payload)` — copy XscpData to system clipboard

`get_page_dom` and `list_styles` use the Webflow Data API (always work).
All other tools require the Inspector Chrome extension and Webflow Designer open.

## SectionSpec Rules
- Each node: `{ type, className, styles: "CSS string", text?, headingLevel?, children: [...] }`
- CSS must be longhand (`padding-top`, not `padding`)
- Every visible element needs a `className` (kebab-case)
- Text content goes in `text`, not in children
- Headings need `headingLevel` (1-6), Links/Buttons need `href`, Images need `src` + `alt`
- Max nesting: 6 levels
- One `build_section` call = one Section as root
- Variable references: `$Variable Name` → resolved automatically
- Font families: `@raw<|'Instrument Serif', Georgia, serif|>`
- Use `insertAfterSectionClass` to position after an existing section

## Workflow
1. Orient: `get_snapshot` to see what's on canvas
2. Prepare: `list_variables` / `create_variables` for design tokens
3. Build one section: `build_section(siteId, tree)`
4. **Verify — mandatory, no skipping:**
   - `get_snapshot` — confirm section exists, structure correct
   - `take_screenshot(siteId, sectionClass="…")` — visual check
5. Set `insertAfterSectionClass` to the just-built section's class for the next section
6. Repeat from step 3

**Never proceed to the next section without completing both verification steps.**

**Editing existing sections**:
- Small tweaks (1–5 properties): `update_styles` — supports `breakpoint` field for responsive changes
- Large changes or responsive overhauls: `delete_elements` + `build_section` with `responsive` fields (atomic, no bleed risk)
- Keep `update_styles` batches to 5–10 entries max to avoid style bleed

## Setting Up for a New Project
1. Run `plinth init` in the project directory (select platform: webflow, wix, etc.)
2. For Webflow: get a site-level API token (Site Settings → Apps & Integrations → API Access)
3. Install the platform's Inspector Chrome extension (load unpacked from `platforms/<name>/inspector/`)
4. Run `plinth dev` to start the relay
5. Open the platform's editor/designer
6. Start Claude Code in the project directory

## Adding a New Platform
1. Create `platforms/<name>/` with: `client.js`, `tools.js`, `init.js`
2. `client.js` — export a class that accepts a config object (must handle `siteId`)
3. `tools.js` — export `{ registerTools(server, registry, helpers) }` to register MCP tools
4. `init.js` — export `{ collectCredentials, validateCredentials, nextSteps }`
5. Optionally add `inspector/`, `skill/`, `reference/` directories
