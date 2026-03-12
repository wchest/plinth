# Plinth — V2 Build Workflow (XscpData Paste Pipeline)

How to rebuild a full Webflow page from an HTML/React mockup using `bridge_build_v2`.

---

## Overview

The v2 pipeline creates elements via XscpData paste — ~50ms per section vs ~6s with v1.
Claude sends a SectionSpec tree with inline CSS strings. The content script converts it to
XscpData, resolves style variables, reuses existing styles, and pastes atomically.

---

## Full Page Rebuild Process

### Phase 0: Prepare Variables

Before building any sections, ensure all design token variables exist in Webflow.

1. Extract the `COLORS` object (or equivalent) from the mockup
2. Run `bridge_list_variables` to see what's already defined
3. Run `bridge_create_variables` for any missing tokens
4. Variable naming convention: Title Case matching Webflow's UI (e.g. `$Forest`, `$Cream`)

### Phase 1: Clear Canvas

1. `bridge_snapshot` — get all current elements
2. `bridge_delete` — delete all top-level element IDs (direct children of Body)
3. `bridge_snapshot` — confirm page is empty

### Phase 2: Section-by-Section Build

For EACH section in the mockup, in order:

```
1. BUILD    → bridge_build_v2(siteId, tree, insertAfterSectionClass?)
2. SNAPSHOT → bridge_snapshot(siteId) — confirm structure, class names, element count
3. SCREENSHOT → take_screenshot(siteId, sectionClass) — visual comparison to mockup
4. FIX      → If issues found, use update_styles / update_content / delete + rebuild
5. NEXT     → Set insertAfterSectionClass to this section's class for the next build
```

**Never proceed to the next section without completing snapshot + screenshot verification.**

### Phase 3: Post-Build Polish

- Rich text spans (colored words within headings) — requires manual editing or CMS binding
- Interactions/animations — requires IX2 data (capture from reference, merge on build)
- Responsive breakpoints — update_styles with breakpoint-specific overrides
- Nav/Footer — factory elements, use XscpData capture + replay from a template

---

## SectionSpec Format

Each node in the tree:

```json
{
  "type": "Section",
  "className": "hero-section",
  "styles": "CSS string with longhand properties...",
  "children": [...]
}
```

### Element Types

| SectionSpec type | Notes |
|---|---|
| Section | Root of every build. One per call. |
| DivBlock | Generic div container |
| Container | Same as DivBlock in v2 |
| Heading | Needs `headingLevel` (1-6) |
| Paragraph | Block text element |
| TextBlock | Inline/span text element |
| Link | Needs `href`. Add `text` for link text. |
| Button | Link variant with button styling |
| Image | Needs `src` and `alt` |
| List | ul element |
| ListItem | li element |
| BlockQuote | blockquote element |
| HFlex / VFlex | Flex containers |
| Grid | CSS grid container |
| CodeEmbed | Raw HTML embed |

### CSS String Rules

- **Longhand only**: `padding-top: 10px`, NOT `padding: 10px`
- **Border longhand**: all 12 properties (width/style/color × 4 sides)
- **Border-radius longhand**: `border-top-left-radius`, etc.
- **Variable references**: `$Variable Name` → resolved to `@var_variable-UUID`
- **Font families**: `@raw<|'Instrument Serif', Georgia, serif|>` (bypass CSS parser)
- **No shorthand gap**: use `grid-column-gap` and `grid-row-gap`
- **Units required**: `font-size: 16px` not `font-size: 16`

### Common Gotchas

1. **Background highlights on text** — Webflow may apply default backgrounds. Always add `background-color: transparent` to Heading and Paragraph elements if unwanted.
2. **Inline colored spans** — v2 can't create rich text spans within a single text element. Split into separate TextBlock elements or handle post-build.
3. **Overlays with radial gradients** — Complex CSS gradients may not resolve. Use solid colors with opacity instead.
4. **50% border-radius for circles** — Must use longhand: all four corners set to 50%.
5. **Existing style updates** — If a className matches an existing style, v2 emits the style entry with the existing `_id` so paste updates it in place. New CSS properties overwrite old ones.
6. **Max one root node** — Each `bridge_build_v2` call creates one Section. Never pass multiple roots.

---

## Mockup-to-SectionSpec Translation

### Reading the Mockup

1. Identify the component boundaries (each `<section>` or top-level component = one build call)
2. Extract the inline styles from each JSX element
3. Convert React style objects to CSS strings:
   - `fontSize: 16` → `font-size: 16px`
   - `marginBottom: 24` → `margin-bottom: 24px`
   - `gap: 16` → `grid-column-gap: 16px; grid-row-gap: 16px`
   - `borderRadius: 16` → 4 longhand border-radius properties
   - `padding: "24px 28px"` → `padding-top: 24px; padding-bottom: 24px; padding-left: 28px; padding-right: 28px`
4. Map color values to variable names: `COLORS.forest` → `$Forest`
5. Map font stacks to `@raw<|...|>` syntax

### Handling Interactive Components

Some mockup components have state (useState, onClick, hover effects). For the static Webflow build:
- **Hover effects** → Skip (add via Webflow interactions later)
- **Active tab/story selection** → Build the default state only (first item active)
- **Scroll-triggered animations** → Skip (add via IX2 interactions later)
- **Mobile menu toggle** → Skip (Webflow Navbar handles this natively)

### Handling Factory Elements

These can't be built with `bridge_build_v2` directly:
- Navbar, Slider, Tabs, Dropdown, Lightbox, Map, Video, Form elements
- **Solution**: Capture XscpData from a working template → replay with `bridge_paste`
- Or: Create manually in Designer, then style via `update_styles`

---

## Verification Checklist (per section)

After each build, check:

- [ ] Section appears in correct position (after previous section)
- [ ] All child elements present (compare element count to mockup)
- [ ] Class names applied correctly (check in snapshot)
- [ ] Text content matches mockup
- [ ] Visual layout matches mockup (grid columns, spacing, alignment)
- [ ] Colors correct (variables resolving to right hex values)
- [ ] Fonts correct (heading vs body font families)
- [ ] No unwanted default styles (background highlights, margins)
- [ ] Links have correct href values

---

## Example: Full Section Build

```
# 1. Build
bridge_build_v2(
  siteId: "699b...",
  tree: { type: "Section", className: "stats-section", styles: "...", children: [...] },
  insertAfterSectionClass: "approach-section"
)

# 2. Verify structure
bridge_snapshot(siteId: "699b...")
→ Confirm: Section.stats-section exists after Section.approach-section
→ Confirm: 6 stat items, each with value + label

# 3. Visual verify
take_screenshot(siteId: "699b...", sectionClass: "stats-section")
→ Compare to mockup: forest background, 6-column grid, cream text
→ Fix any issues before proceeding

# 4. Next section
bridge_build_v2(..., insertAfterSectionClass: "stats-section")
```
