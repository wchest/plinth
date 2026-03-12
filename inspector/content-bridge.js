// Plinth Bridge — MAIN world content script
// Receives commands from ISOLATED world via postMessage,
// executes them against _webflow.creators.*, and sends results back.
// Also captures webpack modules for element creation via ELEMENT_ADDED dispatch.

(function () {
  'use strict';

  if (window.__plinthBridgeMain) return;
  window.__plinthBridgeMain = true;

  // -- Webpack module capture -----------------------------------------------
  // Captures __webpack_require__ so we can access expression constructors,
  // tree ops, and other internal modules needed for ELEMENT_ADDED dispatch.

  var modules = null; // { EC, Expr, Component, tgb, setCanvasIframe } — set by captureModules()

  function captureModules() {
    if (modules) return modules;

    // Bootstrap __plinthRequire if needed
    if (!window.__plinthRequire) {
      var captured = null;
      var mainChunk = window.webpackChunk;
      if (!mainChunk) return null;
      var fakeId = '__plinth_bridge_' + Date.now();
      mainChunk.push([[fakeId], {
        [fakeId]: function (m, e, req) { captured = req; }
      }, function (rt) { if (rt) rt(fakeId); }]);
      if (!captured) return null;
      window.__plinthRequire = captured;
    }

    var r = window.__plinthRequire;
    if (!r || !r.m) return null;

    // Scan webpack module definitions to find our modules by their exports.
    // Module IDs change on every Webflow deploy, so we identify by signature.
    var expressionsMod = null;
    var exprCtorsMod = null;
    var treeOpsMod = null;
    var iframeMod = null; // contains setCanvasNextIframe (needed for DATA_TYPE_CHANGED)
    var mids = Object.keys(r.m);

    for (var i = 0; i < mids.length; i++) {
      if (expressionsMod && exprCtorsMod && treeOpsMod && iframeMod) break;
      var mid = mids[i];
      try {
        // For the iframe module, check source code signature (not exports)
        if (!iframeMod) {
          var src = r.m[mid].toString();
          if (src.indexOf('__siteIframeNext') !== -1 && src.indexOf('setCanvasNextIframe') !== -1) {
            var iframeObj = { exports: {} };
            r.m[mid](iframeObj, iframeObj.exports, r);
            if (typeof iframeObj.exports.Z === 'function') {
              iframeMod = iframeObj.exports;
            }
          }
        }
        // For the other modules, check by export signature
        var modObj = { exports: {} };
        r.m[mid](modObj, modObj.exports, r);
        var ex = modObj.exports;
        if (!expressionsMod && ex.Expressions && ex.Component) expressionsMod = ex;
        if (!exprCtorsMod && typeof ex.EElement === 'function' && typeof ex.ERecord === 'function') exprCtorsMod = ex;
        if (!treeOpsMod && ex.tgb) treeOpsMod = ex;
      } catch (e) { /* module may have side effects — skip */ }
    }

    if (!expressionsMod || !exprCtorsMod || !treeOpsMod) return null;

    modules = {
      EC: exprCtorsMod,
      Expr: expressionsMod.Expressions,
      Component: expressionsMod.Component,
      tgb: treeOpsMod.tgb,
      setCanvasIframe: iframeMod ? iframeMod.Z : null,
    };
    return modules;
  }

  // -- Helpers ---------------------------------------------------------------

  function safeSerialize(val, depth) {
    depth = depth || 0;
    if (depth > 6) return '(max depth)';
    if (val === null || val === undefined) return val;

    var t = typeof val;
    if (t === 'string' || t === 'number' || t === 'boolean') return val;
    if (t === 'function') return '(function)';
    if (t === 'symbol') return val.toString();

    // Immutable.js — has .toJS()
    if (val && typeof val.toJS === 'function') {
      try { return val.toJS(); } catch (e) { return '(toJS failed: ' + e.message + ')'; }
    }

    if (Array.isArray(val)) {
      return val.map(function (v) { return safeSerialize(v, depth + 1); });
    }

    if (t === 'object') {
      var out = {};
      try {
        var keys = Object.keys(val);
        for (var i = 0; i < keys.length; i++) {
          out[keys[i]] = safeSerialize(val[keys[i]], depth + 1);
        }
      } catch (e) {
        return '(serialize error: ' + e.message + ')';
      }
      return out;
    }

    return String(val);
  }

  // -- Element type configs --------------------------------------------------

  var ELEMENT_CONFIGS = {
    // -- Layout --
    Section:        { type: ['Layout','Section'],          preset: ['Layout','Section'],          tag: 'section', hasChildren: true,  idMapKey: 'Section' },
    DivBlock:       { type: ['Basic','Block'],             preset: ['Basic','DivBlock'],           tag: 'div',     hasChildren: true,  idMapKey: 'Div Block' },
    Container:      { type: ['Layout','BlockContainer'],   preset: ['Layout','BlockContainer'],    tag: 'div',     hasChildren: true,  idMapKey: 'Container' },
    HFlex:          { type: ['Layout','HFlex'],            preset: ['Layout','HFlex'],             tag: 'div',     hasChildren: true,  idMapKey: 'HFlex' },
    VFlex:          { type: ['Layout','VFlex'],            preset: ['Layout','VFlex'],             tag: 'div',     hasChildren: true,  idMapKey: 'VFlex' },
    Grid:           { type: ['Layout','Grid'],             preset: ['Layout','Grid'],              tag: 'div',     hasChildren: true,  idMapKey: 'Grid' },
    Columns:        { type: ['Layout','Row'],              preset: ['Layout','Row'],               tag: 'div',     hasChildren: true,  idMapKey: 'Columns', useFactory: true },
    QuickStack:     { type: ['Layout','Layout'],           preset: ['Layout','Layout'],            tag: 'div',     hasChildren: true,  idMapKey: 'Quick Stack', useFactory: true },

    // -- Typography --
    Heading:        { type: ['Basic','Heading'],           preset: ['Basic','Heading'],            tag: null,      hasChildren: true,  hasTextChild: true, idMapKey: 'Heading' },
    Paragraph:      { type: ['Basic','Paragraph'],         preset: ['Basic','Paragraph'],          tag: null,      hasChildren: true,  hasTextChild: true, idMapKey: 'Paragraph' },
    TextBlock:      { type: ['Basic','Block'],             preset: ['Basic','TextBlock'],           tag: 'div',     hasChildren: true,  hasTextChild: true, hasText: true, idMapKey: 'TextBlock' },
    BlockQuote:     { type: ['Basic','Blockquote'],        preset: ['Basic','Blockquote'],          tag: 'blockquote', hasChildren: true, hasTextChild: true, idMapKey: 'Block Quote' },
    RichText:       { type: ['Basic','RichText'],          preset: ['Basic','RichText'],            tag: null,      hasChildren: true,  idMapKey: 'Rich Text', useFactory: true },
    CodeBlock:      { type: ['Basic','CodeBlock'],         preset: ['Basic','CodeBlock'],           tag: 'pre',     hasChildren: true,  hasTextChild: true, idMapKey: 'Code Block' },

    // -- Links & Buttons --
    Button:         { type: ['Basic','Link'],              preset: ['Basic','Button'],              tag: null,      hasChildren: true,  hasTextChild: true, isButton: true, idMapKey: 'Button' },
    Link:           { type: ['Basic','Link'],              preset: ['Basic','LinkBlock'],           tag: null,      hasChildren: true,  idMapKey: 'Link Block' },
    TextLink:       { type: ['Basic','Link'],              preset: ['Basic','TextLink'],            tag: null,      hasChildren: true,  hasTextChild: true, idMapKey: 'Text Link' },

    // -- Media --
    Image:          { type: ['Basic','Image'],             preset: ['Basic','Image'],               tag: 'img',     hasChildren: false, idMapKey: 'Image' },
    Video:          { type: ['Embed','Video'],             preset: ['Embed','Video'],               tag: null,      hasChildren: false, idMapKey: 'Video', useFactory: true },
    YouTube:        { type: ['Embed','YouTubeVideo'],      preset: ['Embed','YouTubeVideo'],        tag: null,      hasChildren: false, idMapKey: 'YouTube', useFactory: true },
    BackgroundVideo:{ type: ['BackgroundVideo','BackgroundVideoWrapper'], preset: ['BackgroundVideo','BackgroundVideoWrapper'], tag: null, hasChildren: true, idMapKey: 'Background Video', useFactory: true },
    LottieAnimation:{ type: ['Basic','Image'],             preset: ['Basic','LottieAnimation'],     tag: null,      hasChildren: false, idMapKey: 'Lottie Animation', useFactory: true },

    // -- Lists --
    List:           { type: ['Basic','List'],              preset: ['Basic','List'],                tag: 'ul',      hasChildren: true,  idMapKey: 'List' },
    ListItem:       { type: ['Basic','ListItem'],          preset: ['Basic','ListItem'],            tag: 'li',      hasChildren: true,  idMapKey: 'List Item' },

    // -- Embed --
    CodeEmbed:      { type: ['Embed','HtmlEmbed'],         preset: ['Embed','HtmlEmbed'],           tag: null,      hasChildren: false, idMapKey: 'Code Embed', hasEmbedCode: true },

    // -- Forms --
    FormBlock:      { type: ['Form','FormWrapper'],        preset: ['Form','FormWrapper'],          tag: null,      hasChildren: true,  idMapKey: 'Form Block', useFactory: true },
    FormLabel:      { type: ['Form','FormBlockLabel'],     preset: ['Form','FormBlockLabel'],       tag: 'label',   hasChildren: true,  hasTextChild: true, idMapKey: 'Label' },
    FormInput:      { type: ['Form','FormTextInput'],      preset: ['Form','FormTextInput'],        tag: 'input',   hasChildren: false, idMapKey: 'Input', useFactory: true },
    FormTextArea:   { type: ['Form','FormTextarea'],       preset: ['Form','FormTextarea'],         tag: 'textarea',hasChildren: false, idMapKey: 'Text Area', useFactory: true },
    FormSelect:     { type: ['Form','FormSelect'],         preset: ['Form','FormSelect'],           tag: 'select',  hasChildren: true,  idMapKey: 'Select', useFactory: true },
    FormCheckbox:   { type: ['Form','FormCheckboxWrapper'],preset: ['Form','FormCheckboxWrapper'],  tag: null,      hasChildren: true,  idMapKey: 'Checkbox', useFactory: true },
    FormRadio:      { type: ['Form','FormRadioWrapper'],   preset: ['Form','FormRadioWrapper'],     tag: null,      hasChildren: true,  idMapKey: 'Radio Button', useFactory: true },
    FormButton:     { type: ['Form','FormButton'],         preset: ['Form','FormButton'],           tag: 'input',   hasChildren: false, idMapKey: 'Form Button' },
    FileUpload:     { type: ['Form','FormFileUploadWrapper'],preset: ['Form','FormFileUploadWrapper'],tag: null,    hasChildren: true,  idMapKey: 'File Upload', useFactory: true },

    // -- Components (complex wrappers) --
    Navbar:         { type: ['Navbar','NavbarWrapper'],    preset: ['Navbar','NavbarWrapper'],      tag: null,      hasChildren: true,  idMapKey: 'Navbar', useFactory: true },
    Slider:         { type: ['Slider','SliderWrapper'],    preset: ['Slider','SliderWrapper'],      tag: null,      hasChildren: true,  idMapKey: 'Slider', useFactory: true },
    Tabs:           { type: ['Tabs','TabsWrapper'],        preset: ['Tabs','TabsWrapper'],          tag: null,      hasChildren: true,  idMapKey: 'Tabs', useFactory: true },
    Dropdown:       { type: ['Dropdown','DropdownWrapper'],preset: ['Dropdown','DropdownWrapper'],  tag: null,      hasChildren: true,  idMapKey: 'Dropdown', useFactory: true },
    Lightbox:       { type: ['Lightbox','LightboxWrapper'],preset: ['Lightbox','LightboxWrapper'],  tag: null,      hasChildren: true,  idMapKey: 'Lightbox', useFactory: true },
    Map:            { type: ['Widget','MapWidget'],        preset: ['Widget','MapWidget'],          tag: null,      hasChildren: false, idMapKey: 'Map', useFactory: true },

    // -- CMS --
    CollectionList: { type: ['Dynamo','DynamoWrapper'],    preset: ['Dynamo','DynamoWrapper'],      tag: null,      hasChildren: true,  idMapKey: 'Collection List', useFactory: true },

    // -- Ecommerce --
    Cart:           { type: ['Commerce','CartWrapper'],    preset: ['Commerce','CartWrapper'],      tag: null,      hasChildren: true,  idMapKey: 'Cart', useFactory: true },
    AddToCart:      { type: ['Commerce','AddToCartWrapper'],preset: ['Commerce','AddToCartWrapper'], tag: null,      hasChildren: true,  idMapKey: 'Add to Cart', useFactory: true },

    // -- Pagination --
    Pagination:     { type: ['Pagination','Pagination'],   preset: ['Pagination','Pagination'],     tag: null,      hasChildren: true,  idMapKey: 'Pagination', useFactory: true },
  };

  // Map BuildPlan type names to config keys (case-insensitive convenience aliases)
  var TYPE_ALIASES = {
    'Section': 'Section', 'section': 'Section',
    'DivBlock': 'DivBlock', 'divblock': 'DivBlock', 'div': 'DivBlock',
    'Container': 'Container', 'container': 'Container',
    'Heading': 'Heading', 'heading': 'Heading',
    'Paragraph': 'Paragraph', 'paragraph': 'Paragraph',
    'Button': 'Button', 'button': 'Button',
    'TextBlock': 'TextBlock', 'textblock': 'TextBlock',
    'BlockQuote': 'BlockQuote', 'blockquote': 'BlockQuote', 'Blockquote': 'BlockQuote',
    'RichText': 'RichText', 'richtext': 'RichText',
    'CodeBlock': 'CodeBlock', 'codeblock': 'CodeBlock',
    'Link': 'Link', 'link': 'Link',
    'TextLink': 'TextLink', 'textlink': 'TextLink',
    'HFlex': 'HFlex', 'hflex': 'HFlex',
    'VFlex': 'VFlex', 'vflex': 'VFlex',
    'Grid': 'Grid', 'grid': 'Grid',
    'Columns': 'Columns', 'columns': 'Columns',
    'QuickStack': 'QuickStack', 'quickstack': 'QuickStack',
    'Image': 'Image', 'image': 'Image',
    'Video': 'Video', 'video': 'Video',
    'YouTube': 'YouTube', 'youtube': 'YouTube',
    'BackgroundVideo': 'BackgroundVideo', 'backgroundvideo': 'BackgroundVideo',
    'LottieAnimation': 'LottieAnimation', 'lottie': 'LottieAnimation',
    'List': 'List', 'list': 'List',
    'ListItem': 'ListItem', 'listitem': 'ListItem', 'li': 'ListItem',
    'CodeEmbed': 'CodeEmbed', 'codeembed': 'CodeEmbed', 'embed': 'CodeEmbed',
    'FormBlock': 'FormBlock', 'formblock': 'FormBlock', 'form': 'FormBlock',
    'FormLabel': 'FormLabel', 'formlabel': 'FormLabel', 'label': 'FormLabel',
    'FormInput': 'FormInput', 'forminput': 'FormInput', 'input': 'FormInput',
    'FormTextArea': 'FormTextArea', 'formtextarea': 'FormTextArea', 'textarea': 'FormTextArea',
    'FormSelect': 'FormSelect', 'formselect': 'FormSelect', 'select': 'FormSelect',
    'FormCheckbox': 'FormCheckbox', 'formcheckbox': 'FormCheckbox', 'checkbox': 'FormCheckbox',
    'FormRadio': 'FormRadio', 'formradio': 'FormRadio', 'radio': 'FormRadio',
    'FormButton': 'FormButton', 'formbutton': 'FormButton',
    'FileUpload': 'FileUpload', 'fileupload': 'FileUpload',
    'Navbar': 'Navbar', 'navbar': 'Navbar',
    'Slider': 'Slider', 'slider': 'Slider',
    'Tabs': 'Tabs', 'tabs': 'Tabs',
    'Dropdown': 'Dropdown', 'dropdown': 'Dropdown',
    'Lightbox': 'Lightbox', 'lightbox': 'Lightbox',
    'Map': 'Map', 'map': 'Map',
    'CollectionList': 'CollectionList', 'collectionlist': 'CollectionList', 'cms': 'CollectionList',
    'Cart': 'Cart', 'cart': 'Cart',
    'AddToCart': 'AddToCart', 'addtocart': 'AddToCart',
    'Pagination': 'Pagination', 'pagination': 'Pagination',
  };

  // -- Element builder -------------------------------------------------------

  // Build an element via instantiateFactory (for complex/composite elements).
  // Uses the element preset system to create properly structured multi-element widgets.
  function buildFromFactory(Expr, node, config, childExpressions) {
    var ds = window._webflow.state.DesignerStore;
    var presets = ds.plugins.elementPresets;
    var targetPreset = null;

    presets.forEach(function (p) {
      if (targetPreset) return;
      if (p.label === config.idMapKey) targetPreset = p;
    });

    if (!targetPreset || !targetPreset.factory) return null;

    // The factory is a plain JS expression tree with {type, val} wrappers.
    // Element nodes have type:"Element", val:{id, type, data}.
    // Template IDs are placeholder strings like "Dynamo Wrapper".
    // We deep-clone the tree, replacing every Element ID with a fresh UUID.
    // If childExpressions are provided, inject them into the "Item" element.
    var factory = targetPreset.factory;
    var idMap = {};
    var itemContainerId = null; // Track which template ID is the "Item" container

    function cloneExpr(e) {
      if (!e || typeof e !== 'object') return e;
      if (e.type === 'Element') {
        var oldId = e.val.id;
        var newId = crypto.randomUUID();
        idMap[oldId] = newId;
        // Detect the "Item" container (e.g. "Dynamo Item", "Slider Slide", etc.)
        if (oldId && oldId.indexOf('Item') >= 0) itemContainerId = oldId;
        var newVal = { id: newId, type: e.val.type };
        if (e.val.data) {
          var clonedData = cloneExpr(e.val.data);
          // Inject child expressions into the Item container's children
          if (oldId && oldId.indexOf('Item') >= 0 && childExpressions && childExpressions.length > 0) {
            if (clonedData.type === 'Record' && clonedData.val.children && clonedData.val.children.type === 'List') {
              clonedData.val.children.val = clonedData.val.children.val.concat(childExpressions);
            }
          }
          newVal.data = clonedData;
        }
        return { type: 'Element', val: newVal };
      }
      if (e.type === 'Record') {
        var newFields = {};
        var keys = Object.keys(e.val);
        for (var i = 0; i < keys.length; i++) {
          newFields[keys[i]] = cloneExpr(e.val[keys[i]]);
        }
        return { type: 'Record', val: newFields };
      }
      if (e.type === 'List') {
        return { type: 'List', val: e.val.map(function (item) { return cloneExpr(item); }) };
      }
      // Other expression types (Text, Enum, Boolean, etc.) — pass through
      return e;
    }

    var cloned = cloneExpr(factory);
    if (!cloned || !cloned.val) return null;

    // Unwrap with Expr.getElement to get the raw element for ELEMENT_ADDED
    var rawElement = Expr.getElement(cloned);
    if (!rawElement) return null;

    return {
      rawElement: rawElement,
      uuid: cloned.val.id,
      idMap: idMap,
      preset: config.preset,
      itemContainerId: itemContainerId ? idMap[itemContainerId] : null,
    };
  }

  function buildElementExpression(EC, node, parentId) {
    var configKey = TYPE_ALIASES[node.type];
    if (!configKey) throw new Error('Unknown element type: ' + node.type);
    var config = ELEMENT_CONFIGS[configKey];

    var uuid = crypto.randomUUID();
    var styleId = crypto.randomUUID();
    var dataFields = {};

    // Tag
    if (config.tag === 'section') {
      dataFields.tag = EC.EEnum('section');
      dataFields.grid = EC.ERecord({ type: EC.EText('section') });
    } else if (configKey === 'Heading') {
      var level = node.headingLevel || 2;
      dataFields.tag = EC.EEnum('h' + level);
    } else if (configKey === 'List') {
      var listTag = node.ordered ? 'ol' : 'ul';
      dataFields.tag = EC.EEnum(listTag);
    } else if (config.tag) {
      dataFields.tag = EC.EEnum(config.tag);
    }

    // Text flag (TextBlock)
    if (config.hasText !== undefined) {
      dataFields.text = EC.EBoolean(config.hasText);
    }

    // Button-specific fields
    if (config.isButton) {
      dataFields.button = EC.EBoolean(true);
      dataFields.block = EC.EText('');
      dataFields.search = EC.ERecord({ exclude: EC.EBoolean(true) });
      dataFields.eventIds = EC.EList([]);
      dataFields.link = EC.ELiteral({
        name: ['Basic', 'Link'],
        value: { mode: 'external', url: node.href || '#' }
      });
    }

    // Link href (non-button links)
    if (configKey === 'Link' || configKey === 'TextLink') {
      if (node.href) {
        dataFields.link = EC.ELiteral({
          name: ['Basic', 'Link'],
          value: { mode: 'external', url: node.href }
        });
      }
    }

    // Image-specific fields
    if (configKey === 'Image') {
      dataFields.children = EC.EList([]);
      dataFields.xattr = EC.EList([]);
      dataFields.search = EC.ERecord({
        exclude: EC.EBoolean(false),
        tag: EC.EText('img')
      });
      if (node.alt) dataFields.alt = EC.EText(node.alt);
    }

    // Code Embed — stores HTML code in embed field
    if (config.hasEmbedCode) {
      dataFields.embed = EC.ERecord({
        type: EC.EText('custom'),
        value: EC.EText(node.code || node.text || '<!-- embed -->')
      });
    }

    // Children
    if (config.hasChildren) {
      var childElements = [];

      // Text child for text-bearing elements
      if (config.hasTextChild && node.text) {
        var textUuid = crypto.randomUUID();
        childElements.push(
          EC.EElement({ id: textUuid, type: ['Basic', 'String'], data: EC.EText(node.text) })
        );
      }

      // Recurse into children from BuildPlan
      // (children of this element will be dispatched separately, not nested here)
      dataFields.children = EC.EList(childElements);
    }

    var element = EC.EElement({
      id: uuid,
      type: config.type,
      data: EC.ERecord(dataFields)
    });

    return {
      element: element,
      uuid: uuid,
      styleId: styleId,
      config: config,
      configKey: configKey,
      className: node.className || null,
      children: node.children || [],
    };
  }

  // -- Build command handler -------------------------------------------------

  // -- Style helpers -----------------------------------------------------------

  // Property name mapping: CSS/BuildPlan names → Webflow StyleStore paths
  // Most are identical (camelCase), but some differ.
  var PROP_NAME_MAP = {
    'color': 'fontColor',
    'border-top-left-radius': 'borderRadiusTopLeft',
    'border-top-right-radius': 'borderRadiusTopRight',
    'border-bottom-left-radius': 'borderRadiusBottomLeft',
    'border-bottom-right-radius': 'borderRadiusBottomRight',
  };

  // Properties where setStyle expects a raw number (Webflow appends "px")
  var NUMERIC_PROPS = /^(fontSize|fontWeight|lineHeight|letterSpacing|opacity|width|height|minWidth|minHeight|maxWidth|maxHeight|paddingTop|paddingRight|paddingBottom|paddingLeft|marginTop|marginRight|marginBottom|marginLeft|borderRadiusTopLeft|borderRadiusTopRight|borderRadiusBottomLeft|borderRadiusBottomRight|borderWidth|borderTopWidth|borderRightWidth|borderBottomWidth|borderLeftWidth|gridColumnGap|gridRowGap|top|right|bottom|left)$/;

  // Convert a CSS property name to the Webflow setStyle path
  function toStylePath(prop) {
    // Check explicit mapping first
    if (PROP_NAME_MAP[prop]) return PROP_NAME_MAP[prop];
    // Convert kebab-case to camelCase
    return prop.replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); });
  }

  // Convert a CSS value to the format setStyle expects
  function toStyleValue(path, value) {
    if (NUMERIC_PROPS.test(path)) {
      // Strip "px", "rem", etc. and return number
      var num = parseFloat(value);
      if (!isNaN(num)) return num;
    }
    return value;
  }

  // Find the canvas iframe (Webflow renders the page inside an iframe).
  // Returns { doc, win } or null.
  function getCanvasIframe() {
    var iframes = document.querySelectorAll('iframe');
    for (var i = 0; i < iframes.length; i++) {
      try {
        var doc = iframes[i].contentDocument;
        if (doc && doc.querySelector && doc.querySelector('[data-w-id]')) {
          return { doc: doc, win: iframes[i].contentWindow };
        }
      } catch (e) { /* cross-origin */ }
    }
    // Fallback: first iframe with body children
    for (var i = 0; i < iframes.length; i++) {
      try {
        var doc = iframes[i].contentDocument;
        if (doc && doc.body && doc.body.children.length > 2) {
          return { doc: doc, win: iframes[i].contentWindow };
        }
      } catch (e) {}
    }
    return null;
  }

  // Sync lastSyncedNodeNativeId by dispatching CANVAS_BODY_RENDERED.
  // This is required before setStyle will target the correct element.
  function syncCanvasNode(uuid) {
    var canvas = getCanvasIframe();
    var computedStyle = {};

    if (canvas) {
      var el = canvas.doc.querySelector('[data-w-id="' + uuid + '"]');
      if (el) {
        var cs = canvas.win.getComputedStyle(el);
        for (var j = 0; j < cs.length; j++) {
          computedStyle[cs[j]] = cs.getPropertyValue(cs[j]);
        }
      }
    }

    window._webflow.dispatch({
      type: 'CANVAS_BODY_RENDERED',
      payload: { nodeNativeId: uuid, computedStyle: computedStyle }
    });
  }

  // Apply styles to the currently synced element via StyleActionCreators.
  // Returns a Promise — startSetStyle needs a tick to initialize before first setStyle.
  function applyStyles(properties) {
    var sac = window._webflow.creators.StyleActionCreators;
    var keys = Object.keys(properties);
    if (keys.length === 0) return Promise.resolve();

    return new Promise(function (resolve) {
      sac.startSetStyle();
      // Wait a tick for startSetStyle to initialize internal state
      setTimeout(function () {
        for (var i = 0; i < keys.length; i++) {
          var path = toStylePath(keys[i]);
          var value = toStyleValue(path, properties[keys[i]]);
          sac.setStyle({ path: path, value: value });
        }
        sac.endSetStyle({ commit: true });
        resolve();
      }, 50);
    });
  }

  // Rename the auto-created style block (e.g. "Section 8") to the desired className.
  // Must be called AFTER applyStyles/endSetStyle which creates the style block.
  function renameStyleBlock(uuid, desiredName) {
    // Find the style block associated with this element
    var dsState = window._webflow.state.DesignerStore;
    var pageComp = null;
    dsState.components.forEach(function (v, k) {
      var ks = String(k);
      if (ks.indexOf('SitePlugin') >= 0 && ks.indexOf('page') >= 0) pageComp = v;
    });
    if (!pageComp) return;

    // Walk to find the element
    function findEl(el, targetId) {
      if (!el) return null;
      if (el.id === targetId) return el;
      var d = el.data;
      if (!d || !d.val || !d.val.children || !d.val.children.val) return null;
      var ch = d.val.children.val;
      var len = ch.length || (typeof ch.size === 'number' ? ch.size : 0);
      for (var i = 0; i < len; i++) {
        var c = ch[i] || (typeof ch.get === 'function' ? ch.get(i) : null);
        if (c && c.val) {
          var found = findEl(c.val, targetId);
          if (found) return found;
        }
      }
      return null;
    }

    var el = findEl(pageComp.render.val, uuid);
    if (!el || !el.data || !el.data.val || !el.data.val.styleBlockIds) return;

    var sbIds = el.data.val.styleBlockIds.val;
    if (!sbIds || sbIds.length === 0) return;

    var blockId = sbIds[0].val;
    var sbs = window._webflow.state.StyleBlockStore;
    var block = sbs.styleBlocks.get(blockId);
    if (!block || block.get('name') === desiredName) return;

    var newBlock = block.set('name', desiredName);
    var newSbs = sbs.set('styleBlocks', sbs.styleBlocks.set(blockId, newBlock));

    window._webflow.dispatch({
      type: '__DEPRECATED__STYLE_BLOCK_STATE_CHANGED',
      payload: {
        styleState: window._webflow.state.StyleStore,
        styleBlockState: newSbs,
        autoCreatedStyleBlockGuid: null,
        nodeNativeId: uuid,
        ruleRemoved: false,
        ephemeral: false,
        expectedStyleRuleGuid: blockId + ':main',
      }
    });
  }

  function handleBuild(payload) {
    var m = captureModules();
    if (!m) throw new Error('Webpack modules not available — page may still be loading');

    var EC = m.EC;
    var Expr = m.Expr;

    var tree = payload.tree;
    if (!tree) throw new Error('payload.tree is required');

    // Get page body
    var dsState = window._webflow.state.DesignerStore;
    if (!dsState) throw new Error('DesignerStore not found');
    var pageComp = null;
    dsState.components.forEach(function (v, k) {
      var ks = String(k);
      if (ks.indexOf('SitePlugin') >= 0 && ks.indexOf('page') >= 0) pageComp = v;
    });
    if (!pageComp) throw new Error('Page component not found');
    var pageRender = pageComp.render;
    var bodyEl = pageRender && pageRender.val;
    var bodyId = bodyEl && bodyEl.id;
    if (!bodyId) throw new Error('Body element not found');

    // Find anchor for insertion
    var anchorId = bodyId;
    var position = 'append';

    if (payload.parentElementId) {
      // Insert as child of the specified element.
      // 'append' doesn't work for some containers (e.g. DynamoItem).
      // Strategy: find the last child and use 'after', else fall back to 'append'.
      var parentEl = findElementById(payload.parentElementId, bodyEl);
      if (parentEl && parentEl.data && parentEl.data.val &&
          parentEl.data.val.children && parentEl.data.val.children.val) {
        var pch = parentEl.data.val.children.val;
        var plen = pch.length || (typeof pch.size === 'number' ? pch.size : 0);
        if (plen > 0) {
          // Find last non-String child
          var lastChild = null;
          for (var ci = plen - 1; ci >= 0; ci--) {
            var cc = pch[ci] || (pch.get ? pch.get(ci) : null);
            if (cc && cc.val && !(cc.val.type && cc.val.type[0] === 'Basic' && cc.val.type[1] === 'String')) {
              lastChild = cc.val;
              break;
            }
          }
          if (lastChild) {
            anchorId = lastChild.id;
            position = 'after';
          } else {
            anchorId = payload.parentElementId;
            position = 'append';
          }
        } else {
          anchorId = payload.parentElementId;
          position = 'append';
        }
      } else {
        anchorId = payload.parentElementId;
        position = 'append';
      }
    } else if (payload.insertAfterSectionClass) {
      var targetId = findElementByClass(payload.insertAfterSectionClass, bodyEl);
      if (targetId) {
        anchorId = targetId;
        position = 'after';
      }
    } else if (payload.insertAfterElementId) {
      anchorId = payload.insertAfterElementId;
      position = 'after';
    }

    // Build style map from definitions
    var styleDefs = payload.styles || [];
    var styleMap = {};
    for (var si = 0; si < styleDefs.length; si++) {
      var sd = styleDefs[si];
      var sname = sd.name || sd.className;
      if (sname) styleMap[sname] = sd.properties || {};
    }

    // Flatten the tree into a sequential list of {node, anchorId, position}
    // so we can process them async with delays between each.
    var steps = [];
    flattenTree(EC, Expr, tree, anchorId, position, steps);

    if (steps.length === 0) {
      return { success: false, elementsCreated: 0, stylesApplied: 0, errors: ['No elements to create'] };
    }

    // Process steps sequentially with delays to let Webflow state settle.
    // Pipeline per element:
    //   1. ELEMENT_ADDED (creates element on canvas, auto-selects it)
    //   2. CANVAS_BODY_RENDERED (syncs lastSyncedNodeNativeId for style targeting)
    //   3. setStyle calls (applies CSS properties, creates style block)
    //   4. Rename style block to desired className
    var results = { elementsCreated: 0, errors: [], stylesApplied: 0, classesRenamed: 0 };
    var SETTLE_MS = 300;   // ms after ELEMENT_ADDED before CANVAS_BODY_RENDERED
    var SYNC_MS = 100;     // ms after CANVAS_BODY_RENDERED before setStyle
    var NEXT_MS = 200;     // ms after styles before next element

    return new Promise(function (resolve) {
      var idx = 0;

      function processNext() {
        if (idx >= steps.length) {
          resolve({
            success: results.elementsCreated > 0,
            elementsCreated: results.elementsCreated,
            stylesApplied: results.stylesApplied,
            classesRenamed: results.classesRenamed,
            errors: results.errors,
          });
          return;
        }

        var step = steps[idx];
        idx++;

        // For elements already in the tree (injected into factory), skip dispatch
        if (step.skipDispatch) {
          results.elementsCreated++;
          // Still need to apply styles — go to style pipeline
          var hasSkipStyles = styleMap && step.className && styleMap[step.className] &&
                              Object.keys(styleMap[step.className]).length > 0;
          if (hasSkipStyles) {
            setTimeout(function () {
              try { syncCanvasNode(step.uuid); } catch (e) {
                results.errors.push('Sync ' + step.className + ': ' + (e.message || e));
              }
              setTimeout(function () {
                applyStyles(styleMap[step.className]).then(function () {
                  results.stylesApplied++;
                  if (step.className) {
                    try { renameStyleBlock(step.uuid, step.className); results.classesRenamed++; }
                    catch (e) { results.errors.push('Rename ' + step.className + ': ' + (e.message || e)); }
                  }
                  setTimeout(processNext, NEXT_MS);
                }).catch(function (e) {
                  results.errors.push('Style ' + step.className + ': ' + (e.message || e));
                  setTimeout(processNext, NEXT_MS);
                });
              }, SYNC_MS);
            }, SETTLE_MS);
          } else {
            setTimeout(processNext, NEXT_MS);
          }
          return;
        }

        // Step 1: Dispatch ELEMENT_ADDED
        try {
          window._webflow.dispatch({
            type: 'ELEMENT_ADDED',
            payload: {
              anchorId: step.anchorId,
              nativeId: step.uuid,
              position: step.position,
              anchorPath: null,
              elementPreset: step.preset,
              initialStyleBlockId: step.styleId,
              styleBlockState: window._webflow.state.StyleBlockStore,
              designerState: window._webflow.state.DesignerStore,
              uiNodeState: window._webflow.state.UiNodeStore,
              element: step.rawElement,
              idMap: step.idMap,
              assetsToImport: [],
              componentMapPatch: null
            }
          });
          results.elementsCreated++;
        } catch (e) {
          results.errors.push('Dispatch ' + step.configKey + ': ' + e.message);
          setTimeout(processNext, NEXT_MS);
          return;
        }

        // Step 2-4: Sync, apply styles, rename — only if styles defined for this element
        var hasStyles = styleMap && step.className && styleMap[step.className] &&
                        Object.keys(styleMap[step.className]).length > 0;

        if (hasStyles) {
          setTimeout(function () {
            // Step 2: CANVAS_BODY_RENDERED to sync lastSyncedNodeNativeId
            try {
              syncCanvasNode(step.uuid);
            } catch (e) {
              results.errors.push('Sync ' + step.className + ': ' + (e.message || e));
            }

            // Step 3: Apply styles after sync settles
            setTimeout(function () {
              applyStyles(styleMap[step.className]).then(function () {
                results.stylesApplied++;

                // Step 4: Rename the auto-created style block
                if (step.className) {
                  try {
                    renameStyleBlock(step.uuid, step.className);
                    results.classesRenamed++;
                  } catch (e) {
                    results.errors.push('Rename ' + step.className + ': ' + (e.message || e));
                  }
                }

                setTimeout(processNext, NEXT_MS);
              }).catch(function (e) {
                results.errors.push('Style ' + step.className + ': ' + (e.message || e));
                setTimeout(processNext, NEXT_MS);
              });
            }, SYNC_MS);
          }, SETTLE_MS);
        } else {
          setTimeout(processNext, NEXT_MS);
        }
      }

      processNext();
    });
  }

  // Flatten a nested tree into a sequential list of dispatch steps
  function flattenTree(EC, Expr, node, anchorId, position, steps) {
    var configKey = TYPE_ALIASES[node.type];
    if (!configKey) return;
    var config = ELEMENT_CONFIGS[configKey];

    // For complex/composite elements, use the factory path
    if (config.useFactory) {
      // Pre-build child element expressions to inject into the factory's
      // Item container (e.g. DynamoItem). This avoids the problem where
      // ELEMENT_ADDED with position:'append' doesn't work for Dynamo containers.
      var childExprs = [];
      var childSteps = []; // steps for styling children after the factory dispatch
      if (node.children && node.children.length > 0) {
        for (var ci = 0; ci < node.children.length; ci++) {
          var childNode = node.children[ci];
          var childConfigKey = TYPE_ALIASES[childNode.type];
          if (!childConfigKey) continue;
          var childConfig = ELEMENT_CONFIGS[childConfigKey];
          if (childConfig.useFactory) {
            // Nested factory elements can't be injected — handle after dispatch
            continue;
          }
          try {
            var childBuilt = buildElementExpression(EC, childNode);
            childExprs.push(childBuilt.element);
            // Add a step for styling this child (no dispatch needed — it's in the tree)
            childSteps.push({
              uuid: childBuilt.uuid,
              styleId: childBuilt.styleId,
              configKey: childConfigKey,
              className: childNode.className || null,
              skipDispatch: true, // element is already in the tree via factory
            });
          } catch (e) { /* skip failed children */ }
        }
      }

      var factoryResult = buildFromFactory(Expr, node, config, childExprs);
      if (factoryResult) {
        steps.push({
          uuid: factoryResult.uuid,
          styleId: crypto.randomUUID(),
          anchorId: anchorId,
          position: position,
          preset: config.preset,
          rawElement: factoryResult.rawElement,
          idMap: factoryResult.idMap,
          configKey: configKey,
          className: node.className || null,
        });
        // Add child styling steps (elements already in tree, just need styles)
        for (var si = 0; si < childSteps.length; si++) {
          steps.push(childSteps[si]);
        }
        return;
      }
      // Fall through to manual build if factory fails
    }

    var built;
    try {
      built = buildElementExpression(EC, node);
    } catch (e) {
      return;
    }

    var rawElement = Expr.getElement(built.element);
    if (!rawElement) return;

    var idMap = {};
    idMap[built.config.idMapKey] = built.uuid;

    steps.push({
      uuid: built.uuid,
      styleId: built.styleId,
      anchorId: anchorId,
      position: position,
      preset: built.config.preset,
      rawElement: rawElement,
      idMap: idMap,
      configKey: built.configKey,
      className: built.className,
    });

    // Children are appended inside this element
    if (built.children && built.children.length > 0) {
      for (var i = 0; i < built.children.length; i++) {
        flattenTree(EC, Expr, built.children[i], built.uuid, 'append', steps);
      }
    }
  }

  // -- Element tree walking --------------------------------------------------

  function findElementById(targetId, el) {
    if (!el) return null;
    if (el.id === targetId) return el;
    if (el.data && el.data.val && el.data.val.children && el.data.val.children.val) {
      var ch = el.data.val.children.val;
      var len = ch.length || (typeof ch.size === 'number' ? ch.size : 0);
      for (var i = 0; i < len; i++) {
        var c = ch[i] || (ch.get ? ch.get(i) : null);
        if (c && c.val) {
          var found = findElementById(targetId, c.val);
          if (found) return found;
        }
      }
    }
    return null;
  }

  function findElementByClass(className, bodyEl) {
    // Walk the StyleBlockStore to find a style with this name, then find
    // the element that uses it by walking the page tree
    var sb = window._webflow.state.StyleBlockStore.styleBlocks;
    var targetGuid = null;
    sb.forEach(function (v, k) {
      if (v.get('name') === className) targetGuid = k;
    });
    if (!targetGuid) return null;

    // Walk body children to find element with this style block
    return findElementWithStyle(bodyEl, targetGuid);
  }

  function findElementWithStyle(el, styleGuid) {
    // Check this element's style
    if (!el) return null;
    var data = el.data;
    if (data && data.val) {
      // Check if element has this style in its class list
      // Elements store style refs differently — check the DOM node attributes
      var children = data.val.children;
      if (children && children.val) {
        var list = children.val;
        var len = list.length || (typeof list.size === 'number' ? list.size : 0);
        for (var i = 0; i < len; i++) {
          var child = list[i] || (typeof list.get === 'function' ? list.get(i) : null);
          if (child && child.val) {
            var found = findElementWithStyle(child.val, styleGuid);
            if (found) return found;
          }
        }
      }
    }
    return null;
  }


  // -- Command Handlers (existing) -------------------------------------------

  function handlePing() {
    var m = captureModules();
    var creators = window._webflow && window._webflow.creators;
    var count = 0;
    if (creators && typeof creators === 'object') {
      try { count = Object.keys(creators).length; } catch (e) { /* ignore */ }
    }
    return {
      ready: true,
      creatorsAvailable: !!creators,
      creatorsCount: count,
      webpackCaptured: !!m,
    };
  }

  function handleSnapshot() {
    var ds = window._webflow && window._webflow.state && window._webflow.state.DesignerStore;
    if (!ds) throw new Error('DesignerStore not available');

    // Find page component
    var pageComp = null;
    ds.components.forEach(function (v, k) {
      var ks = String(k);
      if (ks.indexOf('SitePlugin') >= 0 && ks.indexOf('page') >= 0) pageComp = v;
    });
    if (!pageComp) throw new Error('Page component not found');

    // Build style block name map: blockId → name
    var sb = window._webflow.state.StyleBlockStore.styleBlocks;
    var styleNameMap = {}; // blockId → name
    var allStyleNames = [];
    sb.forEach(function (v, k) {
      var name = v.get('name');
      if (name) {
        styleNameMap[k] = name;
        allStyleNames.push(name);
      }
    });

    // Type label mapping
    var TYPE_LABELS = {
      'Body,Body': 'Body',
      'Builtin,DOM': 'DOM',
      // Layout
      'Layout,Section': 'Section',
      'Layout,BlockContainer': 'Container',
      'Layout,HFlex': 'HFlex',
      'Layout,VFlex': 'VFlex',
      'Layout,Grid': 'Grid',
      'Layout,Row': 'Columns',
      'Layout,Layout': 'QuickStack',
      // Basic
      'Basic,Block': 'DivBlock',
      'Basic,Heading': 'Heading',
      'Basic,Paragraph': 'Paragraph',
      'Basic,Link': 'Link',
      'Basic,Image': 'Image',
      'Basic,String': 'String',
      'Basic,List': 'List',
      'Basic,ListItem': 'ListItem',
      'Basic,Blockquote': 'BlockQuote',
      'Basic,RichText': 'RichText',
      'Basic,CodeBlock': 'CodeBlock',
      // Embed
      'Embed,HtmlEmbed': 'CodeEmbed',
      'Embed,Video': 'Video',
      'Embed,YouTubeVideo': 'YouTube',
      // Forms
      'Form,FormWrapper': 'FormBlock',
      'Form,FormBlockLabel': 'FormLabel',
      'Form,FormTextInput': 'FormInput',
      'Form,FormTextarea': 'FormTextArea',
      'Form,FormSelect': 'FormSelect',
      'Form,FormCheckboxWrapper': 'FormCheckbox',
      'Form,FormRadioWrapper': 'FormRadio',
      'Form,FormButton': 'FormButton',
      'Form,FormFileUploadWrapper': 'FileUpload',
      // Components
      'Navbar,NavbarWrapper': 'Navbar',
      'Slider,SliderWrapper': 'Slider',
      'Tabs,TabsWrapper': 'Tabs',
      'Dropdown,DropdownWrapper': 'Dropdown',
      'Lightbox,LightboxWrapper': 'Lightbox',
      'Widget,MapWidget': 'Map',
      'BackgroundVideo,BackgroundVideoWrapper': 'BackgroundVideo',
      // CMS
      'Dynamo,DynamoWrapper': 'CollectionList',
      'Dynamo,DynamoList': 'CollectionItems',
      'Dynamo,DynamoItem': 'CollectionItem',
      // Ecommerce
      'Commerce,CartWrapper': 'Cart',
      'Commerce,AddToCartWrapper': 'AddToCart',
      // Pagination
      'Pagination,Pagination': 'Pagination',
    };

    // Walk the tree and produce lines
    var lines = [];
    var MAX_DEPTH = 8;

    function walkElement(el, depth) {
      if (!el || depth > MAX_DEPTH) return;

      var typeArr = el.type;
      var typeKey = typeArr ? typeArr.join(',') : '?';
      var label = TYPE_LABELS[typeKey] || typeKey;

      // Skip string nodes in output (they're text content)
      if (label === 'String') return;

      var id = el.id ? '#' + el.id : '';

      // Get class names from styleBlockIds
      var classes = '';
      var data = el.data;
      if (data && data.val && data.val.styleBlockIds && data.val.styleBlockIds.val) {
        var sbIds = data.val.styleBlockIds.val;
        var names = [];
        for (var i = 0; i < (sbIds.length || sbIds.size || 0); i++) {
          var sbEntry = sbIds[i] || (sbIds.get ? sbIds.get(i) : null);
          if (sbEntry) {
            var sbId = sbEntry.val || sbEntry;
            var nm = styleNameMap[sbId];
            if (nm) names.push(nm);
          }
        }
        if (names.length > 0) classes = ' .' + names.join('.');
      }

      // Get text content
      var text = '';
      if (data && data.val && data.val.children && data.val.children.val) {
        var ch = data.val.children.val;
        for (var i = 0; i < (ch.length || ch.size || 0); i++) {
          var c = ch[i] || (ch.get ? ch.get(i) : null);
          if (c && c.val && c.val.type && c.val.type[0] === 'Basic' && c.val.type[1] === 'String') {
            var td = c.val.data;
            if (td && td.val && typeof td.val === 'string') {
              text = ' "' + td.val.substring(0, 60) + (td.val.length > 60 ? '...' : '') + '"';
            }
          }
        }
      }

      // Refine label from element data (tag, button, text flags)
      if (data && data.val) {
        if (data.val.button && data.val.button.val === true) label = 'Button';
        if (data.val.tag && data.val.tag.val) {
          var tag = data.val.tag.val;
          if (tag.match && tag.match(/^h[1-6]$/)) label = tag.toUpperCase();
          else if (tag === 'section') label = 'Section';
          else if (tag === 'img') label = 'Image';
          else if (tag === 'a') label = 'Link';
          else if (label === 'DOM') label = 'Div'; // Builtin,DOM with non-special tag
        }
        if (data.val.text && data.val.text.val === true && !label.match(/^H[1-6]$/) && label !== 'Button') label = 'TextBlock';
      }

      var indent = '';
      for (var d = 0; d < depth; d++) indent += '  ';
      lines.push(indent + label + id + classes + text);

      // Recurse into children
      if (data && data.val && data.val.children && data.val.children.val) {
        var children = data.val.children.val;
        var len = children.length || (typeof children.size === 'number' ? children.size : 0);
        for (var i = 0; i < len; i++) {
          var child = children[i] || (children.get ? children.get(i) : null);
          if (child && child.val && !(child.val.type && child.val.type[0] === 'Basic' && child.val.type[1] === 'String')) {
            walkElement(child.val, depth + 1);
          }
        }
      }
    }

    var body = pageComp.render.val;
    walkElement(body, 0);

    // Append style list
    if (allStyleNames.length > 0) {
      allStyleNames.sort();
      lines.push('');
      lines.push('── Styles ──────────────────────');
      lines.push(allStyleNames.join(', '));
    }

    // Page info
    var pageInfo = null;
    try {
      var ps = window._webflow.state.PageStore;
      if (ps && ps.currentPage) {
        pageInfo = { id: ps.currentPage, name: ps.currentPageName || null };
      }
    } catch (e) {}

    return { summary: lines.join('\n'), pageInfo: pageInfo };
  }

  function handleProbe(payload) {
    var expr = payload.expr;
    if (!expr) throw new Error('payload.expr is required');

    var _webflow = window._webflow;
    if (!_webflow) throw new Error('_webflow not available');

    var result = (new Function('_webflow', 'return (' + expr + ')'))(_webflow);
    return { value: safeSerialize(result, 0) };
  }

  function handleExecute(payload) {
    var namespace = payload.namespace;
    var method = payload.method;
    var args = payload.args || [];

    if (!namespace) throw new Error('payload.namespace is required');
    if (!method) throw new Error('payload.method is required');

    var creators = window._webflow && window._webflow.creators;
    if (!creators) throw new Error('_webflow.creators is not available');

    var ns = creators[namespace];
    if (!ns) {
      var available = Object.keys(creators).join(', ');
      throw new Error('Namespace "' + namespace + '" not found. Available: ' + available);
    }

    var fn = ns[method];
    if (typeof fn !== 'function') {
      var methods = Object.keys(ns).filter(function (k) { return typeof ns[k] === 'function'; });
      throw new Error('Method "' + method + '" not found on ' + namespace + '. Available: ' + methods.join(', '));
    }

    var result = fn.apply(ns, args);
    return { returnValue: safeSerialize(result, 0) };
  }

  // -- Delete handler ---------------------------------------------------------

  function handleDelete(payload) {
    var elementIds = payload.elementIds;
    if (!elementIds || !Array.isArray(elementIds) || elementIds.length === 0) {
      throw new Error('payload.elementIds (array) is required');
    }

    var DELAY_MS = 150;
    var deleted = 0;
    var errors = [];

    return new Promise(function (resolve) {
      var idx = 0;

      function deleteNext() {
        if (idx >= elementIds.length) {
          resolve({ deleted: deleted, errors: errors });
          return;
        }

        var elId = elementIds[idx];
        idx++;

        // Select the element
        window._webflow.dispatch({
          type: 'NODE_CLICKED',
          payload: {
            nativeIdPath: [elId],
            isMultiSelectModifierKeyActive: false,
            nativeIdInCurrentComponent: elId
          }
        });

        setTimeout(function () {
          try {
            window._webflow.dispatch({
              type: 'DELETE_KEY_PRESSED',
              payload: {
                abstractNodeState: window._webflow.state.AbstractNodeStore,
                uiNodeState: window._webflow.state.UiNodeStore,
                collectionState: window._webflow.state.CollectionStore,
                designerState: window._webflow.state.DesignerStore,
                pageState: window._webflow.state.PageStore,
                ix2State: window._webflow.state.IX2Store
              }
            });
            deleted++;
          } catch (e) {
            errors.push(elId.substring(0, 8) + ': ' + e.message);
          }
          setTimeout(deleteNext, DELAY_MS);
        }, 100);
      }

      deleteNext();
    });
  }

  // -- CMS collection connection handler ---------------------------------------

  function handleConnectCollection(payload) {
    var elementId = payload.elementId;
    var collectionId = payload.collectionId;

    if (!elementId) throw new Error('payload.elementId is required (DynamoWrapper UUID)');
    if (!collectionId) throw new Error('payload.collectionId is required');

    // Select the DynamoWrapper element first, then dispatch after a tick
    window._webflow.dispatch({
      type: 'NODE_CLICKED',
      payload: { nativeId: elementId }
    });

    return new Promise(function (resolve) {
      setTimeout(function () {
        try {
          window._webflow.dispatch({
            type: 'BINDING_CONTEXT_CHANGED',
            payload: {
              connection: {
                _kind: 'LegacyDynamoWrapperConnection/Collection',
                id: collectionId
              }
            }
          });
          resolve({ connected: true, elementId: elementId, collectionId: collectionId });
        } catch (e) {
          resolve({ connected: false, elementId: elementId, error: e.message || String(e) });
        }
      }, 500);
    });
  }

  // -- CMS field binding handler -----------------------------------------------

  function handleBind(payload) {
    var elementId = payload.elementId;
    var fieldSlug = payload.fieldSlug;
    var gateway = payload.gateway || 'dynamoPlainTextToListOfElements';

    if (!elementId) throw new Error('payload.elementId is required');
    if (!fieldSlug) throw new Error('payload.fieldSlug is required');

    // Ensure canvas iframe reference is set — DATA_TYPE_CHANGED triggers a
    // store listener that calls getActiveWindow() → getSiteIframeNext(), which
    // crashes if the closure var __siteIframeNext is null.
    var m = captureModules();
    if (m && m.setCanvasIframe) {
      var iframe = document.getElementById('site-iframe-next');
      if (iframe) {
        m.setCanvasIframe(iframe);
      }
    }

    // Select the element first
    window._webflow.dispatch({
      type: 'NODE_CLICKED',
      payload: { nativeId: elementId }
    });

    // Build binding expression — plain {type,val} objects (NOT Immutable, NOT EC constructors)
    var binding = {
      type: 'Call',
      val: {
        fun: { type: 'Variable', val: ['DynamoGateway', gateway] },
        arg: {
          type: 'Select',
          val: {
            from: { type: 'Variable', val: 'Dynamo' },
            prop: fieldSlug
          }
        }
      }
    };

    // Meta block — required by the internalReducer (reads meta.analytics.dataType)
    var meta = {
      analytics: {
        dataType: {
          type: 'TypeApplication',
          val: {
            con: { type: 'TypeConstructor', val: ['Builtin', 'List'] },
            arg: { type: 'Element', meta: { multiLine: false } }
          },
          system: {
            isBindable: true,
            label: 'Text',
            defaultValue: [{ id: 'Heading 1', type: null, text: true, data: { value: '' }, children: [] }]
          }
        },
        type: 'bind',
        from: 'node-settings'
      }
    };

    // Dispatch bind via Promise + setTimeout to avoid synchronous crash in message handler
    return new Promise(function (resolve) {
      setTimeout(function () {
        try {
          window._webflow.dispatch({
            type: 'DATA_TYPE_CHANGED',
            payload: {
              id: elementId,
              initialId: crypto.randomUUID(),
              action: {
                type: 'EXPRESSION_BIND_CHANGED',
                binding: binding,
                meta: meta,
                key: [{ 'in': 'Record', at: 'children' }]
              }
            }
          });
          resolve({
            bound: true,
            elementId: elementId,
            fieldSlug: fieldSlug,
            gateway: gateway
          });
        } catch (e) {
          resolve({
            bound: false,
            elementId: elementId,
            error: e.message || String(e)
          });
        }
      }, 500);
    });
  }

  // -- Page creation handler (UI simulation) -----------------------------------

  function handleCreatePage(payload) {
    var name = payload.name;
    if (!name) throw new Error('payload.name is required');

    var nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    ).set;

    return new Promise(function (resolve) {
      // Step 1: Open Pages panel
      var pagesBtn = document.querySelector('[data-automation-id=left-sidebar-pages-button]');
      if (!pagesBtn) return resolve({ created: false, error: 'Pages button not found' });
      pagesBtn.click();

      setTimeout(function () {
        // Step 2: Click add page menu
        var addBtn = document.querySelector('[data-automation-id=add-page-menu-button]');
        if (!addBtn) return resolve({ created: false, error: 'Add page button not found' });
        addBtn.click();

        setTimeout(function () {
          // Step 3: Click "New page"
          var newPageBtn = document.querySelector('[data-automation-id=new-page]');
          if (!newPageBtn) return resolve({ created: false, error: 'New page menu item not found' });
          newPageBtn.click();

          setTimeout(function () {
            // Step 4: Set page name
            var nameInput = document.querySelector('[data-automation-id*="page-name-input-input"]');
            if (!nameInput) return resolve({ created: false, error: 'Page name input not found' });
            nativeInputValueSetter.call(nameInput, name);
            nameInput.dispatchEvent(new Event('input', { bubbles: true }));
            nameInput.dispatchEvent(new Event('change', { bubbles: true }));

            setTimeout(function () {
              // Step 5: Click Create
              var createBtn = null;
              var btns = document.querySelectorAll('button');
              for (var i = 0; i < btns.length; i++) {
                if (btns[i].textContent.trim() === 'Create') {
                  createBtn = btns[i];
                  break;
                }
              }
              if (!createBtn) return resolve({ created: false, error: 'Create button not found' });
              createBtn.click();

              setTimeout(function () {
                // Step 6: Get the new page ID from the store
                var pageId = null;
                try {
                  var sp = window._webflow.getState().PageStore.get('staticPages');
                  sp.forEach(function (p) {
                    if (p.get('name') === name) pageId = p.get('id');
                  });
                } catch (e) { /* ignore */ }

                resolve({ created: true, name: name, pageId: pageId });
              }, 1000);
            }, 300);
          }, 500);
        }, 500);
      }, 500);
    });
  }

  // -- Add element via UI simulation (for complex factory elements like Navbar) --
  // ELEMENT_ADDED dispatch crashes for Navbar due to NavigatorStore's expandAncestors.
  // Click-to-add from the UI panel works perfectly — uses a different internal path.

  function handleAddElement(payload) {
    var elementLabel = payload.elementLabel;
    if (!elementLabel) throw new Error('payload.elementLabel is required');

    return new Promise(function (resolve) {
      // Step 1: Open Add Elements panel
      var addBtn = document.querySelector('[data-automation-id="left-sidebar-add-button"]');
      if (!addBtn) return resolve({ added: false, error: 'Add Elements button not found' });
      addBtn.click();

      // Step 2: Poll for the element card in the panel by its text label
      var attempts = 0;
      var maxAttempts = 20;
      var scrollable = null;

      function findAndClick() {
        attempts++;

        // Find scrollable panel container (for scrolling to reveal elements)
        if (!scrollable) {
          var panels = document.querySelectorAll('[class*="scrollable"], [class*="panel"]');
          for (var p = 0; p < panels.length; p++) {
            var r = panels[p].getBoundingClientRect();
            if (r.left < 280 && r.height > 200 && panels[p].scrollHeight > panels[p].clientHeight) {
              scrollable = panels[p];
              break;
            }
          }
        }

        // Scan draggable elements in the left panel for matching label
        var candidates = document.querySelectorAll('[draggable="true"]');
        var found = null;
        for (var i = 0; i < candidates.length; i++) {
          var rect = candidates[i].getBoundingClientRect();
          if (rect.left < 280 && rect.width > 20) {
            var text = (candidates[i].textContent || '').trim();
            if (text === elementLabel) {
              found = candidates[i];
              break;
            }
          }
        }

        if (found) {
          found.click();
          setTimeout(function () {
            resolve({ added: true, elementLabel: elementLabel });
          }, 1500);
        } else if (attempts < maxAttempts) {
          if (scrollable) scrollable.scrollTop += 300;
          setTimeout(findAndClick, 300);
        } else {
          resolve({ added: false, error: 'Element "' + elementLabel + '" not found in Add panel' });
        }
      }

      setTimeout(findAndClick, 800);
    });
  }

  // -- Save page settings (SEO, OG, etc.) using Immutable store record ------

  function handleSavePage(payload) {
    var pageId = payload.pageId;
    if (!pageId) throw new Error('payload.pageId is required');

    // Get the Immutable page record from the store
    var state = window._webflow.getState();
    var staticPages = state.PageStore.get('staticPages');
    var page = null;
    staticPages.forEach(function (p) {
      if (p.get('id') === pageId) page = p;
    });
    if (!page) throw new Error('Page not found in store: ' + pageId);

    // Apply updates to the Immutable record.
    // Use the exact store key names from the page record schema.
    // Webflow store keys: seoTitle, seoDesc, ogTitle, ogDesc (NOT seoDescription/ogDescription)
    var keyMap = {
      name: 'name',
      slug: 'slug',
      seoTitle: 'seoTitle',
      seoDescription: 'seoDesc',
      ogTitle: 'ogTitle',
      ogDescription: 'ogDesc',
      head: 'head',
      postBody: 'postBody',
    };
    var keys = Object.keys(keyMap);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (payload[key] !== undefined && payload[key] !== null) {
        page = page.set(keyMap[key], payload[key]);
      }
    }

    // Dispatch savePage
    window._webflow.dispatch(
      window._webflow.creators.PageActionCreators.savePage(page)
    );

    return { saved: true, pageId: pageId };
  }

  // -- Switch to a different page in the Designer -----------------------------

  function handleSwitchPage(payload) {
    var pageId = payload.pageId;
    var slug = payload.slug;
    if (!pageId && !slug) throw new Error('payload.pageId or payload.slug is required');

    // Resolve slug from pageId if not provided
    if (slug === undefined || slug === null) {
      var foundSlug = null;
      var isHome = false;
      try {
        var sp = window._webflow.getState().PageStore.get('staticPages');
        sp.forEach(function (p) {
          if (p.get('id') === pageId) {
            foundSlug = p.get('slug');
            isHome = !!p.get('isHome');
          }
        });
      } catch (e) { /* ignore */ }
      if (foundSlug === null && !isHome) throw new Error('Could not resolve slug for pageId: ' + pageId);
      slug = foundSlug || '';
    }

    // The automation ID uses the slug: e.g. "home-page", "about-page"
    // Home page slug is typically empty or "index", but automation ID is "home-page"
    var automationSlug = slug === '' || slug === 'index' ? 'home' : slug;

    var selector = '[data-automation-id="' + automationSlug + '-page"]';

    return new Promise(function (resolve) {
      // Step 1: Open Pages panel
      var pagesBtn = document.querySelector('[data-automation-id="left-sidebar-pages-button"]');
      if (!pagesBtn) return resolve({ switched: false, error: 'Pages button not found' });
      pagesBtn.click();

      // Step 2: Poll for the page element (panel renders asynchronously)
      var attempts = 0;
      var maxAttempts = 15;
      var pollInterval = 300;

      function tryClick() {
        attempts++;
        var pageEl = document.querySelector(selector);
        if (pageEl) {
          pageEl.click();
          setTimeout(function () {
            resolve({ switched: true, pageId: pageId, slug: slug });
          }, 1500);
        } else if (attempts < maxAttempts) {
          setTimeout(tryClick, pollInterval);
        } else {
          resolve({ switched: false, error: 'Page element not found after ' + maxAttempts + ' attempts: ' + selector });
        }
      }

      setTimeout(tryClick, 500);
    });
  }

  // -- Paste handler (XscpData) -----------------------------------------------
  // Selects a target element, writes XscpData to clipboard, then triggers a
  // synthetic paste event so Webflow's paste handler picks it up.

  function handlePaste(payload) {
    var xscpData = payload.xscpData;
    var targetElementId = payload.targetElementId; // element to select before pasting

    if (!xscpData) throw new Error('payload.xscpData is required (XscpData JSON object or string)');

    // Parse if string
    var xscpObj = typeof xscpData === 'string' ? JSON.parse(xscpData) : xscpData;

    // Validate structure
    if (xscpObj.type !== '@webflow/XscpData') {
      throw new Error('xscpData.type must be "@webflow/XscpData", got: ' + (xscpObj.type || 'undefined'));
    }

    if (!targetElementId) {
      throw new Error('payload.targetElementId is required — use bridge_snapshot to get an element ID');
    }

    // Select the target element (paste inserts as child of selected element)
    window._webflow.dispatch({
      type: 'NODE_CLICKED',
      payload: {
        nativeIdPath: [targetElementId],
        isMultiSelectModifierKeyActive: false,
        nativeIdInCurrentComponent: targetElementId
      }
    });

    var xscpString = JSON.stringify(xscpObj);

    // Create synthetic paste event with XscpData in clipboardData.
    // Webflow's shouldIgnoreEvent does NOT check event.isTrusted — it only checks
    // isCodeMirror6Element, activeElement focus, and contentEditable.
    // Key: dispatch on document.body (not document) so e.target.ownerDocument is valid.
    var fakeEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(fakeEvent, 'clipboardData', {
      value: {
        getData: function (type) {
          if (type === 'application/json') return xscpString;
          if (type === 'text/plain') return xscpString;
          return '';
        },
        types: ['application/json', 'text/plain'],
        items: [],
        files: []
      }
    });
    document.body.dispatchEvent(fakeEvent);

    var nodeCount = (xscpObj.payload && xscpObj.payload.nodes) ? xscpObj.payload.nodes.length : 0;
    console.log('[plinth-bridge] Synthetic paste dispatched: ' + nodeCount + ' nodes (' + xscpString.length + ' bytes)');

    return {
      pasted: true,
      targetElementId: targetElementId,
      nodeCount: nodeCount
    };
  }

  // -- Build V2: SectionSpec → XscpData paste ---------------------------------

  // Element type → XscpData node mapping
  var XSCP_TYPE_MAP = {
    Section:    { tag: 'section', type: 'Section' },
    DivBlock:   { tag: 'div',     type: 'Block' },
    Container:  { tag: 'div',     type: 'Block' },
    Heading:    { tag: null,      type: 'Heading' },  // tag set from headingLevel
    Paragraph:  { tag: 'p',       type: 'Paragraph' },
    TextBlock:  { tag: 'div',     type: 'Block' },
    BlockQuote: { tag: 'blockquote', type: 'Blockquote' },
    CodeBlock:  { tag: 'pre',     type: 'CodeBlock' },
    Button:     { tag: 'a',       type: 'Link' },
    Link:       { tag: 'a',       type: 'Link' },
    TextLink:   { tag: 'a',       type: 'Link' },
    Image:      { tag: 'img',     type: 'Image' },
    HFlex:      { tag: 'div',     type: 'Block' },
    VFlex:      { tag: 'div',     type: 'Block' },
    Grid:       { tag: 'div',     type: 'Block' },
    List:       { tag: 'ul',      type: 'List' },
    ListItem:   { tag: 'li',      type: 'ListItem' },
    CodeEmbed:  { tag: 'div',     type: 'HtmlEmbed' },
    RichText:   { tag: 'div',     type: 'RichText' },
  };

  // Resolve $variable-name references in a CSS string to @var_variable-UUID.
  // Reads style variables from _webflow.state to build the lookup map.
  function resolveVariableRefs(cssStr) {
    if (!cssStr || cssStr.indexOf('$') === -1) return cssStr;

    // Build name→UUID map from state (cached per build)
    if (!resolveVariableRefs._cache) {
      var map = {};
      try {
        var state = window._webflow.getState();
        var cvs = state.CssVariablesStore;
        if (cvs && cvs.variables) {
          var vars = cvs.variables;
          // Handle both Immutable and plain objects
          var plain = (typeof vars.toJS === 'function') ? vars.toJS() : vars;
          var varKeys = Object.keys(plain);
          for (var vi = 0; vi < varKeys.length; vi++) {
            var v = plain[varKeys[vi]];
            if (v && v.name && v.id && !v.deleted) {
              map[v.name] = v.id;
            }
          }
        }
      } catch (e) { /* ignore — variables just won't resolve */ }
      resolveVariableRefs._cache = map;
    }

    var varMap = resolveVariableRefs._cache;
    // Match $name (single word) or ${Name With Spaces} (multi-word)
    return cssStr.replace(/\$\{([^}]+)\}|\$([a-zA-Z0-9_-]+)/g, function (match, bracedName, simpleName) {
      var name = bracedName || simpleName;
      var id = varMap[name];
      if (id) return '@var_' + id;  // id is already "variable-UUID"
      return match; // leave unresolved
    });
  }

  // Look up existing style block names → _id map from state
  function getExistingStyleMap() {
    var map = {}; // name → _id
    try {
      var sb = window._webflow.state.StyleBlockStore.styleBlocks;
      sb.forEach(function (v, k) {
        var name = v.get('name');
        if (name) map[name] = k;
      });
    } catch (e) { /* ignore */ }
    return map;
  }

  // Convert a SectionSpec tree to XscpData { nodes[], styles[] }
  function treeToXscpData(tree, sharedStyles, existingStyles) {
    var nodes = [];
    var styles = []; // { _id, name, styleLess, ... }
    var styleIdMap = {}; // className → style _id (for reuse)

    // Register a style. If the style already exists in Webflow, just reference its _id
    // (don't emit — paste creates duplicates with " 2" suffix even with matching _id).
    // Track styles that need post-paste updates in stylesToUpdate[].
    var stylesToUpdate = []; // { name, cssStr } — existing styles needing property updates
    function ensureStyle(className, cssStr) {
      if (!className) return [];
      if (styleIdMap[className]) return [styleIdMap[className]];

      var existingId = existingStyles[className];
      if (existingId) {
        // Style already exists — reference it, queue for post-paste update
        styleIdMap[className] = existingId;
        if (cssStr) stylesToUpdate.push({ name: className, cssStr: cssStr });
        return [existingId];
      }

      // New style — generate ID and emit
      var styleId = crypto.randomUUID();
      styleIdMap[className] = styleId;

      var resolved = resolveVariableRefs(cssStr || '');

      styles.push({
        _id: styleId,
        fake: false,
        type: 'class',
        name: className,
        namespace: '',
        comb: '',
        styleLess: resolved || '',
        variants: {},
        children: [],
        selector: null
      });

      return [styleId];
    }

    // Recursively convert a spec node to flat XscpData nodes
    function convertNode(spec) {
      var configKey = TYPE_ALIASES[spec.type] || spec.type;
      var xscpInfo = XSCP_TYPE_MAP[configKey];
      if (!xscpInfo) throw new Error('Unknown element type for v2: ' + spec.type);

      var nodeId = crypto.randomUUID();
      var classIds = ensureStyle(spec.className, spec.styles);

      // Also add any extra classes (combo classes)
      if (spec.classes && Array.isArray(spec.classes)) {
        for (var ci = 0; ci < spec.classes.length; ci++) {
          var extraIds = ensureStyle(spec.classes[ci], '');
          classIds = classIds.concat(extraIds);
        }
      }

      // Determine tag
      var tag = xscpInfo.tag;
      if (configKey === 'Heading') {
        var level = spec.headingLevel || 2;
        tag = 'h' + level;
      } else if (configKey === 'List' && spec.ordered) {
        tag = 'ol';
      }

      // Build data object
      var data = { tag: tag };

      // Text flag
      if (spec.text || configKey === 'Heading' || configKey === 'Paragraph' ||
          configKey === 'TextBlock' || configKey === 'BlockQuote' || configKey === 'Button' ||
          configKey === 'TextLink' || configKey === 'CodeBlock') {
        data.text = true;
      } else {
        data.text = false;
      }

      // Section grid data
      if (configKey === 'Section') {
        data.tag = 'section';
        data.grid = { type: 'section' };
      }

      // Link/Button data
      if (configKey === 'Button') {
        data.button = true;
        data.link = { url: spec.href || '#', target: '' };
      } else if (configKey === 'Link' || configKey === 'TextLink') {
        data.link = { url: spec.href || '#', target: spec.target || '' };
      }

      // Image data
      if (configKey === 'Image') {
        data.attr = { src: spec.src || '', alt: spec.alt || '' };
        data.img = { id: '' };
      }

      // Code embed
      if (configKey === 'CodeEmbed') {
        data.embed = { type: 'custom', meta: { html: spec.code || spec.text || '' } };
      }

      // HFlex / VFlex / Grid — set display style inline if not in styles string
      if (configKey === 'HFlex') {
        data.xattr = [{ name: 'data-w-layout', value: 'hflex' }];
      } else if (configKey === 'VFlex') {
        data.xattr = [{ name: 'data-w-layout', value: 'vflex' }];
      }

      // Children
      var childIds = [];

      // Text content → text child node
      if (spec.text && data.text) {
        var textId = crypto.randomUUID();
        childIds.push(textId);
        nodes.push({ _id: textId, text: true, v: spec.text });
      }

      // Recurse children
      if (spec.children && spec.children.length > 0) {
        for (var i = 0; i < spec.children.length; i++) {
          var childId = convertNode(spec.children[i]);
          childIds.push(childId);
        }
      }

      // Build node
      var node = {
        _id: nodeId,
        tag: tag,
        classes: classIds,
        children: childIds,
        type: xscpInfo.type,
        data: data
      };

      nodes.push(node);
      return nodeId;
    }

    // Convert main tree
    var rootId = convertNode(tree);

    // Add shared styles (not attached to any element in this section)
    if (sharedStyles && sharedStyles.length > 0) {
      for (var si = 0; si < sharedStyles.length; si++) {
        var ss = sharedStyles[si];
        ensureStyle(ss.name, ss.styles || '');
      }
    }

    return { nodes: nodes, styles: styles, rootId: rootId, stylesToUpdate: stylesToUpdate };
  }

  // Placeholder — __DEPRECATED__STYLE_BLOCK_STATE_CHANGED crashes when updating styleLess.
  // Existing styles are referenced by _id but their CSS properties are NOT updated.
  // To update existing style properties, use the v1 setStyle pipeline or update_styles tool.
  function updateExistingStyles(stylesToUpdate) {
    if (stylesToUpdate && stylesToUpdate.length > 0) {
      console.log('[plinth-bridge] ' + stylesToUpdate.length + ' existing styles skipped (use update_styles to fix)');
    }
    return Promise.resolve(0);
  }

  function handleBuildV2(payload) {
    var tree = payload.tree;
    if (!tree) throw new Error('payload.tree is required');

    // Clear variable resolution cache for this build
    resolveVariableRefs._cache = null;

    // Get existing styles for reuse
    var existingStyles = getExistingStyleMap();

    // Convert to XscpData
    var xscpResult = treeToXscpData(tree, payload.sharedStyles, existingStyles);

    // Wrap in XscpData envelope
    var xscpData = {
      type: '@webflow/XscpData',
      payload: {
        nodes: xscpResult.nodes,
        styles: xscpResult.styles,
        assets: [],
        ix1: [],
        ix2: { interactions: [], events: [], actionLists: [] }
      },
      meta: {
        unlinkedSymbolCount: 0,
        droppedLinks: 0,
        dynBindRemovedCount: 0,
        dynListBindRemovedCount: 0,
        paginationRemovedCount: 0
      }
    };

    // Merge ix2 data if provided
    if (payload.ix2) {
      xscpData.payload.ix2 = payload.ix2;
    }

    // Find insertion target
    var dsState = window._webflow.state.DesignerStore;
    if (!dsState) throw new Error('DesignerStore not found');
    var pageComp = null;
    dsState.components.forEach(function (v, k) {
      var ks = String(k);
      if (ks.indexOf('SitePlugin') >= 0 && ks.indexOf('page') >= 0) pageComp = v;
    });
    if (!pageComp) throw new Error('Page component not found');
    var bodyEl = pageComp.render && pageComp.render.val;
    var bodyId = bodyEl && bodyEl.id;
    if (!bodyId) throw new Error('Body element not found');

    var targetElementId = bodyId;

    if (payload.parentElementId) {
      targetElementId = payload.parentElementId;
    } else if (payload.insertAfterSectionClass) {
      // For insertAfter, we select the section — paste inserts as child of selected.
      // But we want to insert AFTER it, not inside it.
      // Strategy: select the parent (body) and let paste append, then reorder if needed.
      // Actually, Webflow paste inserts as child of selection.
      // To insert after a section, we select the body and paste — it appends at end.
      // Then we note we may need to reorder.
      // For now, just select body and note the target for potential reorder.
      targetElementId = bodyId;
    } else if (payload.insertAfterElementId) {
      targetElementId = bodyId;
    }

    // Select target and paste
    window._webflow.dispatch({
      type: 'NODE_CLICKED',
      payload: {
        nativeIdPath: [targetElementId],
        isMultiSelectModifierKeyActive: false,
        nativeIdInCurrentComponent: targetElementId
      }
    });

    var xscpString = JSON.stringify(xscpData);

    // Small delay to let NODE_CLICKED settle before paste
    return new Promise(function (resolve) {
      setTimeout(function () {
        // Synthetic paste event
        var fakeEvent = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(fakeEvent, 'clipboardData', {
          value: {
            getData: function (type) {
              if (type === 'application/json') return xscpString;
              if (type === 'text/plain') return xscpString;
              return '';
            },
            types: ['application/json', 'text/plain'],
            items: [],
            files: []
          }
        });
        document.body.dispatchEvent(fakeEvent);

        var nodeCount = xscpData.payload.nodes.length;
        var styleCount = xscpData.payload.styles.length;
        console.log('[plinth-bridge] build_v2 paste: ' + nodeCount + ' nodes, ' + styleCount + ' styles');

        // If we need to reorder (insertAfterSectionClass), do it after paste settles
        if (payload.insertAfterSectionClass || payload.insertAfterElementId) {
          setTimeout(function () {
            // After paste, find the newly pasted section (root node) and reorder
            // The pasted section should be the last child of body now
            var afterClass = payload.insertAfterSectionClass;
            var afterId = payload.insertAfterElementId;

            // Re-read state after paste
            var freshState = window._webflow.state.DesignerStore;
            var freshPage = null;
            freshState.components.forEach(function (v, k) {
              var ks = String(k);
              if (ks.indexOf('SitePlugin') >= 0 && ks.indexOf('page') >= 0) freshPage = v;
            });

            if (freshPage) {
              var freshBody = freshPage.render && freshPage.render.val;
              if (freshBody && freshBody.data && freshBody.data.val &&
                  freshBody.data.val.children && freshBody.data.val.children.val) {
                var bodyChildren = freshBody.data.val.children.val;
                var len = bodyChildren.length || (typeof bodyChildren.size === 'number' ? bodyChildren.size : 0);

                // Find the target "after" element index
                var targetIdx = -1;
                var pastedIdx = len - 1; // paste appends at end

                for (var bi = 0; bi < len; bi++) {
                  var ch = bodyChildren[bi] || (bodyChildren.get ? bodyChildren.get(bi) : null);
                  if (!ch || !ch.val) continue;

                  if (afterId && ch.val.id === afterId) {
                    targetIdx = bi;
                  } else if (afterClass) {
                    // Check style blocks for class name match
                    var chData = ch.val.data;
                    if (chData && chData.val && chData.val.styleBlockIds && chData.val.styleBlockIds.val) {
                      var sbIds = chData.val.styleBlockIds.val;
                      var sb = window._webflow.state.StyleBlockStore.styleBlocks;
                      for (var si = 0; si < (sbIds.length || sbIds.size || 0); si++) {
                        var sbEntry = sbIds[si] || (sbIds.get ? sbIds.get(si) : null);
                        if (sbEntry) {
                          var sbId = sbEntry.val || sbEntry;
                          var block = sb.get(sbId);
                          if (block && block.get('name') === afterClass) {
                            targetIdx = bi;
                          }
                        }
                      }
                    }
                  }
                }

                if (targetIdx >= 0 && pastedIdx > targetIdx + 1) {
                  // Need to move: select pasted element, then move after target
                  var pastedChild = bodyChildren[pastedIdx] || (bodyChildren.get ? bodyChildren.get(pastedIdx) : null);
                  var targetChild = bodyChildren[targetIdx] || (bodyChildren.get ? bodyChildren.get(targetIdx) : null);
                  if (pastedChild && pastedChild.val && targetChild && targetChild.val) {
                    window._webflow.dispatch({
                      type: 'ELEMENT_MOVED',
                      payload: {
                        nativeId: pastedChild.val.id,
                        targetNativeId: targetChild.val.id,
                        position: 'after',
                        designerState: window._webflow.state.DesignerStore,
                        uiNodeState: window._webflow.state.UiNodeStore
                      }
                    });
                    console.log('[plinth-bridge] build_v2 reordered section after target');
                  }
                }
              }
            }

            updateExistingStyles(xscpResult.stylesToUpdate).then(function (updatedCount) {
              resolve({
                success: true,
                nodeCount: nodeCount,
                styleCount: styleCount,
                updatedStyleCount: updatedCount,
                rootId: xscpResult.rootId,
                reordered: true
              });
            });
          }, 500); // wait for paste to settle
        } else {
          updateExistingStyles(xscpResult.stylesToUpdate).then(function (updatedCount) {
            resolve({
              success: true,
              nodeCount: nodeCount,
              styleCount: styleCount,
              updatedStyleCount: updatedCount,
              rootId: xscpResult.rootId,
              reordered: false
            });
          });
        }
      }, 200); // wait for NODE_CLICKED
    });
  }

  // -- List Variables handler ---------------------------------------------------

  // -- Variable creation via RPC dispatch ------------------------------------
  // Dispatches POST_MESSAGE_RECEIVED with JSON-RPC payload to invoke
  // Webflow's internal createColorVariable / createSizeVariable / etc. handlers.
  // This goes through the full RPC chain: validate, dedupe names, update store, persist to server.

  var VARIABLE_TYPE_METHODS = {
    color: 'createColorVariable',
    length: 'createSizeVariable',
    'font-family': 'createFontFamilyVariable',
    number: 'createNumberVariable',
    percentage: 'createPercentageVariable'
  };

  function handleCreateVariables(payload) {
    var variables = payload.variables || [];
    if (!variables.length) return { created: [], error: 'No variables provided' };

    var collectionId = payload.collectionId;
    if (!collectionId) {
      // Default to first non-default collection
      var state = window._webflow.getState();
      var cvs = state.CssVariablesStore;
      if (cvs && cvs.variableCollections) {
        var colls = (typeof cvs.variableCollections.toJS === 'function') ? cvs.variableCollections.toJS() : cvs.variableCollections;
        var collKeys = Object.keys(colls);
        for (var ci = 0; ci < collKeys.length; ci++) {
          var c = colls[collKeys[ci]];
          if (c && !c.isDefault && !c.deleted) {
            collectionId = c.id;
            break;
          }
        }
      }
      if (!collectionId) return { created: [], error: 'No variable collection found' };
    }

    var created = [];
    var errors = [];

    for (var i = 0; i < variables.length; i++) {
      var v = variables[i];
      var type = v.type || 'color';
      var method = VARIABLE_TYPE_METHODS[type];
      if (!method) {
        errors.push({ name: v.name, error: 'Unknown type: ' + type });
        continue;
      }

      var varId = 'variable-' + crypto.randomUUID();
      var params = {
        id: varId,
        name: v.name,
        collectionId: collectionId
      };

      // Build value based on type
      if (type === 'color') {
        params.value = { type: 'color', value: v.value };
      } else if (type === 'length') {
        // value should be { value: number, unit: string }
        params.value = v.value;
      } else if (type === 'font-family') {
        params.value = { type: 'font-family', value: v.value };
      } else {
        params.value = { type: type, value: v.value };
      }

      try {
        window._webflow.dispatch({
          type: 'POST_MESSAGE_RECEIVED',
          payload: {
            data: {
              jsonrpc: '2.0',
              id: String(Date.now()) + '-' + i,
              method: method,
              params: params
            },
            source: 'plinth-bridge',
            communicationType: 'localEvent'
          }
        });
        created.push({ id: varId, name: v.name, type: type });
      } catch (e) {
        errors.push({ name: v.name, error: e.message || String(e) });
      }
    }

    return {
      created: created,
      errors: errors.length ? errors : undefined,
      count: created.length,
      collectionId: collectionId
    };
  }

  function handleListVariables() {
    var variables = [];
    var collections = {};
    try {
      var state = window._webflow.getState();
      var cvs = state.CssVariablesStore;
      if (!cvs) return { variables: [], count: 0, error: 'CssVariablesStore not found' };

      // Build collection name map
      var rawColls = cvs.variableCollections;
      if (rawColls) {
        var plainColls = (typeof rawColls.toJS === 'function') ? rawColls.toJS() : rawColls;
        var collKeys = Object.keys(plainColls);
        for (var ci = 0; ci < collKeys.length; ci++) {
          var coll = plainColls[collKeys[ci]];
          if (coll && coll.id) collections[coll.id] = coll.name || '';
        }
      }

      // Read variables
      if (cvs.variables) {
        var rawVars = cvs.variables;
        var plainVars = (typeof rawVars.toJS === 'function') ? rawVars.toJS() : rawVars;
        var varKeys = Object.keys(plainVars);
        for (var vi = 0; vi < varKeys.length; vi++) {
          var v = plainVars[varKeys[vi]];
          if (!v || v.deleted) continue;
          var entry = {
            id: v.id,
            name: v.name || '',
            type: v.type || '',
          };
          // Extract display value
          if (v.value && typeof v.value === 'object') {
            entry.value = v.value.value || '';
            entry.valueType = v.value.type || '';
          } else {
            entry.value = v.value || '';
          }
          if (v.collectionId && collections[v.collectionId]) {
            entry.collection = collections[v.collectionId];
          }
          variables.push(entry);
        }
      }
    } catch (e) {
      return { variables: variables, error: e.message || String(e) };
    }
    return { variables: variables, count: variables.length };
  }

  // -- Capture XscpData handler -------------------------------------------------

  // -- Update existing styles via v1 setStyle pipeline -----------------------
  // Accepts { styles: [{ name, properties: { cssProperty: value } }] }
  // Finds an element with the given class, selects it, and applies styles.
  function handleUpdateStyles(payload) {
    var styleEntries = payload.styles;
    if (!styleEntries || !styleEntries.length) throw new Error('payload.styles[] is required');

    var ds = window._webflow.state && window._webflow.state.DesignerStore;
    if (!ds) throw new Error('DesignerStore not available');

    // Build styleId → name map from StyleBlockStore
    var sb = window._webflow.state.StyleBlockStore.styleBlocks;
    var styleIdToName = {};
    var styleNameToId = {};
    sb.forEach(function (v, k) {
      var name = v.get('name');
      if (name) {
        styleIdToName[k] = name;
        styleNameToId[name] = k;
      }
    });

    // Walk the expression tree (same structure as handleSnapshot) to find className → elementId
    var classToElementId = {};
    function walkForClasses(el) {
      if (!el) return;
      var id = el.id || null;
      var data = el.data;
      if (data && data.val && data.val.styleBlockIds && data.val.styleBlockIds.val) {
        var sbIds = data.val.styleBlockIds.val;
        var len = sbIds.length || (typeof sbIds.size === 'number' ? sbIds.size : 0);
        for (var i = 0; i < len; i++) {
          var sbEntry = sbIds[i] || (sbIds.get ? sbIds.get(i) : null);
          if (sbEntry) {
            var sbId = sbEntry.val || sbEntry;
            var nm = styleIdToName[sbId];
            if (nm && !classToElementId[nm]) {
              classToElementId[nm] = id;
            }
          }
        }
      }
      // Recurse into children
      if (data && data.val && data.val.children && data.val.children.val) {
        var children = data.val.children.val;
        var cLen = children.length || (typeof children.size === 'number' ? children.size : 0);
        for (var i = 0; i < cLen; i++) {
          var child = children[i] || (children.get ? children.get(i) : null);
          if (child && child.val) walkForClasses(child.val);
        }
      }
    }

    // Find the page component and walk from body
    var pageComp = null;
    ds.components.forEach(function (v, k) {
      var ks = String(k);
      if (ks.indexOf('SitePlugin') >= 0 && ks.indexOf('page') >= 0) pageComp = v;
    });
    if (pageComp && pageComp.render && pageComp.render.val) {
      walkForClasses(pageComp.render.val);
    }

    var SETTLE_MS = 300;
    var SYNC_MS = 100;

    // Process each style entry sequentially
    function processEntry(index, results) {
      if (index >= styleEntries.length) {
        return Promise.resolve(results);
      }

      var entry = styleEntries[index];
      var name = entry.name;
      var properties = entry.properties || {};
      var elementId = classToElementId[name];

      if (!elementId) {
        results.push({ name: name, ok: false, error: 'No element found with class "' + name + '"' });
        return processEntry(index + 1, results);
      }

      // Select the element
      window._webflow.dispatch({
        type: 'NODE_CLICKED',
        payload: {
          nativeIdPath: [elementId],
          isMultiSelectModifierKeyActive: false,
          nativeIdInCurrentComponent: elementId
        }
      });

      return new Promise(function (resolve) {
        setTimeout(function () {
          // Sync canvas node
          syncCanvasNode(elementId);

          setTimeout(function () {
            // Apply styles
            applyStyles(properties).then(function () {
              var propCount = Object.keys(properties).length;
              results.push({ name: name, ok: true, propertiesSet: propCount });
              // Next entry
              setTimeout(function () {
                resolve(processEntry(index + 1, results));
              }, 100);
            });
          }, SYNC_MS);
        }, SETTLE_MS);
      });
    }

    return processEntry(0, []).then(function (results) {
      var ok = results.filter(function (r) { return r.ok; }).length;
      var failed = results.filter(function (r) { return !r.ok; }).length;
      return { updated: ok, failed: failed, results: results };
    });
  }

  function handleCaptureXscp(payload) {
    var elementId = payload.elementId;
    if (!elementId) throw new Error('payload.elementId is required');

    // Select the element
    window._webflow.dispatch({
      type: 'NODE_CLICKED',
      payload: {
        nativeIdPath: [elementId],
        isMultiSelectModifierKeyActive: false,
        nativeIdInCurrentComponent: elementId
      }
    });

    return new Promise(function (resolve) {
      setTimeout(function () {
        // Strategy: dispatch a synthetic 'copy' event with a writable clipboardData.
        // Webflow's copy handler (registered on the copy event) serializes the selected
        // element and calls clipboardData.setData('application/json', xscpJSON).
        // We intercept that via our fake clipboardData.
        var captured = null;

        var fakeClipboard = {
          _data: {},
          setData: function (type, data) {
            this._data[type] = data;
            if (type === 'application/json') {
              try { captured = JSON.parse(data); } catch (e) { /* ignore */ }
            }
          },
          getData: function (type) { return this._data[type] || ''; },
          clearData: function () { this._data = {}; },
          types: [],
          items: [],
          files: []
        };

        var copyEvent = new Event('copy', { bubbles: true, cancelable: true });
        Object.defineProperty(copyEvent, 'clipboardData', { value: fakeClipboard });
        document.body.dispatchEvent(copyEvent);

        if (captured) {
          resolve({
            captured: true,
            elementId: elementId,
            xscpData: captured,
            nodeCount: (captured.payload && captured.payload.nodes) ? captured.payload.nodes.length : 0,
            styleCount: (captured.payload && captured.payload.styles) ? captured.payload.styles.length : 0
          });
        } else {
          resolve({
            captured: false,
            elementId: elementId,
            error: 'No XscpData captured. Webflow copy handler may not have fired.'
          });
        }
      }, 300); // wait for NODE_CLICKED
    });
  }

  // -- Message listener ------------------------------------------------------

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    var msg = event.data;
    if (!msg || !msg.__plinthBridge || msg.direction !== 'command') return;

    var id = msg.id;
    var type = msg.type;

    function sendResult(ok, data, error) {
      window.postMessage({
        __plinthBridge: true,
        direction: 'result',
        id: id,
        ok: ok,
        data: data,
        error: error,
      }, '*');
    }

    try {
      var result;
      switch (type) {
        case 'ping':
          result = handlePing();
          break;
        case 'snapshot':
          result = handleSnapshot();
          break;
        case 'execute':
          result = handleExecute(msg.payload || {});
          break;
        case 'probe':
          result = handleProbe(msg.payload || {});
          break;
        case 'build':
          result = handleBuild(msg.payload || {});
          break;
        case 'delete':
          result = handleDelete(msg.payload || {});
          break;
        case 'bind':
          result = handleBind(msg.payload || {});
          break;
        case 'connect_collection':
          result = handleConnectCollection(msg.payload || {});
          break;
        case 'create_page':
          result = handleCreatePage(msg.payload || {});
          break;
        case 'save_page':
          result = handleSavePage(msg.payload || {});
          break;
        case 'switch_page':
          result = handleSwitchPage(msg.payload || {});
          break;
        case 'add_element':
          result = handleAddElement(msg.payload || {});
          break;
        case 'paste':
          result = handlePaste(msg.payload || {});
          break;
        case 'build_v2':
          result = handleBuildV2(msg.payload || {});
          break;
        case 'list_variables':
          result = handleListVariables();
          break;
        case 'create_variables':
          result = handleCreateVariables(msg.payload || {});
          break;
        case 'capture_xscp':
          result = handleCaptureXscp(msg.payload || {});
          break;
        case 'update_styles':
          result = handleUpdateStyles(msg.payload || {});
          break;
        default:
          throw new Error('Unknown command type: ' + type);
      }

      // handleBuild returns a Promise (async element creation with delays)
      if (result && typeof result.then === 'function') {
        result.then(function (data) {
          sendResult(true, data, null);
        }).catch(function (e) {
          sendResult(false, null, e.message || String(e));
        });
      } else {
        sendResult(true, result, null);
      }
    } catch (e) {
      sendResult(false, null, e.message || String(e));
    }
  });
})();
