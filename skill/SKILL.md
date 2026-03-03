# Plinth — BuildPlan Generation Reference

How to generate valid BuildPlans and post them to the relay server.

---

## What Is a BuildPlan?

A BuildPlan is a JSON document describing **one section** of a Webflow page. Claude generates it; the Designer Extension builds it via the Webflow Designer API.

```json
{
  "version": "1.0",
  "siteId": "your-site-id",
  "sectionName": "hero",
  "order": 1,
  "insertAfterElementId": "abc123",
  "styles": [...],
  "tree": {
    "type": "Section",
    "className": "hero-section",
    "children": [...]
  }
}
```

**One BuildPlan = one Section element as the root.**

### Controlling insertion position

Three options, in priority order:

**`insertAfterSectionClass`** (recommended for most cases)
Set this to the CSS class of the section you want the new section to appear **after**. The extension finds it by class name — no element IDs needed.
```json
"insertAfterSectionClass": "hero-section"
```
Use this when you know which section comes before the new one. Works even if you haven't called `get_page_snapshot` yet.

**`insertAfterElementId`** (use when you need precision)
Set this to the Designer element ID returned by `get_page_snapshot`. Useful when multiple sections share a class, or you need to target a non-Section element.
```json
"insertAfterElementId": "abc123def456"
```

**Neither field set** — falls back to the currently selected element in the Designer, or the page root if nothing is selected. Avoid this for automated builds.

---

## Rules (Critical)

### CSS Rules
- **All CSS must be longhand** — `padding-top` not `padding`, `grid-row-gap` not `row-gap`
- Full longhand list: `padding-top/right/bottom/left`, `margin-top/right/bottom/left`, `border-top/right/bottom/left-width/style/color`, `border-top-left/top-right/bottom-right/bottom-left-radius`
- Grid gaps: use `grid-column-gap` and `grid-row-gap` (never `gap`, `column-gap`, `row-gap`)

### Element Rules
- Every element must have a `className` (kebab-case, e.g. `hero-section`, `btn-primary`)
- Text content goes in the `text` field — never as a child node
- `Heading` elements require `headingLevel` (integer 1–6) and `text`
- `Button`, `TextLink`, `LinkBlock` require `href`
- `Image` requires `src` and `alt`
- **Max nesting depth: 6 levels** from Section root
- **One Section per BuildPlan** — Section must be the root element type

### Naming Rules
- All `className` and style `name` values: kebab-case (`hero-badge`, `stat-value`)
- `sectionName`: short kebab-case slug (`hero`, `stats-bar`, `recognition`)

---

## Element Types

| Type | Webflow Equivalent | Required Fields | Notes |
|------|--------------------|-----------------|-------|
| `Section` | Section | className | Root only |
| `DivBlock` | Div Block | className | General container |
| `Container` | Container | className | Max-width container |
| `Heading` | Heading | className, headingLevel, text | headingLevel 1–6 |
| `Paragraph` | Paragraph | className, text | Block text |
| `TextBlock` | Text Block | className, text | Inline text |
| `Button` | Button/Link | className, text, href | CTA |
| `TextLink` | Text Link | className, text, href | Inline link |
| `LinkBlock` | Link Block | className, href | Clickable container |
| `Image` | Image | className, src, alt | |
| `DOM` | Custom tag | className, domTag | For `span`, `em`, etc. |
| `DynamoWrapper` | Collection List Wrapper | className | Root of a CMS list |
| `DynamoList` | Collection List | className | Child of DynamoWrapper |
| `DynamoItem` | Collection Item | className | One item template |
| `DynamoEmpty` | Empty State | className, text | Shown when list is empty |
| `Slider` | Slider | className | Preset creates 2 slides; SliderSlide children reuse then extend them |
| `SliderSlide` | Slide | className | Must be direct child of Slider — cannot be inserted standalone |
| `Tabs` | Tabs | className | Preset creates panes; TabPane children reuse then extend them |
| `TabPane` | Tab Pane | className | Must be direct child of Tabs — cannot be inserted standalone |
| `QuickStack` | Quick Stack | className | Responsive stack layout; children append inside |
| `HFlex` | Horizontal Flex | className | Horizontal flex row |
| `VFlex` | Vertical Flex | className | Vertical flex column |
| `Grid` | Grid | className | CSS grid container |
| `List` | List (ul) | className | Unordered list; children should be ListItem |
| `ListItem` | List Item (li) | className | List item; must be child of List |
| `Blockquote` | Blockquote | className, text | `<blockquote>` element |
| `RichText` | Rich Text Block | className | Rich text container (content set manually in Designer) |
| `HtmlEmbed` | HTML Embed | className | Custom code embed (content set manually in Designer) |

---

## Design Decisions

### CMS Collections vs Embedded Text

**CMS is a content management tool, not an architectural requirement.** Use it when the content changes frequently, has structure that repeats at scale, or needs to be editable by non-developers. Don't use it just because it feels more "proper."

Use **CMS** (DynamoWrapper) when:
- Content genuinely repeats at scale — blog posts, news, events, staff directory, programs, courses
- Non-developers need to add/edit/remove items without touching the Designer
- Content drives collection template pages

Use **embedded static text** when:
- Content is marketing copy that a developer will update anyway — hero, stats bar, approach, CTA, footer
- The section has a small fixed number of items that rarely change
- There's no client need to manage it through the CMS UI

**The edge case — small repeating sections (e.g. a quote carousel, a stats bar):**
- 3–4 fixed items that change twice a year → static, simpler, no overhead
- Client wants to rotate items without touching the Designer → CMS
- A collection already exists with the right data → probably worth wiring up

**Rule of thumb:** if the content would appear in a spreadsheet with 5+ rows and non-developers need to manage it, use CMS. Otherwise, static is fine.

### Styles

- Create a **named style** for every visual class — Webflow has no inline styles
- Reuse existing styles rather than creating near-duplicates (check `get_page_snapshot` or `list_styles` first)
- Name styles for their **role**, not their appearance: `btn-primary` not `blue-button`, `section-alt` not `grey-background`
- For variants, use combo classes: define `Card` as the base, `Card--Featured` as the modifier — but note that BuildPlan only supports a single `className` per element, so model variants as separate style definitions that include both the base and modifier properties

### Webflow Variables

Variables are CSS custom properties scoped to the site. Use them for design tokens — brand colors, spacing scales, font sizes — that appear across many styles. If the project has variables defined, reference them in style property values using `var(--variable-name)`. Don't try to define variables in a BuildPlan; create them in Designer first, then reference them by their binding string.

### CMS Bindings

There are two levels of CMS integration, and only the first is automatable:

**1. Collection List structure (automatable)** — A `DynamoWrapper` element placed on a page references a CMS collection and loops over its items. BuildPlan supports `DynamoWrapper`, `DynamoList`, and `DynamoItem` element types. When built on a Collection Template page, Webflow wires the list to the page's collection automatically.

**2. Field-level binding (manual only)** — Connecting a specific text or image element inside a `DynamoItem` to a specific CMS field (e.g. `quote-text` → "Body" field) cannot be done via any API — Designer Extension or Data API. This step must be done manually in the Designer after the structure is built.

**Workflow for CMS-driven sections:**
- Use `DynamoWrapper` → `DynamoList` → `DynamoItem` in the BuildPlan tree to create the collection list structure
- Inside `DynamoItem`, build the card/item layout with realistic placeholder text
- Name elements clearly to match their intended field (e.g. `quote-text`, `quote-author`, `quote-avatar`)
- Note in your response exactly which elements need field bindings and to which collection fields

**Manual field binding steps (done in Designer after build):**

The element must be inside a `DynamoItem` for binding to be available.

- **Text** (Heading, Paragraph, Text Block): click element → right sidebar Settings panel → purple binding icon next to the text field → select collection field
- **Image**: click image → Settings → "Get image from" → select Image field
- **Link/Button**: click element → link settings → "Get URL from field" → select Link/URL field
- **Shortcut**: right-click any element inside a Collection Item → "Connect to field"

Once bound, the Designer previews real content from the first CMS item. Bindings persist permanently in the saved site.

### Components

Components are reusable element trees. BuildPlan builds raw elements, not component instances — the Designer Extension API doesn't support creating or instantiating components. If a pattern repeats (e.g. a 3-card grid), build it as a static tree and note which element should be converted to a component in Designer afterwards.

### Nesting and Semantics

- Prefer semantic structure: `Section > Container > DivBlock` for sections, not nested divs all the way down
- Use `Heading` with the correct `headingLevel` for SEO hierarchy — one `h1` per page, `h2` for section titles, `h3` for card titles
- Use `Paragraph` for body copy, `TextBlock` for short labels or captions

---

## Design Tokens

Read the project's design system doc before generating plans. It will define colors, fonts, spacing, and any existing styles that should be referenced but not recreated.

---

## Webflow Clipboard Format (`@webflow/XscpData`)

An alternative to BuildPlan for sections that need CMS bindings, or for faster one-shot insertion. Generate the JSON and call `copy_to_webflow` — the user pastes with Ctrl+V in the Designer.

### Structure

```json
{
  "type": "@webflow/XscpData",
  "payload": {
    "nodes": [ ...element nodes... ],
    "styles": [ ...style objects... ],
    "assets": [],
    "ix1": [],
    "ix2": { "interactions": [], "events": [], "actionLists": [] }
  },
  "meta": {
    "unlinkedSymbolCount": 0,
    "droppedLinks": 0,
    "dynBindRemovedCount": 0,
    "dynListBindRemovedCount": 0,
    "paginationRemovedCount": 0
  }
}
```

### Element nodes

Every element node:
```json
{ "_id": "uuid", "tag": "div", "classes": ["style-uuid"], "children": ["child-uuid"], "type": "Block", "data": { "tag": "div", "text": false } }
```

Text content is a **child text node** (not a field):
```json
{ "_id": "uuid", "text": true, "v": "The text content" }
```

| Element | `tag` | `type` | Notes |
|---------|-------|--------|-------|
| Section | `section` | `Section` | |
| Div | `div` | `Block` | |
| Heading | `h1`–`h6` | `Heading` | `data.tag` must match |
| Paragraph | `p` | `Paragraph` | |
| Link/Button | `a` | `Link` | add `data.link: { url, target }` |
| Image | `img` | `Image` | add `data.attr: { src, alt }` |

### Style objects

```json
{ "_id": "uuid", "fake": false, "type": "class", "name": "My Style Name", "namespace": "", "comb": "", "styleLess": "padding-top: 48px; background-color: rgb(45,74,62);", "variants": {}, "children": [], "selector": null }
```

- `styleLess` is a raw CSS string — shorthand properties are fine here (unlike BuildPlan)
- Styles are referenced by UUID in the node `classes` array
- Style names can be any string (spaces allowed, unlike BuildPlan classNames)

### Helper pattern

```javascript
function uuid() { return crypto.randomUUID(); }

// Create a style, return id + style object
function style(name, css) {
  const id = uuid();
  return { id, style: { _id: id, fake: false, type: "class", name, namespace: "", comb: "",
    styleLess: css, variants: {}, children: [], selector: null } };
}

// Create a div node
function div(classIds, childIds) {
  const id = uuid();
  return { id, node: { _id: id, tag: "div", classes: classIds, children: childIds,
    type: "Block", data: { tag: "div", text: false } } };
}
```

### When to use clipboard vs BuildPlan

| Situation | Use |
|-----------|-----|
| Static section (hero, stats, CTA) | Either — BuildPlan is headless; clipboard is instant |
| CMS Collection List with field bindings | Clipboard (BuildPlan can create the structure but not bind fields) |
| Needs to run unattended / queued | BuildPlan |
| One-off paste, user is at the Designer | Clipboard |

---

## How to Post a BuildPlan

```bash
curl -X POST http://localhost:3847/queue \
  -H "Content-Type: application/json" \
  -d @plan.json
```

---

## Checking Status

```bash
curl http://localhost:3847/status
```

Returns queue state: pending plans, in-progress, completed, errors.

---

## Build Loop (one section at a time)

**Always build one section at a time.** This is not just a preference — `insertAfterElementId` for section N+1 comes from the element ID of section N, which you only know after it's built and verified. Queuing multiple sections upfront loses ordering control.

### For each section:

**1. Orient**
```
get_queue_status(siteId)      — see what's pending/errored
get_page_snapshot(siteId)     — see what's already on canvas + element IDs
```

**2. Queue and build**
```
queue_buildplan(plan, wait=true)
```
- `wait=true` blocks until the extension picks it up and builds. Do not proceed until it returns.
- On **error**: the exact error message is returned. Fix the plan and re-queue. The failed item stays in the queue for inspection — clear it with `clear_queue` before re-queuing.
- On **success**: returns `{ sectionClass, buildStats: { elementsCreated, stylesCreated, elapsedMs } }`. The item is automatically removed from the queue.

**3. Verify — mandatory after every build, no exceptions**

Do both steps every time. Do not proceed to the next section until both pass.

**Step 3a — structural check:**
```
get_page_snapshot(siteId)
```
Confirm:
- `Section#<elementId> .{sectionClass}` is present
- Element count is plausible (matches what was built)
- Key children (heading, container, buttons, etc.) are present
- No duplicate sections with the same class

If anything looks wrong — missing elements, wrong nesting, duplicate section — fix it before continuing. Use `update_content`, `update_styles`, `insert_elements`, or `replacesSectionClass` as appropriate.

**Step 3b — visual check:**
```
take_screenshot(siteId, sectionClass="hero-section")
```
This publishes to the `.webflow.io` staging subdomain and returns an image of just that section. Takes ~25 seconds. Use `skipPublish=true` for subsequent screenshots in the same session (staging is already up to date).

Look at the screenshot critically:
- Layout matches the design intent (spacing, columns, alignment)
- Text is readable and correctly placed
- No obviously broken styles (zero-height elements, invisible text, collapsed containers)

If the visual is wrong, diagnose from `get_page_snapshot` and fix with the appropriate edit tool before moving on.

**Step 3c — record the element ID:**
The `elementId` from the Section line in `get_page_snapshot` is what you'll pass as `insertAfterSectionClass` or `insertAfterElementId` for the next section. Note it now.

**4. Next section**
Set `insertAfterSectionClass` to the class of the section just built. Generate the next plan. Repeat from step 2.

### Common errors and fixes

| Error | Fix |
|-------|-----|
| `element tree exceeds maximum nesting depth of 6 levels` | Flatten a wrapper div — merge its styles into its parent |
| `shorthand CSS property "X" is not allowed` | Replace with longhand: `padding` → `padding-top/right/bottom/left` |
| `Heading element requires headingLevel` | Add `"headingLevel": 2` to the Heading node |
| `Button element requires a non-empty "href"` | Add `"href": "#"` or a real URL |
| `User does not have permission to make changes` | The Designer Extension isn't open or the user isn't on the right page |
| Build times out | Extension not open, or not connected to the site |

---

## Editing Existing Sections

There are three ways to edit content already on canvas. Use the simplest one that fits the task.

### 1. Style-only updates — `update_styles`

Change CSS properties on existing named styles without touching the element tree.

```
update_styles(siteId, [{ name, properties, breakpoints?, pseudo? }])
```

- `name`: must be an existing Webflow style name (kebab-case)
- `properties`: longhand CSS only (same rules as BuildPlan)
- Returns how many styles were updated

**Use when:** tweaking colors, spacing, typography, hover states on an already-built section.

---

### 2. Content-only updates — `update_content`

Patch text, links, or attributes on elements by their CSS class.

```
update_content(siteId, [{ className, text?, href?, src?, alt?, attributes? }])
```

- `className`: targets ALL elements on the canvas with that class
- Any field can be omitted — only specified fields are updated
- Returns how many elements were patched

**Use when:** fixing copy, updating a CTA link, swapping an image — without rebuilding the DOM.

---

### 3. Full section replacement — `replacesSectionClass`

Replace an existing section atomically: find it by class, remove it, build the new version in the same position.

Add `replacesSectionClass` to the BuildPlan root:

```json
{
  "version": "1.0",
  "siteId": "...",
  "sectionName": "hero",
  "order": 1,
  "replacesSectionClass": "hero-section",
  "styles": [...],
  "tree": { "type": "Section", "className": "hero-section", ... }
}
```

- The extension finds the section with class `hero-section`, captures the element before it as the insertion anchor, removes it, then builds the new tree in that exact position
- Styles in the plan are **upserted** (existing styles are updated rather than skipped)
- If no section with that class is found, the new section is built at the end of the page

**Use when:** structural changes are needed — adding/removing elements, changing nesting — that can't be done with style or content patches alone.

---

### 4. Add elements to an existing section — `insert_elements`

Add new nodes inside or after an existing element without touching the rest.

```
insert_elements(siteId, nodes[], parentClass?, afterClass?, styles?)
```

Exactly one of `parentClass` or `afterClass` must be provided:
- **`parentClass`** — append nodes as children inside the named element (e.g. add a card to `"card-grid"`)
- **`afterClass`** — insert nodes as siblings after the named element (e.g. add a button after `"hero-heading"`)

`nodes` uses the same ElementNode format as a BuildPlan tree (type, className, text, href, children, etc) but the root doesn't need to be a Section.

**Use when:** adding a missing element, injecting a new card into a grid, inserting a CTA button.

**Cannot do with insert_elements:**
- Change nesting depth of existing elements (wrapping, unwrapping)
- Move elements to different positions
- Create `SliderSlide` or `TabPane` elements (these must be children of `Slider`/`Tabs` in a BuildPlan — use `replacesSectionClass` to rebuild the section instead)
- For structural changes, use `replacesSectionClass` to rebuild the section

---

### Decision guide

| What changed | Use |
|---|---|
| Only CSS (colors, sizes, spacing) | `update_styles` |
| Only text, links, or attributes | `update_content` |
| Add new elements | `insert_elements` |
| Remove specific elements | `delete_elements` |
| Change nesting / restructure | `replacesSectionClass` in BuildPlan |
| First time building a section | `queue_buildplan` (no `replacesSectionClass`) |

After any edit, call `get_page_snapshot` to verify the changes took effect.

---

