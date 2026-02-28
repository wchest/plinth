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
  "styles": [...],
  "tree": {
    "type": "Section",
    "className": "hero-section",
    "children": [...]
  }
}
```

**One BuildPlan = one Section element as the root.**

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

---

## Design Tokens

Read the project's design system doc before generating plans. It will define colors, fonts, spacing, and any existing styles that should be referenced but not recreated.

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

## Workflow

1. Generate a BuildPlan JSON for one section
2. Save it (e.g. `skill/examples/my-section.json`)
3. POST to `http://localhost:3847/queue`
4. Check `http://localhost:3847/status` — wait for `completed`
5. Verify in Webflow Designer
6. Fix any issues and re-POST (the extension handles duplicate style names gracefully — it skips existing ones)

---

