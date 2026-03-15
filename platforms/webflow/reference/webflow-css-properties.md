# Webflow CSS Properties Reference

All supported CSS properties in the Webflow Designer API. **Always use longhand form.**

---

## Layout
`display`, `position`, `top`, `right`, `bottom`, `left`, `z-index`, `float`, `clear`, `overflow-x`, `overflow-y`

## Flexbox
`flex-direction`, `flex-wrap`, `justify-content`, `align-items`, `align-content`, `align-self`, `flex-grow`, `flex-shrink`, `flex-basis`, `order`

## Grid
`grid-template-columns`, `grid-template-rows`, `grid-auto-columns`, `grid-auto-rows`, `grid-auto-flow`, `grid-column-gap`, `grid-row-gap`, `grid-column-start`, `grid-column-end`, `grid-row-start`, `grid-row-end`, `justify-items`, `justify-self`, `place-items`, `place-content`

## Box Model
`width`, `height`, `min-width`, `max-width`, `min-height`, `max-height`, `margin-top`, `margin-right`, `margin-bottom`, `margin-left`, `padding-top`, `padding-right`, `padding-bottom`, `padding-left`

## Border
`border-top-style`, `border-right-style`, `border-bottom-style`, `border-left-style`, `border-top-width`, `border-right-width`, `border-bottom-width`, `border-left-width`, `border-top-color`, `border-right-color`, `border-bottom-color`, `border-left-color`, `border-top-left-radius`, `border-top-right-radius`, `border-bottom-left-radius`, `border-bottom-right-radius`

## Typography
`font-family`, `font-size`, `font-weight`, `font-style`, `line-height`, `letter-spacing`, `text-align`, `text-decoration`, `text-transform`, `text-indent`, `white-space`, `word-break`, `word-spacing`

## Visual
`color`, `background-color`, `background-image`, `background-position`, `background-size`, `background-repeat`, `opacity`, `box-shadow`, `text-shadow`, `filter`, `backdrop-filter`, `mix-blend-mode`

## Transform & Animation
`transform`, `transform-origin`, `transition`, `animation`

## Other
`cursor`, `pointer-events`, `object-fit`, `object-position`, `list-style-type`, `vertical-align`

---

## Shorthand to Longhand Reference

| Shorthand | Longhand Properties |
|-----------|-------------------|
| `padding: a b c d` | `padding-top`, `padding-right`, `padding-bottom`, `padding-left` |
| `margin: a b c d` | `margin-top`, `margin-right`, `margin-bottom`, `margin-left` |
| `border-radius: a b c d` | `border-top-left-radius`, `border-top-right-radius`, `border-bottom-right-radius`, `border-bottom-left-radius` |
| `border: w s c` | `border-top-width`, `border-top-style`, `border-top-color` (×4 sides) |
| `gap: r c` | `grid-row-gap`, `grid-column-gap` |
| `row-gap` | `grid-row-gap` |
| `column-gap` | `grid-column-gap` |

---

## Breakpoint IDs

| ID | Applies at |
|----|-----------|
| *(omitted)* | Default (main, all sizes) |
| `xxl` | ≥ 1920px |
| `xl` | ≥ 1440px |
| `large` | ≥ 1280px |
| `medium` | ≤ 991px (tablet) |
| `small` | ≤ 767px (mobile landscape) |
| `tiny` | ≤ 479px (mobile portrait) |

---

## Pseudo States

`hover`, `active`, `focus`, `visited`, `before`, `after`, `first-child`, `last-child`, `nth-child(odd)`, `nth-child(even)`, `placeholder`, `focus-visible`, `focus-within`, `empty`
