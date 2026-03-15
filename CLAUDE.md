# Webflow Builder (Plinth)

Build complete Webflow pages by generating SectionSpec trees with inline CSS.
A content script bridge converts them to XscpData and pastes atomically into the Designer.

## Architecture
- Claude generates SectionSpec trees (see skill/SKILL.md)
- MCP tools send them to the relay (localhost:3847)
- The Inspector Chrome extension's content scripts handle the bridge:
  - content-bridge.js (MAIN world): builds XscpData, resolves variables, pastes
  - content-isolated.js (ISOLATED world): polls relay, relays results
- No Designer Extension panel needed — only the Inspector Chrome extension

## Key Files
- `skill/SKILL.md` — SectionSpec format, tool reference, workflow
- `inspector/` — Chrome extension (content scripts for bridge)
- `mcp-server/mcp.js` — MCP tool server (stdio, for Claude Code)
- `mcp-server/index.js` — HTTP relay (localhost:3847)

## MCP Tools Available
When the MCP server is registered, these tools are available:

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
1. Get a Webflow site-level API token (Site Settings → Apps & Integrations → API Access)
2. Run `plinth init` in the project directory
3. Install the Inspector Chrome extension (load unpacked from plinth/inspector/)
4. Run `plinth dev` to start the relay
5. Open the Webflow Designer
6. Start Claude Code in the project directory
