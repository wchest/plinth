# Element Types Roadmap

All `webflow.elementPresets` keys discovered from the Designer Extension API, grouped by priority and status.

---

## Status key

| Status | Meaning |
|--------|---------|
| ✅ Done | Supported in BuildPlan |
| 🔜 Next | High-value, straightforward to add |
| 🔶 Complex | Needs more investigation (inner structure, interactions) |
| ⏭ Later | Lower priority or niche |
| ❌ Skip | Out of scope (commerce, auth, Layout templates) |

---

## Core layout & content

| Preset | BuildPlan type | Status | Notes |
|--------|---------------|--------|-------|
| `DOM` | `DOM` | ✅ Done | Generic tag via `domTag` field |
| `DivBlock` | `DivBlock` | ✅ Done | |
| `Section` | `Section` | ✅ Done | Root element only |
| `Heading` | `Heading` | ✅ Done | Requires `headingLevel` |
| `Paragraph` | `Paragraph` | ✅ Done | |
| `TextBlock` | `TextBlock` | ✅ Done | |
| `Button` | `Button` | ✅ Done | Requires `href` |
| `TextLink` | `TextLink` | ✅ Done | Requires `href` |
| `LinkBlock` | `LinkBlock` | ✅ Done | Requires `href` |
| `Image` | `Image` | ✅ Done | Requires `src`, `alt` |
| `BlockContainer` | `Container` | ✅ Done | Max-width container |
| `List` | `List` | ✅ Done | `<ul>` preset; children are ListItem |
| `ListItem` | `ListItem` | ✅ Done | `<li>` DOM element |
| `Blockquote` | `Blockquote` | ✅ Done | `<blockquote>` DOM element |
| `RichText` | `RichText` | ✅ Done | Rich text preset; content set manually |
| `HtmlEmbed` | `HtmlEmbed` | ✅ Done | Custom code embed preset; content set manually |

---

## Layout presets

| Preset | BuildPlan type | Status | Notes |
|--------|---------------|--------|-------|
| `QuickStack` | `QuickStack` | ✅ Done | Responsive stack; children append inside |
| `HFlex` | `HFlex` | ✅ Done | Horizontal flex row |
| `VFlex` | `VFlex` | ✅ Done | Vertical flex column |
| `Grid` | `Grid` | ✅ Done | CSS grid container |
| `Row` | `Row` | ⏭ Later | Legacy Webflow 2-column row |

---

## Interactive / compound

| Preset | BuildPlan type | Status | Notes |
|--------|---------------|--------|-------|
| `DynamoWrapper` | `DynamoWrapper` | ✅ Done | CMS collection list; children go into DynamoItem |
| `SliderWrapper` | `Slider` | ✅ Done | Children (SliderSlide) go into SliderMask |
| — | `SliderSlide` | ✅ Done | Slide content; created as div inside SliderMask |
| `TabsWrapper` | `Tabs` | ✅ Done | Children (TabPane) go into TabsContent |
| — | `TabPane` | ✅ Done | Tab content pane; created as div inside TabsContent |
| `NavbarWrapper` | `Navbar` | 🔜 Next | Nav bar; inner structure needs mapping |
| `DropdownWrapper` | `Dropdown` | 🔶 Complex | Interactive dropdown; inner parts need mapping |
| `LightboxWrapper` | `Lightbox` | 🔶 Complex | Lightbox with trigger + media |
| `SearchForm` | `SearchForm` | ⏭ Later | Webflow site search |
| `Pagination` | `Pagination` | ⏭ Later | CMS list pagination controls |

---

## Media

| Preset | BuildPlan type | Status | Notes |
|--------|---------------|--------|-------|
| `Video` | `Video` | 🔜 Next | Webflow video embed |
| `YouTubeVideo` | `YouTubeVideo` | 🔜 Next | YouTube embed |
| `Rive` | `Rive` | ⏭ Later | Rive animation embed |
| `Spline` | `Spline` | ⏭ Later | 3D Spline scene embed |
| `MapWidget` | `Map` | ⏭ Later | Google Maps embed |
| `Facebook` | — | ❌ Skip | Facebook social widget |
| `Twitter` | — | ❌ Skip | Twitter/X embed |

---

## Forms

| Preset | BuildPlan type | Status | Notes |
|--------|---------------|--------|-------|
| `FormForm` | `Form` | 🔜 Next | Form container |
| `FormTextInput` | `FormInput` | 🔜 Next | Text/email/etc input |
| `FormTextarea` | `FormTextarea` | 🔜 Next | Multiline text |
| `FormSelect` | `FormSelect` | 🔜 Next | Dropdown select |
| `FormButton` | `FormButton` | 🔜 Next | Submit button |
| `FormBlockLabel` | `FormLabel` | 🔜 Next | Field label |
| `FormCheckboxInput` | `FormCheckbox` | 🔶 Complex | Checkbox + label pair |
| `FormRadioInput` | `FormRadio` | 🔶 Complex | Radio + label pair |
| `FormFileUploadWrapper` | `FormFileUpload` | ⏭ Later | File upload |
| `FormReCaptcha` | — | ⏭ Later | reCAPTCHA |

---

## Commerce (skip unless needed)

| Preset | Status |
|--------|--------|
| `CommerceAddToCartWrapper` | ❌ Skip |
| `CommerceCartWrapper` | ❌ Skip |
| `CommerceCheckout*` | ❌ Skip |
| `CommerceOrderConfirmationContainer` | ❌ Skip |
| `CommercePayPalCheckoutButton` | ❌ Skip |
| `CommerceDownloadsWrapper` | ❌ Skip |

---

## Auth (skip unless needed)

| Preset | Status |
|--------|--------|
| `LogIn`, `SignUp`, `ResetPassword`, `UpdatePassword` | ❌ Skip |
| `UserAccount`, `UserAccountSubscriptionList` | ❌ Skip |
| `UserLogOutLogIn` | ❌ Skip |
| `LocalesWrapper` | ❌ Skip |

---

## Layout templates (full sections — not for BuildPlan)

These are pre-built section scaffolds (hero, pricing, testimonials, etc.).
They're useful for one-shot paste via `copy_to_webflow`, not as BuildPlan element types.

`LayoutHero*`, `LayoutTestimonial*`, `LayoutPricing*`, `LayoutTeam*`,
`LayoutLogos*`, `LayoutNavbar*`, `LayoutGallery*`, `LayoutFooter*`, `LayoutFeatures*`

---

## Implementation order (recommended)

1. ~~**Now**: `HFlex`, `VFlex`, `Grid`~~ ✅ Done
2. ~~**Next**: `List` + `ListItem`, `Blockquote`, `RichText`, `HtmlEmbed`~~ ✅ Done
3. **Next**: Forms (`FormForm` + inputs) — needed for contact/newsletter sections
4. **Then**: `Video`, `YouTubeVideo` — media embeds
5. **Then**: `NavbarWrapper` — navigation
6. **Later**: `Dropdown`, `Lightbox`, remaining media types
