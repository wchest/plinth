# Webflow Element Presets Reference

Common element patterns for BuildPlan generation.

---

## Element Type Mapping

| BuildPlan Type | Webflow Designer API | Notes |
|---------------|---------------------|-------|
| `Section` | `webflow.createDOM('Section')` | Root element only. One per BuildPlan. |
| `DivBlock` | `webflow.createDOM('DivBlock')` | General container |
| `Container` | `webflow.createDOM('Container')` | Max-width centered container |
| `Heading` | `webflow.createDOM('Heading')` | Requires `headingLevel` 1–6 |
| `Paragraph` | `webflow.createDOM('Paragraph')` | Block-level text |
| `TextBlock` | `webflow.createDOM('TextBlock')` | Inline text |
| `Button` | `webflow.createDOM('FormButton')` or link | Requires `href` |
| `TextLink` | `webflow.createDOM('Link')` | Inline link, requires `href` |
| `LinkBlock` | `webflow.createDOM('Link')` | Clickable block container, requires `href` |
| `Image` | `webflow.createDOM('Image')` | Requires `src` and `alt` |
| `DOM` | `webflow.createDOM(domTag)` | Custom HTML tag (span, code, etc.) |

---

## Common Patterns

### Section with Container
```json
{
  "type": "Section",
  "className": "section-name",
  "children": [{
    "type": "DivBlock",
    "className": "container-1200",
    "children": [...]
  }]
}
```

### Card Grid
```json
{
  "type": "DivBlock",
  "className": "cards-grid",
  "children": [
    { "type": "DivBlock", "className": "card", "children": [...] },
    { "type": "DivBlock", "className": "card", "children": [...] }
  ]
}
```

### CTA Button
```json
{
  "type": "Button",
  "className": "btn-primary",
  "text": "Schedule a Call",
  "href": "https://example.com/contact"
}
```

### Phone Link
```json
{
  "type": "Button",
  "className": "btn-primary",
  "text": "Call Us",
  "linkType": "phone",
  "href": "+15551234567"
}
```

### Image
```json
{
  "type": "Image",
  "className": "hero-image",
  "src": "https://cdn.prod.website-files.com/...",
  "alt": "Descriptive alt text"
}
```

### Heading
```json
{
  "type": "Heading",
  "headingLevel": 2,
  "className": "section-h2",
  "text": "Section Title"
}
```

---

## Style Pattern: Flex Row
```json
{
  "name": "flex-row",
  "properties": {
    "display": "flex",
    "flex-direction": "row",
    "align-items": "center",
    "grid-column-gap": "24px"
  }
}
```

## Style Pattern: Card Grid (3 columns)
```json
{
  "name": "cards-grid",
  "properties": {
    "display": "grid",
    "grid-template-columns": "repeat(3, 1fr)",
    "grid-column-gap": "32px",
    "grid-row-gap": "32px"
  },
  "breakpoints": {
    "medium": {
      "grid-template-columns": "repeat(2, 1fr)"
    },
    "small": {
      "grid-template-columns": "1fr"
    }
  }
}
```

## Style Pattern: Section
```json
{
  "name": "section-warm-white",
  "properties": {
    "background-color": "#FFFCF8",
    "padding-top": "80px",
    "padding-right": "32px",
    "padding-bottom": "80px",
    "padding-left": "32px"
  },
  "breakpoints": {
    "medium": {
      "padding-top": "60px",
      "padding-bottom": "60px"
    },
    "small": {
      "padding-top": "40px",
      "padding-bottom": "40px",
      "padding-right": "20px",
      "padding-left": "20px"
    }
  }
}
```
