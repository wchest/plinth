# Wix Editor Internals — Research Findings

## Discovery: Document Services API

The Wix Studio editor exposes a full **Document Services API** inside the preview iframe.

### Access Path
```js
const previewFrame = document.querySelector('iframe[name="preview-frame"]');
const ds = previewFrame.contentWindow.documentServices;
```

This is accessible from a content script running in MAIN world on `editor.wix.com`.

### Confirmed Capabilities (Read + Write)

**Components** — full CRUD:
- `ds.components.add(containerRef, structure)` — add a component (CONFIRMED WORKING)
- `ds.components.remove(compRef)` — remove a component (CONFIRMED WORKING)
- `ds.components.getType(compRef)` — get component type
- `ds.components.getAllComponents(pageRef)` — list all components
- `ds.components.getChildren(compRef)` — get children
- `ds.components.getContainer(compRef)` — get parent
- `ds.components.duplicate(compRef)` — duplicate
- `ds.components.buildDefaultComponentStructure(type)` — build default structure for a type

**Component Data/Style/Layout/Design**:
- `ds.components.data.get(compRef)` / `.update(compRef, data)`
- `ds.components.style.get(compRef)` / `.update(compRef, style)`
- `ds.components.layout.get(compRef)` / `.update(compRef, layout)`
- `ds.components.design.get(compRef)` / `.update(compRef, design)`

**Pages**:
- `ds.pages.getPageIdList()` — list all page IDs
- `ds.pages.getCurrentPageId()` / `getFocusedPageId()`
- `ds.pages.data.get(pageId)` — get page data (title, SEO, etc.)
- `ds.pages.add(...)` — add a page
- `ds.pages.duplicate(...)` — duplicate a page
- `ds.pages.remove(...)` — remove a page

**Theme**:
- `ds.theme.colors` — color management
- `ds.theme.fonts` — font management
- `ds.theme.styles` — style management
- `ds.theme.textThemes` — text theme management

**Other APIs**:
- `ds.breakpoints` — responsive breakpoints
- `ds.cssStyle` — CSS style management
- `ds.customCSS` — custom CSS
- `ds.history` — undo/redo
- `ds.site` — site-level settings (width, scroll, etc.)
- `ds.media` — media management
- `ds.importExport` — import/export components, fragments, pages
- `ds.fonts` — font management
- `ds.ai` — AI features
- `ds.accessibility` — a11y features

### Component Ref Format
```js
{ id: 'comp-kd5px9q0', type: 'DESKTOP' }
```

### Component Structure Format (for add)
```js
{
  componentType: 'wysiwyg.viewer.components.WRichText',
  data: {
    type: 'StyledText',
    text: '<p class="font_0">Hello from Plinth!</p>',
  },
  layout: {
    width: 300,
    height: 50,
    x: 100,
    y: 100,
  },
}
```

### Known Component Types
- `responsive.components.Section` — page section
- `responsive.components.HeaderSection` — header
- `responsive.components.FooterSection` — footer
- `wysiwyg.viewer.components.WRichText` — rich text
- `wysiwyg.viewer.components.VectorImage` — vector/SVG image
- `wysiwyg.viewer.components.MenuContainer` — menu
- `wysiwyg.viewer.components.ExpandableMenu` — expandable menu
- `wysiwyg.viewer.components.FooterContainer` — footer container
- `wysiwyg.viewer.components.RefComponent` — reference/linked component
- `core.components.Image` — image
- Many more in `ds.components.COMPONENT_DEFINITION_MAP`

## Architecture Notes

### Editor Structure
- **Main frame** (`editor.wix.com`): React app using "repluggable" micro-frontend framework
- **Preview frame** (`iframe[name="preview-frame"]`): Renders the site, hosts `documentServices`
- **Preset preview frame** (`iframe[name="preset-preview-frame"]`): Wider frame for presets

### Key Globals (main frame)
- `window.editorModel` — site metadata (metaSiteId, version, permissions, topology)
- `window.__textManager` — text editor API (copy, paste, undo, redo)
- `window.__previewFrameData` — preview frame reference
- `window.Redux`, `window.ReactRedux`, `window.React` — framework globals
- `window.WixDesignSystem` — Wix Design System UI components
- `window.EDITOR_EXPERIMENT_MODULE` — feature flags

### Key Globals (preview frame)
- `documentServices` — THE main API (full read-write)
- `documentServicesHeadless` — headless variant
- `documentServicesReadOnly` — read-only variant
- `documentServicesModel` — underlying model
- `rendererModel` — renderer configuration
- `santaModels` — Santa framework models
- `getViewerApi` — viewer API accessor
- `viewerModel` — viewer configuration

### State Management
- **MobX** for reactive state (`__mobxGlobals`, `__mobxInstanceCount`)
- **Redux** store accessible via React fiber tree (depth 2 from `#root`)
- **Repluggable** shell system for micro-frontend module loading
  - `$installedShells` lists all loaded modules
  - APIs registered via `contributeAPI`, accessed via `getAPI` with Symbol keys

### Authentication
- Editor uses session-based auth (cookies)
- `editorModel.permissionsInfo` contains user roles and permissions
- `editorModel.metaSiteId` is the site identifier

## Content Script Bridge Strategy

For Plinth integration, the content bridge should:

1. **MAIN world script** on `editor.wix.com/studio/*`:
   - Access `documentServices` via the preview iframe
   - Implement command handlers (add_component, remove_component, get_snapshot, etc.)
   - Translate SectionSpec trees into Wix component structures

2. **ISOLATED world script**:
   - Poll the relay for commands (same pattern as Webflow)
   - Forward results back

3. **URL patterns**:
   - `https://editor.wix.com/studio/*`
   - `https://editor.wix.com/*` (classic editor may differ)

## Differences from Webflow Approach

| Aspect | Webflow | Wix |
|--------|---------|-----|
| API location | Main frame (`_webflow.creators`) | Preview iframe (`documentServices`) |
| Paste mechanism | XscpData synthetic paste event | Direct `ds.components.add()` API |
| Component refs | Element IDs | `{ id, type }` objects |
| Style system | Named CSS classes | Component-level style/design objects |
| Variable system | Webflow variables with UUIDs | Theme colors/fonts |
| Layout model | CSS-based (flexbox, grid) | `{ x, y, width, height }` + responsive |

## Next Steps

1. Build content bridge scripts for Wix (`platforms/wix/inspector/`)
2. Implement SectionSpec → Wix component structure translator
3. Test adding sections with multiple children
4. Map responsive breakpoints
5. Investigate `ds.cssStyle` and `ds.customCSS` for style support
6. Test `ds.importExport` for bulk operations
7. Investigate save/publish flow
