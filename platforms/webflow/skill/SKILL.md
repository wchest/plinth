---
name: plinth
description: Build Webflow page sections using SectionSpec trees and plinth MCP tools. Use this skill whenever building or editing a Webflow page with Plinth.
---

# Plinth — SectionSpec Build Reference

Build Webflow page sections by generating SectionSpec trees with inline CSS.
The content script bridge converts them to XscpData, resolves variables, reuses styles, and pastes atomically (~50ms per section).

---

## Tool Reference

### Build & Verify
| Tool | Description |
|------|-------------|
| `build_section(siteId, tree, ...)` | Build a section via XscpData paste. Primary build tool. |
| `get_snapshot(siteId)` | Structural DOM snapshot — types, IDs, classes, text. |
| `take_screenshot(siteId, sectionClass?)` | Publish to staging + screenshot for visual verification. |
| `delete_elements(siteId, elementIds[])` | Delete elements by ID (from get_snapshot). |

### Style & Variables
| Tool | Description |
|------|-------------|
| `update_styles(siteId, styles[])` | Update CSS on existing named styles. Supports `breakpoint` field per entry. |
| `list_variables(siteId)` | List all style variables (names, IDs, values, types). |
| `create_variables(siteId, variables[])` | Create new style variables (color, length, font-family, number, percentage). |

### Page Management
| Tool | Description |
|------|-------------|
| `list_pages(siteId)` | List pages with id, title, slug. |
| `create_page(siteId, name, ...)` | Create a new page via UI simulation. |
| `update_page(siteId, pageId, ...)` | Update page settings, SEO, OG, custom code. |
| `switch_page(siteId, pageId)` | Navigate the Designer to a different page. |
| `get_page_dom(siteId, pageId)` | Content nodes via Data API (no bridge needed). |
| `list_styles(siteId, pageId)` | CSS class names via Data API (no bridge needed). |

### CMS Binding
| Tool | Description |
|------|-------------|
| `connect_collection(siteId, elementId, collectionId)` | Connect a Collection List to a CMS collection. Must call before bind_field. |
| `bind_field(siteId, elementId, fieldSlug, gateway?)` | Bind a CMS field to an element. Gateway: `dynamoPlainTextToListOfElements` (text), `dynamoImageToAttributes` (images), `dynamoLinkToAttributes` (links). |

### Advanced / Debugging
| Tool | Description |
|------|-------------|
| `ping(siteId)` | Check bridge connectivity. |
| `probe(siteId, expr)` | Evaluate JS in Designer context with _webflow access. |
| `execute(siteId, namespace, method, args?)` | Call _webflow.creators action directly. |
| `capture_xscp(siteId, elementId)` | Capture an element's XscpData for replay. |
| `paste_xscp(siteId, xscpData, targetElementId)` | Raw XscpData paste. |
| `copy_to_webflow(payload)` | Copy XscpData to system clipboard for manual Ctrl+V paste. |

---

## Full Page Build Workflow

### Phase 0: Prepare Variables

Before building any sections, ensure all design token variables exist in Webflow.

1. Extract colors, sizes, fonts from the design
2. Run `list_variables` to see what's already defined
3. Run `create_variables` for any missing tokens
4. Variable naming convention: Title Case matching Webflow's UI (e.g. `$Forest`, `$Cream`)

### Phase 1: Clear Canvas

1. `get_snapshot` — get all current elements
2. `delete_elements` — delete all top-level element IDs (direct children of Body)
3. `get_snapshot` — confirm page is empty

### Phase 2: Section-by-Section Build

For EACH section, in order:

```
1. BUILD      → build_section(siteId, tree, insertAfterSectionClass?)
2. SNAPSHOT   → get_snapshot(siteId) — confirm structure, class names, element count
3. SCREENSHOT → take_screenshot(siteId, sectionClass) — visual comparison
4. FIX        → If issues: update_styles / delete + rebuild
5. NEXT       → Set insertAfterSectionClass to this section's class
```

**Never proceed to the next section without completing snapshot + screenshot verification.**

### Phase 3: Post-Build Polish

- Rich text spans (colored words within headings) — manual editing or CMS binding
- Interactions/animations — IX2 data (capture from reference with `capture_xscp`, merge on build)
- Responsive breakpoints — `update_styles` with breakpoint-specific overrides
- Nav/Footer — factory elements, use `capture_xscp` + `paste_xscp` from a template

---

## SectionSpec Format

Each node in the tree:

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
      "styles": "font-size: 64px; color: $Cream; font-weight: 700;",
      "responsive": {
        "medium": "font-size: 48px;",
        "small": "font-size: 32px;"
      }
    }
  ]
}
```

### Element Types

| Type | Notes |
|------|-------|
| Section | Root of every build. One per `build_section` call. |
| DivBlock | Generic div container |
| Container | Same as DivBlock |
| Heading | Needs `headingLevel` (1-6) |
| Paragraph | Block text element |
| TextBlock | Inline/span text element |
| Link | Needs `href`. Add `text` for link text. |
| Button | Link variant with button styling. Needs `href`. |
| Image | Needs `src` and `alt` |
| List | ul element |
| ListItem | li element |
| BlockQuote | blockquote element |
| HFlex | Horizontal flex container |
| VFlex | Vertical flex container |
| Grid | CSS grid container |
| RichText | Rich text block |
| CodeEmbed | Raw HTML embed (use `text` for HTML content) |

### Node Properties

| Property | Required | Description |
|----------|----------|-------------|
| `type` | Yes | Element type (see table above) |
| `className` | Yes (for visible elements) | kebab-case CSS class name |
| `styles` | No | Inline CSS string (desktop/main breakpoint) |
| `responsive` | No | Breakpoint overrides: `{ medium?: "CSS", small?: "CSS", tiny?: "CSS" }` |
| `text` | No | Text content (or HTML for CodeEmbed) |
| `headingLevel` | Heading only | 1-6 |
| `href` | Link/Button | URL |
| `src` | Image | Image URL |
| `alt` | Image | Alt text |
| `children` | No | Array of child nodes |

### CSS String Rules

- **Longhand only**: `padding-top: 10px`, NOT `padding: 10px`
- **Border longhand**: all 12 properties (width/style/color × 4 sides)
- **Border-radius longhand**: `border-top-left-radius`, etc.
- **Variable references**: `$Variable Name` → resolved to `@var_variable-UUID`
- **Font families**: `@raw<|'Instrument Serif', Georgia, serif|>` (bypass CSS parser)
- **No shorthand gap**: use `grid-column-gap` and `grid-row-gap`
- **Units required**: `font-size: 16px` not `font-size: 16`

### `build_section` Parameters

| Parameter | Description |
|-----------|-------------|
| `siteId` | Webflow site ID |
| `tree` | Root SectionSpec node |
| `sharedStyles` | Array of `{ name, styles }` for styles not on elements in this section |
| `insertAfterSectionClass` | Class of section to insert after (reordered post-paste) |
| `insertAfterElementId` | Element ID to insert after |
| `parentElementId` | Element ID to paste inside as child |
| `ix2` | IX2 interaction data to merge (from captured templates) |

---

## Responsive Breakpoints

Add a `responsive` field to any node in the SectionSpec to set breakpoint-specific style overrides:

| Breakpoint | ID | Max Width | Typical Use |
|------------|-----|-----------|-------------|
| Desktop | `main` | 10000px | Default (set in `styles`) |
| Tablet | `medium` | 991px | Reduced padding, 2-col grids |
| Mobile Landscape | `small` | 767px | Single column, smaller type |
| Mobile Portrait | `tiny` | 479px | Minimal padding, compact layout |

Only include **overridden** properties — other properties cascade from desktop.

```json
{
  "type": "Grid",
  "className": "cards-grid",
  "styles": "display: grid; grid-template-columns: 1fr 1fr 1fr; grid-column-gap: 32px; grid-row-gap: 32px;",
  "responsive": {
    "medium": "grid-template-columns: 1fr 1fr;",
    "small": "grid-template-columns: 1fr; grid-column-gap: 16px; grid-row-gap: 16px;"
  }
}
```

`sharedStyles` also supports `responsive`:
```json
{ "name": "container", "styles": "max-width: 1200px;", "responsive": { "small": "max-width: 100%;" } }
```

`update_styles` also supports breakpoints — add a `breakpoint` field to each entry:
```json
update_styles(siteId, [
  { "name": "hero-grid", "properties": { "grid-template-columns": "1fr 1fr" }, "breakpoint": "medium" },
  { "name": "hero-grid", "properties": { "grid-template-columns": "1fr" }, "breakpoint": "small" }
])
```
The viewport switches automatically and returns to desktop after all updates.

### When to use which

| Scenario | Tool | Why |
|----------|------|-----|
| Building a new section | `build_section` with `responsive` fields | Atomic — all breakpoint variants set in XscpData with zero bleed risk |
| Rebuilding an existing section | `delete_elements` + `build_section` | Clean slate, atomic responsive styles |
| Tweaking 1–5 properties on existing styles | `update_styles` | Fast, targeted, no rebuild needed |
| Large responsive overhaul (10+ styles) | Delete + `build_section` | `update_styles` batches >5–10 entries risk style bleed between entries |

**Batch limit**: Keep `update_styles` calls to 5–10 entries max. Properties can leak between adjacent entries due to async commit timing in the setStyle pipeline.

---

## Variable Management

### Creating Variables

```
create_variables(siteId, [
  { name: "Forest", type: "color", value: "#2D4A3E" },
  { name: "Cream", type: "color", value: "#FAF6F1" },
  { name: "Base Size", type: "length", value: { value: 16, unit: "px" } },
  { name: "Body Font", type: "font-family", value: "Montserrat" }
])
```

### Using Variables in Styles

Reference by name with `$` prefix:
```
"styles": "background-color: $Forest; color: $Cream; font-size: $Base Size;"
```

Multi-word names work: `$Sage Light`, `$Warm White`

Variable IDs already include the `variable-` prefix — the bridge emits `@var_` + id (not `@var_variable-` + id).

---

## Font Workaround

Webflow strips `font-family` from XscpData paste. To apply custom fonts:

1. Add fonts in Webflow Designer first (Typography panel → font picker, or Site Settings → Fonts)
2. Use a CodeEmbed element with a `<style>` tag to apply font-family to classes:

```json
{
  "type": "CodeEmbed",
  "className": "font-override-embed",
  "text": "<style>.hero-heading { font-family: 'Instrument Serif', Georgia, serif; }</style>"
}
```

Place the CodeEmbed as the first child of the Section, or at the end.

---

## Factory Elements

Navbar, Slider, Tabs, Dropdown, Lightbox, Map, Video, and Form elements can't be created with `build_section`. They require Webflow's internal factory initialization.

### Capture and Replay

1. Create the factory element manually in Webflow Designer
2. `capture_xscp(siteId, elementId)` — get the XscpData
3. Save the captured data for reuse
4. `paste_xscp(siteId, xscpData, targetElementId)` — replay on other pages

### Alternative

Create manually in Designer, then style via `update_styles`.

---

## Publishing

REST API publish does NOT reliably update the live site for visual verification.
Use the manual **Publish** button in the Webflow Designer for production deploys.

`take_screenshot` uses staging publish which works for verification screenshots.

---

## Common Gotchas

1. **Background highlights on text** — Webflow may apply default backgrounds. Always add `background-color: transparent` to Heading and Paragraph elements if unwanted.
2. **Inline colored spans** — Can't create rich text spans within a single text element. Split into separate TextBlock elements or handle post-build.
3. **Overlays with radial gradients** — Complex CSS gradients may not resolve. Use solid colors with opacity instead.
4. **50% border-radius for circles** — Must use longhand: all four corners set to 50%.
5. **Existing style reuse** — If a className matches an existing style in StyleBlockStore, the bridge reuses its `_id`. Don't emit a style entry for it or Webflow will create duplicates (" 2" suffix).
6. **Max one root node** — Each `build_section` call creates one Section. Never pass multiple roots.
7. **Stale styles** — After deleting and rebuilding a section, old style entries may persist in StyleBlockStore. The bridge handles this by reusing existing IDs.
8. **Font-family stripped** — See Font Workaround section above.
9. **`update_styles` batch bleed** — When updating many styles at the same breakpoint in one call, properties can leak between adjacent entries due to async commit timing. For large batches, prefer setting responsive styles via `build_section` with `responsive` field on nodes (XscpData variants are atomic). Use `update_styles` for small targeted fixes.
10. **`setStyle` and non-px values** — `setStyle({path, value:null})` clears a property from the current breakpoint variant. For percentage values, the bridge uses `{value:'100',unit:'%'}` format. `"auto"` is treated as null (clears the property). For gap properties (`grid-column-gap`, `grid-row-gap`), raw numbers get stored unitless in variant styleLess (e.g. `grid-column-gap: 24;` instead of `24px`) — the bridge now passes these as strings with units to avoid this.
11. **`__DEPRECATED__STYLE_BLOCK_STATE_CHANGED` does not persist** — Directly mutating StyleBlockStore variants via Immutable.js and dispatching this action appears to work but reverts. Always use `setStyle` at the correct breakpoint to modify variants.

---

## Mockup-to-SectionSpec Translation

### Reading the Mockup

1. Identify component boundaries (each `<section>` or top-level component = one build call)
2. Extract inline styles from each element
3. Convert React style objects to CSS strings:
   - `fontSize: 16` → `font-size: 16px`
   - `marginBottom: 24` → `margin-bottom: 24px`
   - `gap: 16` → `grid-column-gap: 16px; grid-row-gap: 16px`
   - `borderRadius: 16` → 4 longhand border-radius properties
   - `padding: "24px 28px"` → `padding-top: 24px; padding-bottom: 24px; padding-left: 28px; padding-right: 28px`
4. Map color values to variable names: `COLORS.forest` → `$Forest`
5. Map font stacks to `@raw<|...|>` syntax

### Interactive Components

For static Webflow build:
- **Hover effects** → Skip (add via Webflow interactions later)
- **Active tab/story selection** → Build the default state only (first item active)
- **Scroll-triggered animations** → Skip (add via IX2 interactions later)
- **Mobile menu toggle** → Skip (Webflow Navbar handles this natively)

---

## Verification Checklist (per section)

After each build, check:

- [ ] Section appears in correct position (after previous section)
- [ ] All child elements present (compare element count to design)
- [ ] Class names applied correctly (check in snapshot)
- [ ] Text content matches design
- [ ] Visual layout matches design (grid columns, spacing, alignment)
- [ ] Colors correct (variables resolving to right values)
- [ ] Fonts correct (heading vs body font families)
- [ ] No unwanted default styles (background highlights, margins)
- [ ] Links have correct href values

---

## Example: Full Section Build

```
# 1. Build
build_section(
  siteId: "699b...",
  tree: {
    type: "Section",
    className: "stats-section",
    styles: "padding-top: 80px; padding-bottom: 80px; background-color: $Forest;",
    children: [
      {
        type: "Container",
        className: "stats-container",
        styles: "max-width: 1200px; margin-left: auto; margin-right: auto;",
        children: [
          {
            type: "Grid",
            className: "stats-grid",
            styles: "display: grid; grid-template-columns: 1fr 1fr 1fr; grid-column-gap: 40px;",
            children: [
              {
                type: "DivBlock",
                className: "stat-item",
                children: [
                  { type: "Heading", className: "stat-value", headingLevel: 3, text: "500+", styles: "font-size: 48px; color: $Cream;" },
                  { type: "Paragraph", className: "stat-label", text: "Students Enrolled", styles: "color: $Sage Light;" }
                ]
              }
            ]
          }
        ]
      }
    ]
  },
  insertAfterSectionClass: "approach-section"
)

# 2. Verify structure
get_snapshot(siteId: "699b...")
→ Confirm: Section.stats-section exists after Section.approach-section
→ Confirm: expected element count

# 3. Visual verify
take_screenshot(siteId: "699b...", sectionClass: "stats-section")
→ Compare to design
→ Fix any issues before proceeding

# 4. Next section
build_section(..., insertAfterSectionClass: "stats-section")
```
