# Plinth Inspector — Findings

Discoveries from probing the Webflow Designer internals.
Updated: 2026-03-02

---

## WFDL (Webflow Definition Language)

The Designer uses an internal DSL called **WFDL** for element definition. It uses CSS-like curly-brace syntax (NOT HTML/JSX).

### Syntax

```
ElementType { children/properties }
```

**Valid patterns:**
- `div { }` — empty element
- `section { div { h1 { "Title" } p { "Body" } } }` — nesting
- `div.my-class { }` — class via dot notation
- `div .my-class { }` — class with space (also works)
- `image { src: "test.jpg" }` — properties via `key: value`
- `div { style { color: red } }` — inline style block
- `div { text "hello world" }` — text directive
- `div { "hello" "world" }` — quoted strings for text content
- `div { } div { }` — sibling elements

**Invalid patterns:**
- `<div />` — HTML syntax rejected
- `div#my-id { }` — `#id` syntax rejected (only `.class` works)
- `@element Section { }` — `@` directives rejected

### Element Types (87/88 validated)

Both lowercase and PascalCase work:

| Category | Elements |
|---|---|
| Layout | `section`, `container`, `div`/`block`, `grid`, `hflex`, `vflex`, `columns`, `column`, `row`, `quickstack` |
| Text | `heading`/`h1`/`h2`/`h3`, `paragraph`/`p`, `text`, `textblock`/`TextBlock`, `richtext`, `span`, `strong`, `em`, `blockquote` |
| Links | `link`/`a`, `linkblock`, `button` |
| Media | `image`/`img`, `video`, `youtube`, `map`, `lottieanimation` |
| Embed | `htmlembed` |
| Lists | `list`/`ul`/`ol`, `listitem`/`li` |
| Forms | `form`/`formblock`, `input`, `textarea`, `select` |
| Components | `navbar`/`navbarwrapper`, `slider`/`sliderwrapper`, `tabs`/`tabwrapper`, `dropdown`/`dropdownwrapper`, `lightbox`/`lightboxwrapper`, `table`/`tablewrapper` |
| PascalCase | `Section`, `Container`, `Div`, `DivBlock`, `Grid`, `HFlex`, `VFlex`, `Image`, `Link`, `Button`, `Paragraph`, `List`, `ListItem`, `FormBlock`, `SliderWrapper`, `TabWrapper` |

### API Functions

```js
wf.validateWFDL(string)     // Validate WFDL syntax without creating elements
wf.addToCanvas(string)       // Parse WFDL and add elements to current page body
wf.validateCss(string)       // Validate CSS
wf.validateStyleBlocks(obj)  // Validate style blocks
wf.exportTrainingData()      // Export styles, assets, variables (NOT page tree)
wf.generateGsapCode(a, b)   // Generate GSAP animation code
wf.el(domNode)               // Get internal element from native DOM node (NOT creation)
```

### addToCanvas Pipeline (BROKEN — bug in Webflow's code)

```
1. Parse WFDL string       → i.Qc(wfdlString)        // Returns component map AST
2. Get element expression  → u.Expressions.getElement(parsed)  // ← RETURNS NULL!
3. (never reached)         → v.HgV(components)
```

**Root cause:** `i.Qc()` returns a component/document AST, not a single Element expression.
`Expressions.getElement()` is a type-narrowing function — it returns null when the input
isn't an `EElement()` wrapper. The parser output is the wrong type for this call.

**Proof:** `getElement` works correctly elsewhere:
```js
// createEmptyDivElement — works because input is from ElementPreset.instantiateFactory
let t = a.ElementPreset.instantiateFactory(h.Bb.elementPresets.DivBlock, e).element;
return a.Expressions.getElement(t) ?? void 0;  // ← works!

// buildOneSectionFragmentFromPlugin — works because input is c.render (a component render expr)
let y = a.Expressions.getElement(c.render);  // ← works!
```

### validateWFDL Pipeline (WORKS — correct path)

```
1. Parse WFDL string           → i.Qc(wfdlString)
2. Create component map        → createComponentMapForTest(parsed, {}, plugins)
3. Serialize to JSON nodes     → m.m.create(componentMap).toJSONNodes(plugins)
4. Roundtrip back              → m.m.fromJSONNodes(pageNodes, symbolNodes, plugins)
5. Type-check each component   → u.Plugins.buildTypeCheckerState → u.inferType → u.getErrors
```

### Module Map (chunk webflow-designer.9e20d2f9f3ce1757.chunk-ep.js, module 50114)

```
a = r(960083) → getExpressionElementFromNativeElement (wf.el = a.Hy)
o = r(488337) → validateCss (wf.validateCss = o.Aw)
i = r(110970) → WFDL parser (i.Qc = parse, i.l5 = SyntaxError class)
u = r(629107) → Expressions, Component, Plugins, inferType, getErrors, matchExpression
m = r(123699) → ComponentMap (m.m.create, m.m.fromJSONNodes, .toJSONNodes, .asComponentMap)
y = r(768948) → forTestSuite.createComponentMapForTest
p = r(79543)  → r4 (plugins fallback getter)
v = r(591280) → HgV (getBody), tgb (pageId constant), Ycc (append), h6G (update components)
```

### Expression Type System (module 629107)

Expressions are a tagged union. Type-narrowing functions return null if wrong type:

```js
Expressions.getElement(expr)     → Element | null
Expressions.getRecord(expr)      → Record | null
Expressions.getList(expr)        → List | null
Expressions.getText(expr)        → string | null
Expressions.getLiteral(expr)     → Literal | null
Expressions.getElementData(expr) → data | null
Expressions.getElementId(expr)   → id | null
Expressions.getElementById(pageExpr, id) → Element | null
Expressions.getIn(expr, path)    → nested value
Expressions.setIn(expr, path, v) → updated expr
Expressions.setElementData(e, d) → updated element
Expressions.updateIn(e, path, fn) → updated expr
Expressions.everywhere(fn)(expr) → transformed expr
```

Constructors (module 953932) — all arity 1 except EHole (0):
```js
// Value expressions
EElement(e)   → wrap as Element expression  (name: "memFn" — memoized)
ERecord(obj)  → wrap as Record expression
EList(arr)    → wrap as List expression
EText(str)    → wrap as Text expression
ENumber(n)    → wrap as Number expression
EBoolean(b)   → wrap as Boolean expression
ELiteral(l)   → wrap as Literal expression
EEnum(e)      → wrap as Enum expression
EHole()       → placeholder expression (arity 0)

// Structural expressions
ECall(obj)    → function call expression  { fun, arg }
EVariable(v)  → variable reference expression
ESelect(obj)  → property select  { from, prop }
EFunction(f)  → lambda expression
EData(path)   → data binding  (array of path segments)
EExtend(e)    → record extension
ECase(e)      → pattern match case
EUnion(e)     → tagged union value
EDistinct(e)  → distinct/newtype wrapper
ETyped(e)     → type-annotated expression

// Type constructors (also in module)
TRecord, TList, TText, TRigid, TGeneric, TEnum, TUnion, TUnionWithLabels,
TTypeReference, TTypeApplication, TTypeConstructor, TRowCons, TRowEmpty, TUnknown

// Utilities
getExpressionFromAny(x) → convert arbitrary data to expression
recordOf(obj)           → create Record from plain object
enumOf(val)             → create Enum from value
unionOf(val)            → create Union from value
constructRow(...)       → build row type
constructTypeApplication(...)
functionOf(a, b)        → build function type (arity 2)
```

### Section Fragment System (module 803631)

Webflow's internal section builder — the REAL path for adding sections:

```js
// Fetch section fragments from a URL (used by marketplace/templates)
fetchSectionFragmentsFromUrl(url, siteVariables, variableCollections)

// Populate a section fragment from a "plan" object
populateSectionFragmentFromPlan(plan, fragmentLookup, slotLookup)

// Build one section fragment from a plugin component
buildOneSectionFragmentFromPlugin(name, plugin, pageId, siteVars, siteVarColls)
```

Key: `populateSectionFragmentFromPlan` takes `plan.sectionFragmentAlias` to look up a
pre-defined section fragment template, then fills its slots with content.

---

## Internal Stores (`window._webflow`)

The Designer uses a Flux-like architecture. `window._webflow` provides:

```js
_webflow.state           // All store states (ImmutableJS Records)
_webflow.dispatch(action, lane?)  // Dispatch actions (queued)
_webflow.reducer         // Root reducer function
_webflow.stores          // Store registry
_webflow.lastAction      // Last dispatched action
_webflow._dispatch       // Internal dispatch
_webflow.logFluxAction   // Action logging
_webflow.dispatcher      // { listeners, register, unregister }
_webflow.getStoreState   // Get store state
```

### Key Stores (130+ total)

| Store | Purpose | Key Data |
|---|---|---|
| **AbstractNodeStore** | **PAGE ELEMENT TREE** | `root` — full recursive node tree |
| **StyleBlockStore** | CSS classes/styles | `styleBlocks` (id→name+rules), `breakpoints`, `cssPropertyMap` |
| **DesignerStore** | Designer state | `currentPageId`, `plugins`, `components` (QualifiedMap), `fonts`, `mode` |
| **PageStore** | Page metadata | `staticPages`, `dynamicPages` (id, name, slug, SEO) |
| **UiNodeStore** | Selection state | `selectedNodeNativeId`, `hoveredNodeNativeId`, `selectionSet` |
| **AssistantStore** | AI/Copilot + **WFDL Playground** | `whtmlPlaygroundIsOpen`, `whtmlPlaygroundInput`, `siteContext` |
| **AIPageGenerationStore** | AI page gen | `homePage`, `pageGenerationRequest` |
| **NavigatorStore** | Left panel tree | `expandedNodes`, `root` |
| **AssetStore** | Uploaded assets | `assets` |
| **CssVariablesStore** | CSS variables | (design tokens) |

### AbstractNodeStore — Page Element Tree

The complete page DOM tree lives at `_webflow.state.AbstractNodeStore.root`.

Each node:
```json
{
  "id": "uuid",
  "type": "DOM",
  "children": [],
  "data": {
    "tag": "section",         // WFDL element type
    "attributes": [],         // HTML attributes
    "styleBlockIds": ["uuid"], // CSS class references
    "text": false,            // true = text node
    "slot": ""
  },
  "pluginType": "...",
  "bind": null,
  "meta": null
}
```

**Tag values** map directly to WFDL types: `section`, `divblock`, `textblock`, `h1`, `h2`, `h3`, `p`, `a`, etc.

**StyleBlockIds** resolve via `StyleBlockStore.styleBlocks[id].name` to class names like `hero-section`, `btn-primary`.

### DesignerStore.components (QualifiedMap)

Registered component *definitions* (not instances):

| Namespace | Components |
|---|---|
| Basic | `LineBreak` |
| Form | `FormButtonComponent` |
| Ssr | `Head`, `Document`, `Style`, `Script`, `Base`, `Resource` |
| __SitePlugin | `page` |

The QualifiedMap uses methods: `get(ns, key)`, `toJSON()`, `forEach()`, `_data` property.

### DesignerStore.plugins

```js
{
  elementPresets,              // Known element presets
  valuePresets,
  dataTypes,
  components,
  elementTypeToPluginNameMap,  // Maps element types to plugin names
  atoms,
  assets,
  values,
  icons,
  styleVariables,
  styleVariableCollections,
  styleBlocks,
  slugMap
}
```

---

## Current Page: Holden High School Homepage

- Page ID: `699b293b64e0274382606002`
- Site ID: `699b293b64e0274382605ff5`
- 198 nodes, 289 style blocks

### Sections (4 built)

1. **hero-section** — badge, h1, desc, sub, buttons (btn-primary, btn-secondary), quote card, scroll indicator
2. **recognition-section** — h2, intro, 6 pain-point cards (icon + text), 2 quotes
3. **approach-section** — 3 cards (icon, h3, desc, 6 bullet points each)
4. **stats-bar-section** — 6 stat items (value + label textblocks)

---

## Webpack Module Access

The Designer's main code is split across lazy-loaded chunks. The WFDL/AI code lives in
`webflow-designer.9e20d2f9f3ce1757.chunk-ep.js` (~20 MB), NOT the main designer bundle.

### Chunk Architecture

- **Main bundle:** `webflow-designer.1af48f96cc1c45a5.js` — core designer UI
- **WFDL/AI chunk:** `webflow-designer.9e20d2f9f3ce1757.chunk-ep.js` — WFDL parser, Expressions, addToCanvas, AI assistant, section fragments
- **Other chunks:** ~12 additional `chunk-ep.js` files loaded lazily
- **Non-Webflow:** analytics (Segment), Stripe — separate webpack instances

### Capturing `__webpack_require__`

All Webflow modules share a single `webpackChunk` global (not `webpackChunk_segment_analytics_next`
or `webpackChunkStripeJSouter`). Inject a fake module to capture the require function:

```js
var captured = null;
webpackChunk.push([['__probe'], {
  '__probe': function(module, exports, __webpack_require__) {
    captured = __webpack_require__;
  }
}, function(runtime) { runtime('__probe'); }]);
window.__plinthRequire = captured;
```

Once captured, load any module by ID: `captured(629107)` → Expressions module.
Store as `window.__plinthRequire` for reuse.

### Key Module IDs

| ID | Import var | Contents |
|---|---|---|
| `110970` | `i` | WFDL parser — `Qc(string)` parse, `l5` SyntaxError class |
| `629107` | `u` | Core API — `Expressions`, `Component`, `Plugins`, `inferType`, `getErrors`, `matchExpression` |
| `123699` | `m` | ComponentMap — `m.m.create()`, `.toJSONNodes()`, `.fromJSONNodes()`, `.asComponentMap()` |
| `768948` | `y` | Test utilities — `forTestSuite.createComponentMapForTest(ast, {}, plugins)` |
| `79543`  | `p` | Plugin helpers — `r4()` returns current plugins |
| `591280` | `v` | Tree operations — `HgV` (getBody), `tgb` (page QN), `Ycc` (addElementAtAnchor), `h6G` (updateComponentRender), `ptW` (generateId) |
| `960083` | `a` | DOM bridge — `Hy` = `getExpressionElementFromNativeElement` (wf.el) |
| `953932` | `o` | Expression constructors — `EElement()`, `EList()`, `EText()`, `EBoolean()`, `ELiteral()` |
| `803631` | — | Section fragments — `populateSectionFragmentFromPlan`, `fetchSectionFragmentsFromUrl` |
| `50114`  | — | The addToCanvas module — imports all above, defines `initWfAndWfUtilsGlobals`, `validateWFDL`, `addToCanvas` |

### Parser Exports (module 110970)

| Export | Name | Arity | Purpose |
|---|---|---|---|
| `Qc` | `parse` | 1 | **Expression parser** — parses a single expression from string. For curly-brace WFDL, only captures the first token as `Variable("name")`, ignoring all `{ ... }` content. |
| `AD` | `wfdl` | 1 | **Full WFDL parser** — expects an array (tokens?), not a string. `e.reduce is not a function` when given string. |
| `nm` | `wfdlType` | 1 | Type parser — same array requirement, same error. |
| `l5` | `WFDLSyntaxError` | 3 | Error constructor. |

**Critical finding:** `Qc` is NOT a WFDL parser — it's a general expression parser.
- `Qc('section { div { } }')` → `Variable("section")` (everything after first token lost)
- `Qc('Section(Div(H1("Hello")))')` → full nested `ECall` tree (parenthesized call syntax works)
- Call syntax limitations: no empty parens `Div()`, no comma-separated siblings `A(B, C)`

### toJSONNodes Only Serializes Element Expressions

`ComponentMap.toJSONNodes()` pattern-matches on the render expression type of each component:
- `Element` → produces JSON node(s) ✓
- `Variable` → 0 nodes (unresolved reference)
- `Call` → 0 nodes (unevaluated function call)

Both `Qc`-parsed WFDL (Variable) and Call-syntax (Call) produce **0 page nodes** through
`createComponentMapForTest → ComponentMap.create → toJSONNodes`. The validateWFDL "working
path" only works for type-checking, NOT for element creation.

### What DOES Produce Element Expressions

1. **`ElementPreset.instantiateFactory(preset, plugins)`** — used by `createEmptyDivElement` (see below)
2. **Pre-registered component renders** — LineBreak, FormButton, Head, etc. already have `EElement(...)` renders
3. **`fromJSONNodes(pageNodes, symbolNodes, plugins)`** — returns a `Tree` object with `_componentMap` (see below)

### Element JSON Node Format (from perComponentNodes)

```json
{
  "_id": "LineBreak",
  "type": "DOM",           // Component type name (DOM, FormButton, DangerousDOM, Section, etc.)
  "tag": "div",            // Outer tag (always "div" for DOM type?)
  "classes": [],
  "children": [],
  "data": {
    "tag": "br",           // Actual HTML tag
    "attributes": []
  }
}
```

### Element Type → Plugin Mapping (from `plugins.elementTypeToPluginNameMap`)

| Element Type | Plugin Namespace |
|---|---|
| `DOM` | `Builtin` |
| `DangerousDOM` | `Builtin` |
| `Block` | `Basic` |
| `Blockquote`, `CodeBlock`, `Emphasized`, `Figcaption`, `Figure` | `Basic` |
| `Heading`, `Image`, `Link`, `List` | `Basic` |
| `Iframe` | `Basic` |
| `SearchForm`, `SearchInput`, `SearchButton`, `SearchResult*` | `Search` |

### Element Presets (QualifiedMap — namespaced)

`plugins.elementPresets` is a QualifiedMap keyed by `(namespace, presetName)`.

**Full preset catalog** (100+ presets across 20 namespaces):

| Namespace | Presets |
|---|---|
| **Layout** | `Section`, `BlockContainer`, `QuickStack`, `Grid`, `Row`, `VFlex`, `HFlex` |
| **Basic** | `DOM`, `DivBlock`, `List`, `ListItem`, `LinkBlock`, `Button`, `Heading`, `H1`–`H6`, `Paragraph`, `TextLink`, `TextBlock`, `Blockquote`, `RichText`, `CodeBlock`, `Image` |
| **Form** | `FormForm`, `FormBlockLabel`, `FormTextInput`, `FormFileUploadWrapper`, `FormTextarea`, `FormCheckboxInput`, `FormRadioInput`, `FormSelect`, `FormReCaptcha`, `FormButton`, `FormButtonComponent` |
| **Embed** | `HtmlEmbed`, `Video`, `YouTubeVideo` |
| **Widget** | `MapWidget`, `Facebook`, `Twitter` |
| **Slider** | `SliderWrapper` |
| **Tabs** | `TabsWrapper` |
| **Dropdown** | `DropdownWrapper` |
| **Navbar** | `NavbarWrapper` |
| **Lightbox** | `LightboxWrapper` |
| **Animation** | `Animation`, `Spline`, `Rive` |
| **BackgroundVideo** | `BackgroundVideoWrapper` |
| **Search** | `SearchForm` |
| **Pagination** | `Pagination` |
| **Localization** | `LocalesWrapper` |
| **PageBuilding** | `DropTarget` |
| **Dynamo** | `DynamoWrapper` |
| **Users** | `UserAccountSubscriptionList`, `UserLogOutLogIn`, `SignUp`, `LogIn`, `UserAccount`, `ResetPassword`, `UpdatePassword` |
| **Slots** | `Slot` |
| **Commerce** | 17 checkout/cart/payment presets |
| **PrebuiltLayouts** | 30+ full templates: `LayoutHero*`, `LayoutNavbar*`, `LayoutTeam*`, `LayoutLogos*`, `LayoutGallery*`, `LayoutFeatures*`, `LayoutPricing*`, `LayoutTestimonial*`, `LayoutFooter*` |

**Important:** `QualifiedMap.get(namespace, name)` does NOT work for element presets! Must use `.forEach()` to iterate and capture preset objects.

Each preset has methods:
```js
ElementPreset.instantiateFactory(preset, plugins) → { element, ... }
ElementPreset.create(...)
ElementPreset.name(preset)       → qualified name
ElementPreset.getLabel(preset)   → display label
ElementPreset.getIcon(preset)    → icon identifier
ElementPreset.getCategory(preset)
ElementPreset.getStyleVariables(preset)
ElementPreset.getAssets(preset)
ElementPreset.getInteractions(preset)
ElementPreset.isExpressionEscapeHatchFactory(preset) → boolean
```

`instantiateFactory` is the **proven path** for creating Element expressions. This is what
`createEmptyDivElement` uses internally:
```js
let t = ElementPreset.instantiateFactory(plugins.elementPresets.DivBlock, plugins).element;
let el = Expressions.getElement(t);  // ← works! Returns an actual Element
```

### Tree Operations (module 591280) — Key Functions

| Export | Real Name | Arity | Purpose |
|---|---|---|---|
| `HgV` | `getBody` | 1 | Get page body Element expression. **Arg: component map** (DesignerStore.components) |
| `Ycc` | `addElementAtAnchor` | 4 | **Add element to canvas** — the core insertion function |
| `h6G` | `updateComponentRenderInComponentMap` | 3 | Update a component's render expression |
| `tgb` | (constant) | — | `"__SitePlugin,page"` — the page qualified name |
| `ptW` | (suspected) | — | ID generator (TBD) |

**200+ total exports** — most are minified names. Only the above are identified.

**`addElementAtAnchor` (Ycc) source:**
```js
(e, t, n, r) => {
  let i = a.Expressions.findPath(e, e => y(e) === n.id);
  return i ? C[r](e, i, t) : e;
}
```
- `e` = expression tree (page render)
- `t` = element expression to insert
- `n` = `{id: "..."}` — anchor element (find by ID in tree)
- `r` = position key into `C` object — confirmed values: `"before"`, `"after"` (from `addElementAtAnchorInPath` source)
- Returns updated expression tree (immutable — does NOT mutate)
- Uses `Expressions.findPath` to locate the anchor, then `C[r]` to insert relative to it

**`addElementAtAnchorById` (JlZ) source:**
```js
(e, t, n, r) => {
  let i = a.Expressions.findPath(e, e => y(e) === n);
  return i ? C[r](e, i, t) : e;
}
```
Simpler variant — `n` is a string ID directly (not `{id}`), otherwise identical.

**`addElementAtAnchorInPath` (_Wb, arity 7) source (partial):**
```js
(e, t, n, r, i, o, l) => a.Expressions.findPath(e, e => y(e) === n.id)
  ? "before" !== r && "after" !== r && isUserComponentInst(o, n)
    ? null === i ? e : a.Expressions.updateElement(n, ...)
    : ...
```
- Position strings confirmed: `"before"` and `"after"`
- Extra args `o`, `l` handle user component instances
- Falls back to `Expressions.updateElement` for component insertion

**Page body IS an Element (type `["Body","Body"]`):**
```js
var pageComp = dsComponents.get(["__SitePlugin", "page"]);
var pageRender = Component.getRender(pageComp);
// pageRender.type === "Element" ✓, Expr.getElement(pageRender) works ✓
// Element type = ["Body", "Body"]
// Element id = "699b293b64e0274382606007"
```

**Body element data structure** (direct property access, NOT via getElementData which returns undefined):
```js
bodyEl.data = {
  type: "Record",
  val: {
    children: {
      type: "List",
      val: [
        { type: "Element", val: { id: "b163afb6-...", type: ["Builtin","DOM"], data: {...} } },
        // ...more child elements (page sections)
      ]
    }
  }
}
```
Access children via: `bodyEl.data.val.children.val`

### Element Construction Patterns (from probe #6)

Two internal functions reveal the exact pattern for building Element expressions:

**`generateNewTabsPaneExpression` (Z0l, arity 2):**
```js
(e, t) => a.Expressions.getElement(
  (0, ej._K)(
    (0, e$.Y)(
      (0, u.EElement)({
        id: "Tabs Pane",
        type: (0, i.qualify)(...),
        ...
      })
    )
  )
)
```
Pattern: `EElement({id, type: qualify(...)})` → wrapper transforms → `getElement()` → Element expression

**`createIntegratedComponent` (MZ_, arity 1):**
```js
function createIntegratedComponent(e) {
  return a.Component.create({
    render: u.EElement({
      id: e.render.id,
      data: u.ERecord({...eB, ...e.render.data}),
      type: e.render.type,
      ...
    }),
    ...
  });
}
```
Pattern: `Component.create({render: EElement({id, data: ERecord({...defaultData, ...customData}), type})})` — creates full component definition from element config.

**Key insight:** The `qualify` function converts raw type strings into qualified type identifiers. Finding this function is critical for constructing elements from scratch.

### Flux Architecture (from probe #6)

**Dispatch system:**
- 157 Flux stores
- `_webflow.dispatch(action, lane?)` — lane is optional priority (default 0)
- Queued dispatch: actions are pushed to a queue and processed sequentially
- `_webflow.lastAction` shows: `{type: "POST_MESSAGE_RECEIVED", keys: [type, payload, timestamp, state]}`

**DataStore (typical store) methods:**
`displayName`, `state`, `committedState`, `changeCallbacks`, `scheduledNoLaneFlush`, `pendingFlushCallbacks`, `getMetricsContext`, `onChange`, `onChangeSync`, `emitChange`, `onNextFlush`, `flushLane`, `invokeChangeCallback`, `flushNoLane`

### AD Parser — Template System

The `AD` (wfdl) parser produces **template placeholder variables**, not element expressions:
```
AD(['section', '{', 'div', '{', '}', '}'])
  → Variable("section_wfdl_template_placeholder_0")

AD(['h1', '{', '"Hello"', '}'])
  → Variable("h1_wfdl_template_placeholder_0")
```

The curly-brace content defines template slots. The placeholder suffix `_wfdl_template_placeholder_N` indicates the Nth slot. The class `.` syntax becomes a `Select` expression (property access). This is a template/macro system — element names become template variable references that need to be resolved against element presets by a separate compilation step.

### fromJSONNodes Returns a Tree (NOT QualifiedMap)

```js
var tree = compMap.m.fromJSONNodes(pageNodes, symbolNodes, plugins);
// tree.constructor.name === "Tree"
// tree._componentMap  → the actual QualifiedMap
// tree.__DEPRECATED__getElementContentNodes  → legacy accessor
```

To roundtrip or merge, extract `tree._componentMap` first:
```js
var innerMap = tree._componentMap;      // QualifiedMap
var cm = compMap.m.create(innerMap);    // ComponentMap instance
var nodes = cm.toJSONNodes(plugins);    // { pageNodes, symbolNodes }
```

### AD Parser Accepts String Token Arrays

`parser.AD` (wfdl) accepts arrays of string tokens:
```js
parser.AD(['section', '{', '}'])  // → Variable("section") — parsed but minimal
```
But errors with non-string arrays:
- `AD([Qc("section")])` → "Unexpected token type: identifier, expected: 'next' or 'right-bracket'"
- `AD([{type:'identifier'}])` → same error

Need to test with **full nested token arrays** to see if the WFDL grammar produces Element expressions
(not just Variables). E.g. `['section', '{', 'div', '{', '}', '}']`

---

## Gotchas & Dead Ends

1. **postMessage from MAIN world** — Messages sent via `window.postMessage()` from a MAIN-world content script are NOT recognized by the Designer's JSON-RPC handler. It only trusts messages from registered extension iframes. Cannot create elements this way.

2. **`wf.el()` is NOT element creation** — It's `getExpressionElementFromNativeElement(domNode)`. Takes a DOM node, returns internal representation. Not useful for creation.

3. **`wf.exportTrainingData().components` is empty** — Returns styles, assets, variables but the `components` key is always `{}`. The page tree is NOT here.

4. **QualifiedMap `.size` returns `{}`** — The `.size` property is likely a getter that doesn't serialize. Use `.toJSON()` or `._data` instead.

5. **QualifiedMap `.forEach()` fails** — `"e is not a function"` error when called directly. The method signature may differ from standard forEach.

6. **DesignerStore is ImmutableJS** — `Object.keys(ds)` returns `["_map", "__ownerID"]`. Must use `.toJSON()`, `.keySeq()`, `.get()` to access real data.

7. **navigator.clipboard blocked in DevTools panels** — Must use `document.execCommand('copy')` with hidden textarea fallback.

8. **WFDL `#id` syntax** — `div#test-id { }` rejected: "Unexpected character: #". Only `.class` dot notation works.

9. **Playground dispatch** — `SET_WHTML_PLAYGROUND_IS_OPEN` didn't flip the state. The correct action type is unknown. Need to search the reducer source.

10. **`Qc` parser ignores curly braces** — `Qc('section { div { h1 { "Hello" } } }')` returns `Variable("section")`. All nesting is silently dropped. `Qc` is an expression parser, not the WFDL grammar parser.

11. **Call-syntax through createComponentMapForTest → 0 page nodes** — Even though `Section(Div(H1("Hello")))` produces a full nested `ECall` AST, `toJSONNodes` can't serialize Call expressions. Only `Element` type expressions produce JSON nodes.

12. **`testSuite.toAST()` is not a tokenizer** — Expects parsed expression objects, not strings. Error: "matchExpression received an expression of type \"undefined\"..."

13. **Call syntax limitations** — No empty parens: `Div()` → "Unexpected token: right-paren". No comma siblings: `A(B, C)` → "No matching closing parenthesis". Only single-child chains work: `A(B(C("text")))`.

14. **`fromJSONNodes` returns Tree, not QualifiedMap** — `compMap.m.create(tree)` fails with "e.get is not a function". Must extract `tree._componentMap` first.

15. **`HgV()` with no args** — "Cannot read properties of undefined (reading 'get')" at `PageComponent_getPageComponentFromComponentMap`. Must pass DesignerStore.components as argument.

16. **`testSuite.toBin()` is not a tokenizer** — Errors with "matchExpression received an expression of type \"undefined\"". Like `toAST`, it expects expression objects.

17. **`QualifiedMap.get(ns, name)` fails for element presets** — Returns null for `ep.get('Basic', 'DivBlock')` even though `ep.forEach()` lists it. Must capture presets via iteration.

18. **`fromJSONNodes` with hand-crafted nodes → empty map** — Our node format was wrong. The inner `_componentMap` had 0 namespaces, 0 components. Need to match the exact format Webflow expects.

19. **AD parser is a template system, not element constructor** — All results are `Variable("name_wfdl_template_placeholder_0")`. The curly-brace blocks define template slots, not direct element trees.

20. **Page body is `["Body","Body"]` type** — Not `Element`. `Expressions.getElement(body)` returns null. `addElementAtAnchor` needs a way to work with this type.

21. **`instantiateFactory(preset, arg)` — second arg is a string array** — Previously failed with `"e.slice is not a function"`. Probe #8 discovered: pass ANY string array (e.g. `['']`). OLD failures:
    - Most presets (Section, DivBlock, Heading, Paragraph, Button, TextBlock, LinkBlock): `"e.slice is not a function"` — the second arg needs `.slice()` (array-like)
    - Image preset: `"The elementPreset factory provided utilizes an escapeHatch function but no escapeHatchOptions were provided."` — needs a special escapeHatchOptions arg
    - Probe #7 will test `[]`, `{}`, `null`, no arg, and `plugins.styleVariables` as alternatives

22. **Module 50114 is empty** — `Object.keys(r(50114))` returns `[]`. Module ID changed between chunk versions.

23. **`Expr.getElementData(bodyRender)` returns undefined** — Cannot use `getElementData` or `getIn` on the page body expression. Must access data via direct property: `bodyEl.data.val.children.val` to get the children list.

24. **`toSource` fails on instantiated presets** — "Property value expected type of string but got array" — the `type` field (a 2-element array) confuses the serializer. Elements are valid despite this error.

25. **Preset element type mapping** — Presets map to element types differently than expected:
    - Button preset → `["Basic", "Link"]` (not Button!)
    - TextBlock preset → `["Basic", "Block"]` (same as DivBlock)
    - Section preset → `["Layout", "Section"]`
    - DivBlock preset → `["Basic", "Block"]`

---

## BREAKTHROUGH — Probe #8 Results

### qualify = `[pluginName, componentName]` (a plain 2-element array)

```js
Component.name("page")     → "page"      // just returns the string
Plugins.name("Basic")      → "Basic"     // just returns the string
qualify(pn, cn)             → [pn, cn]    // just an array!
tgb                        → ["__SitePlugin", "page"]  // Array, ctor: Array
```

Qualified names are 2-element string arrays. `QualifiedMap.get(["ns", "name"])` works.

### Element type field = `[pluginNamespace, typeName]`

From existing components:
| Component QN | Element Type |
|---|---|
| `Basic,LineBreak` | `["Builtin", "DOM"]` |
| `Form,FormButtonComponent` | `["Form", "FormButton"]` |
| `Ssr,Head` | `["Builtin", "DOM"]` |
| `Ssr,Style` | `["Builtin", "DangerousDOM"]` |
| `__SitePlugin,page` | `["Body", "Body"]` |

### instantiateFactory WORKS — second arg is a string array (content irrelevant)

```js
EP.instantiateFactory(divPreset, [''])  → { element, idMap }
// element.type = "Element", Expr.getElement(element) → valid!
// element type = ["Basic", "Block"]
```

ALL string arrays work: `['']`, `['div']`, `['anything']`, `['','']`. The string array is passed
through `Y(template)(stringArray)` — for non-escapeHatch presets, the factory is a static template
object and the strings are used to fill placeholder IDs (simple presets have none).

**instantiateFactory source:**
```js
(e, t, n) => {
  let o = isExpressionEscapeHatchFactory(e);
  if (!o && n) throw TypeError("...escapeHatch not required");
  if (o && !n) throw TypeError("...escapeHatchOptions not provided");
  let l = e.factory;              // raw template (object, not function)
  let i = o ? l(n) : l;          // non-escapeHatch: just use the template
  let s = (0, a.Y)(i)(t);        // Y(template)(stringArray) → processed expression
  return {
    element: (0, r._K)(s),       // _K: assign unique IDs
    idMap: (0, r.Xi)(s).idMap    // Xi: extract ID mapping
  };
}
```

### Direct EElement construction WORKS with any type format

```js
EElement({id: 'test', type: ['Basic', 'Block'], data: ERecord({tag: EEnum('div'), children: EList([])})})
// toSource → EElement({ id: "test", type: qualify(Plugins.name("Basic"), Component.name("Block")), ... })
```

All formats work: string `'Block'`, array `['Basic','Block']`, CSV `'Basic,Block'`, tgb constant, copied type.

---

## Viable Paths Forward (as of probe #8)

### Path A: instantiateFactory → addElementAtAnchor → dispatch (ALL PIECES FOUND)

Every step is now proven to work individually:

1. **Capture presets** via `ep.forEach()` ✓
2. **`EP.instantiateFactory(preset, [''])`** → `{element, idMap}` ✓ — second arg = any string array
3. **`addElementAtAnchor(pageRender, newElement, {id: anchorId}, "after")`** → updated render ✓ — position strings confirmed
4. **`updateComponentRenderInComponentMap(components, tgb, updatedRender)`** → updated map ✓
5. **Dispatch** — `_webflow.dispatch(action)` available, exact action type TBD (probe #9)

**Also works:** `addElementAtAnchorById(render, element, idString, "after")` — simpler variant.
**Also works:** Direct `EElement({id, type: ['ns','name'], data: ERecord({...})})` construction.

### Remaining unknown: Flux dispatch action type
Need to find the action type string that tells the DesignerStore to accept updated components.

---

## Probe #9–10 Results

### Full Insertion Pipeline Tested (probe #10)

All 5 steps execute without errors:
1. **Body children accessed**: 4 children found via `bodyEl.data.val.children.val`
   - All type `["Builtin", "DOM"]` (the page's existing sections wrapped in DOM containers)
2. **Section created**: `EP.instantiateFactory(sectionPreset, [''])` → valid Element, type `["Layout", "Section"]`
3. **addElementAtAnchor succeeded**: `insertion: { success: true, changed: true }`
4. **updateComponentRenderInComponentMap succeeded**: `compMapUpdate: { success: true, changed: true }`
5. **Direct state mutation executed**: `dsStore.state = newState; emitChange()` — no errors

**But the section did NOT appear on canvas.** Direct DesignerStore state mutation is insufficient —
the change needs to propagate through the full Flux dispatch cycle to update AbstractNodeStore
and trigger canvas re-render.

### Action Creators (probe #10)

`_webflow.creators` contains 30+ namespaced action creator objects:

| Namespace | Purpose |
|---|---|
| **UiNodeActionCreators** | Element selection, insertion, manipulation |
| **OutlineActionCreators** | Navigator/outline panel |
| **NavigatorActionCreators** | Navigator tree |
| **PageActionCreators** | Page operations |
| **DragDropActionCreators** | Drag & drop operations |
| **StyleActionCreators** | CSS style changes |
| **UndoRedoActionCreators** | Undo/redo |
| **UiActionCreators** | General UI state |

Each is an object containing action creator methods (not a function itself).
**UiNodeActionCreators** is the most likely home for element insertion actions.

### Reducer Structure (probe #10)

- Reducer length: 14,443 chars
- Uses `ec` variable for DesignerStore result (passed as `ec.components` to other store reducers)
- Action types found in reducer: `UNDO`, `REDO`, `ROOT_SYMBOL_NODE_ADDED`, `DYN_ITEM_SAVED`, `DYN_ITEM_SAVED_AND_PUBLISHED`, `DYN_ITEM_DELETED`, `BULK_ITEM_DRAFTING_COMPLETED`, `FINISHED`
- DesignerStore state is ImmutableJS (has `.set()` method)

### `_webflow` Global Properties (probe #9)

```js
_webflow.creators       // Action creator namespaces (30+)
_webflow._store         // Internal store reference
_webflow.getState()     // Get full state
_webflow.queue          // Dispatch queue
_webflow.dispatching    // Boolean — currently dispatching?
_webflow.__element      // Unknown
_webflow.runtimeEnvironment
_webflow._persistentUIState
```

### Dispatch Source Decoded (probe #9)

```js
// dispatch(action, lane?) — public API
function(action) {
  let lane = arguments[1] || 0;
  e.queue.push({action, lane});
  if (!e.dispatching) {
    e.dispatching = true;
    while (e.queue.length > 0) {
      let item = e.queue.shift();
      e._dispatch(item.action, item.lane);
    }
    e.dispatching = false;
  }
}

// _dispatch(action, lane) — internal
// - Validates: no 'timestamp' or 'state' keys on action
// - Augments: {...action, timestamp: Date.now(), state: currentState}
// - Sets e.lastAction = augmented
// - Calls reducer, updates state
```

### Preset Data Structures (probe #10)

| Preset | Type | Data Fields | Notes |
|---|---|---|---|
| **Section** | `["Layout","Section"]` | `grid`, `tag: Enum("section")`, `children: List([])` | `grid` has type info |
| **DivBlock** | `["Basic","Block"]` | `tag: Enum("div")`, `text: Boolean(false)`, `children: List([])` | `text: false` = not text block |
| **Heading** | `["Basic","Heading"]` | `tag: Enum("h1")`, `children: List([String child])` | Default text = "Heading" |
| **Paragraph** | `["Basic","Paragraph"]` | `children: List([String child])` | Default text = "Lorem ipsum..." |
| **Button** | `["Basic","Link"]` | `button: Boolean(true)`, `block`, `search`, `eventIds`, `children`, `link: Literal({mode:"external",url:"#"})` | Button = Link + `button:true` |
| **TextBlock** | `["Basic","Block"]` | `text: Boolean(true)`, `tag: Enum("div")`, `children: List([String child])` | Same type as DivBlock, `text: true` |
| **HFlex** | `["Layout","HFlex"]` | `children: List([])`, `tag: Enum("div")` | |

**Text content** is stored as child `Element` with type `["Basic","String"]` and data as `Text` expression:
```js
{ type: "Element", val: { id: "aN", type: ["Basic","String"], data: { type: "Text", val: "Button Text" } } }
```
The `"aN"` ID is a placeholder — `_K` replaces it with a UUID.

### Why Direct Mutation Failed

The DesignerStore state was updated, but:
1. **AbstractNodeStore** has its own state — it's NOT derived from DesignerStore
2. The **canvas renderer** reads from AbstractNodeStore, not DesignerStore directly
3. Only a proper dispatched action triggers the full reducer chain that updates ALL dependent stores
4. `emitChange()` only notifies DesignerStore listeners, not the cross-store pipeline

**Next step:** Spy on dispatched actions when manually adding an element to discover the correct action type.

---

## BREAKTHROUGH — Probe #15: ELEMENT_ADDED Dispatch (WORKING)

Successfully dispatched `ELEMENT_ADDED` to create elements on canvas. This is the real path the Designer uses internally when drag-dropping an element from the Add panel.

### Full Drag-Drop Action Sequence

When a user drags an element from the Add panel onto the canvas, the Designer dispatches these actions in order:

```
NODE_DRAG_STARTED
HANDLE_DRAG (×N — fires repeatedly during drag movement)
DROP_PARENT_NODE_UPDATED
UPDATE_DRAG_DROP_DEBUG_DATA
ELEMENT_ADDED          ← the one that actually creates the element
DRAG_STOP
AUDIT_QUEUED (×N)
```

Only `ELEMENT_ADDED` is needed for programmatic element creation. The drag/drop actions are UI state only.

### Working Payload Structure

```js
_webflow._dispatch({
  type: "ELEMENT_ADDED",
  payload: {
    element:           rawElement,        // UNWRAPPED {id, type, data} — see gotchas below
    position:          "append",          // "append" = child of anchor; NOT "before"/"after" (sibling)
    anchorId:          bodyElementId,     // string — Body element ID for page-root insertion
    elementPreset:     ["Basic", "DivBlock"],  // qualified name ARRAY, not the preset descriptor
    initialStyleBlockId: crypto.randomUUID(),  // UUID string (not null)
    designerState:     _webflow.state.DesignerStore,
    styleBlockState:   _webflow.state.StyleBlockStore,
    uiNodeState:       _webflow.state.UiNodeStore,
    componentMapPatch: null,             // null works for simple elements
    idMap:             { placeholderId: "realUuidString" }  // values must be strings, NOT arrays
  }
})
```

### Key Gotchas

1. **Element must be UNWRAPPED (raw `{id, type, data}`)** — `instantiateFactory` returns an expression-wrapped element `{type: "Element", val: {id, type, data}}`. You must unwrap it via `Expr.getElement(element)` which returns the inner `{id, type, data}` object. Dispatching the expression-wrapped form **crashes the page**.

2. **Element ID must be a STRING, not an array** — `instantiateFactory` returns array IDs in the `idMap` which must be converted. The element's own `id` field must also be a plain string.

3. **Position is `"append"` (child of anchor), not `"before"`/`"after"` (sibling)** — for appending to the page body or inside a container, use `"append"`. The `"before"` and `"after"` positions are for sibling insertion relative to the anchor.

4. **`anchorId` is the BODY element ID when appending to page root** — get it from the page body expression (e.g. `699b293b64e0274382606007`).

5. **`elementPreset` is a qualified name ARRAY `["Basic", "DivBlock"]`** — NOT the preset descriptor object from `plugins.elementPresets`. Just the 2-element namespace/name array.

6. **`initialStyleBlockId` should be a UUID (not null)** — use `crypto.randomUUID()`. Null may cause issues with style assignment.

7. **`designerState`, `styleBlockState`, `uiNodeState` are just references to current `_webflow.state.*` objects** — pass the live store states directly.

8. **`componentMapPatch: null` works** — at least for simple non-component elements. Components may need a real patch.

9. **`idMap` values must be strings, not arrays** — `instantiateFactory` may return array-valued IDs; convert them to strings before including in the payload.

### Working Code Pattern

```js
// 1. Capture modules
var Expr = __plinthRequire(629107).Expressions;
var ctors = __plinthRequire(953932);
var EElement = ctors.EElement;

// 2. Create element via instantiateFactory
var preset = /* captured DivBlock preset via ep.forEach() */;
var EP = __plinthRequire(/* ElementPreset module */);
var result = EP.instantiateFactory(preset, ['']);
var rawElement = Expr.getElement(result.element);  // UNWRAP — critical!

// 3. Fix idMap (convert array values to strings)
var idMap = {};
for (var [k, v] of Object.entries(result.idMap)) {
  idMap[k] = Array.isArray(v) ? v[0] : v;
}

// 4. Dispatch
_webflow._dispatch({
  type: "ELEMENT_ADDED",
  payload: {
    element: rawElement,
    position: "append",
    anchorId: "699b293b64e0274382606007",  // Body element ID
    elementPreset: ["Basic", "DivBlock"],
    initialStyleBlockId: crypto.randomUUID(),
    designerState: _webflow.state.DesignerStore,
    styleBlockState: _webflow.state.StyleBlockStore,
    uiNodeState: _webflow.state.UiNodeStore,
    componentMapPatch: null,
    idMap: idMap
  }
});
```

### Dispatch Spy Technique

**Use `_webflow._dispatch`, NOT `_webflow.dispatch`**, when patching to spy on actions:

```js
var orig = _webflow._dispatch.bind(_webflow);
_webflow._dispatch = function(action, lane) {
  console.log('[ACTION]', action.type, action);
  return orig(action, lane);
};
```

Patching `_webflow.dispatch` misses actions dispatched from bound action creator references (they hold a closure over the original `_dispatch`). Patching `_dispatch` directly catches ALL actions regardless of call site.

---

## Builder UI — All 10 Element Types Confirmed Working

All 10 core element types successfully create on canvas via `ELEMENT_ADDED` dispatch.

### Element Construction Pattern

```js
// Universal pattern for all element types:
EElement({id: string, type: array, data: ERecord(...)})
  → Expr.getElement()   // unwrap to raw {id, type, data}
  → dispatch ELEMENT_ADDED with raw element
```

### Text Content Pattern

For Heading, Paragraph, Button, and TextBlock, text content is stored as a child element:

```js
// Children list contains a String element:
EElement({
  id: stringId,
  type: ['Basic', 'String'],
  data: EText('content')
})
```

### Section Grid Data

Section requires a `grid` field in its data record:

```js
ERecord({
  grid: ERecord({ type: EText('section') }),
  tag: EEnum('section'),
  children: EList([])
})
```

### Data Fields by Element Type

| Element Type | Type Array | Data Fields |
|---|---|---|
| **Section** | `["Layout","Section"]` | `grid: ERecord({type: EText('section')})`, `tag: EEnum('section')`, `children: EList([])` |
| **DivBlock** | `["Basic","Block"]` | `tag: EEnum('div')`, `text: EBoolean(false)`, `children: EList([])` |
| **Heading** | `["Basic","Heading"]` | `tag: EEnum('h1')` through `EEnum('h6')`, `children: EList([StringChild])` |
| **Paragraph** | `["Basic","Paragraph"]` | `children: EList([StringChild])` |
| **Button** | `["Basic","Link"]` | `button: EBoolean(true)`, `block: EText('')`, `search: ...`, `eventIds: ...`, `children: EList([StringChild])`, `link: ELiteral({mode:'external',url:'#'})` |
| **TextBlock** | `["Basic","Block"]` | `text: EBoolean(true)`, `tag: EEnum('div')`, `children: EList([StringChild])` |
| **HFlex** | `["Layout","HFlex"]` | `tag: EEnum('div')`, `children: EList([])` |
| **VFlex** | `["Layout","VFlex"]` | `tag: EEnum('div')`, `children: EList([])` |
| **Grid** | `["Layout","Grid"]` | `tag: EEnum('div')`, `children: EList([])` |
| **Link** | `["Basic","Link"]` | `children: EList([])` |

*StringChild* = `EElement({id, type: ['Basic','String'], data: EText('content')})`

### idMap Key Names

The `idMap` returned by `instantiateFactory` uses these key names (note inconsistencies):

| Key Name | Notes |
|---|---|
| `"Div Block"` | Space-separated (NOT "DivBlock") |
| `"TextBlock"` | No space |
| `"HFlex"` | |
| `"VFlex"` | |
| `"Link Block"` | Space-separated |
| `"Section"` | |
| `"Heading"` | |
| `"Paragraph"` | |
| `"Button"` | |
| `"Grid"` | |

---

## Architecture: Content Script Bridge

### Current Architecture (CMS Queue)

```
Claude → MCP Server → Webflow CMS API (write queue item)
  → Designer Extension (polls CMS, foregrounded) → wf.addToCanvas() / ELEMENT_ADDED dispatch
```

- Extension must be foregrounded (iframe visible in Designer panel)
- CMS queue adds latency (polling interval + API round trips)
- Extension uses postMessage bridge between iframe and Designer context

### Proposed Architecture (Content Script Bridge)

```
Claude → MCP Server → WebSocket → Content Script (MAIN world) → ELEMENT_ADDED dispatch
```

### What This Eliminates

- **CMS queue polling** — direct WebSocket push instead of CMS read/write cycle
- **Extension iframe requirement** — content script runs in page context, not an iframe
- **Foregrounding requirement** — MAIN world scripts execute regardless of which panel is open
- **postMessage bridge** — content script has direct access to `_webflow._dispatch` and all internal APIs

### How It Works

- Chrome extension injects a content script with `world: "MAIN"` into the Webflow Designer page
- Content script captures `__plinthRequire` via webpack chunk injection on load
- MCP server opens a WebSocket connection to the content script (or vice versa via a local relay)
- Claude sends build commands through MCP → WebSocket → content script dispatches `ELEMENT_ADDED` directly
- Designer Extension remains installed as a fallback for operations not yet reverse-engineered

### Still Need to Probe

These dispatch actions / action creators have NOT been reverse-engineered yet:

| Action Creator Namespace | Purpose | Status |
|---|---|---|
| **StyleActionCreators** | CSS class creation, style property updates | Not probed |
| **BindingContextActionCreators** | CMS data binding to elements | Not probed |
| **CollectionActionCreators** | CMS collection operations | Not probed |
| **CollectionFieldActionCreators** | CMS field operations | Not probed |
| **PageActionCreators** | Save, publish, page settings | Not probed |

### Designer Extension as Fallback

The existing Designer Extension architecture remains for:
- Operations not yet reverse-engineered (styles, CMS bindings, save/publish)
- Sites where the Chrome extension is not installed
- Any future Webflow API changes that break the dispatch approach
