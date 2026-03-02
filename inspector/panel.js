// Plinth Inspector — Panel Logic
// All probe functionality for the 4 tabs: Globals, Messages, Elements, Presets

(function () {
  'use strict';

  // ── Helpers ──────────────────────────────────────────────────────────

  function evalInPage(code) {
    return new Promise((resolve, reject) => {
      chrome.devtools.inspectedWindow.eval(code, (result, exInfo) => {
        if (exInfo && exInfo.isError) reject(new Error(exInfo.value));
        else if (exInfo && exInfo.isException) reject(new Error(exInfo.value));
        else resolve(result);
      });
    });
  }

  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return document.querySelectorAll(sel); }

  function escHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function formatJson(obj) {
    try {
      return JSON.stringify(obj, null, 2);
    } catch {
      return String(obj);
    }
  }

  function timeStr(ts) {
    const d = new Date(ts);
    return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }

  // ── Tab Switching ───────────────────────────────────────────────────

  $$('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tab').forEach(t => t.classList.remove('active'));
      $$('.tab-content').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      $(`#tab-${btn.dataset.tab}`).classList.add('active');
    });
  });

  // ── Tab 1: Globals ──────────────────────────────────────────────────

  const globalsOutput = $('#globals-output');

  const WEBFLOW_KEYS = [
    'webflow', 'Webflow', '__WEBFLOW__', '__NEXT_DATA__', '_wf',
    '__wf_store', '__wf_redux', 'wf', 'WF', '__wf',
    '_wfDesigner', 'webflowDesigner', '__webflow'
  ];

  $('#btn-scan-window').addEventListener('click', async () => {
    globalsOutput.innerHTML = '<span class="info">Scanning window globals...</span>';
    try {
      const code = `
        (function() {
          var keys = ${JSON.stringify(WEBFLOW_KEYS)};
          var results = [];
          // Check explicit keys
          keys.forEach(function(k) {
            try {
              var v = window[k];
              if (v !== undefined) {
                var type = typeof v;
                var ctor = v && v.constructor ? v.constructor.name : type;
                var topKeys = [];
                if (type === 'object' && v !== null) {
                  try { topKeys = Object.keys(v).slice(0, 20); } catch(e) {}
                }
                results.push({ key: k, type: type, ctor: ctor, topKeys: topKeys });
              }
            } catch(e) {
              results.push({ key: k, error: e.message });
            }
          });
          // Scan all window keys for webflow/wf patterns
          try {
            var allKeys = Object.getOwnPropertyNames(window);
            allKeys.forEach(function(k) {
              if (/webflow|^wf|^_wf|^__wf/i.test(k) && !keys.includes(k)) {
                try {
                  var v = window[k];
                  var type = typeof v;
                  results.push({ key: k, type: type, ctor: v && v.constructor ? v.constructor.name : type, topKeys: [], discovered: true });
                } catch(e) {}
              }
            });
          } catch(e) {}
          return results;
        })()
      `;
      const results = await evalInPage(code);
      if (!results || results.length === 0) {
        globalsOutput.innerHTML = '<span class="info">No Webflow-related globals found on window.</span>';
        return;
      }
      let html = '';
      for (const r of results) {
        if (r.error) {
          html += `<div class="kv-row"><span class="kv-key">${escHtml(r.key)}</span>: <span class="error">${escHtml(r.error)}</span></div>`;
        } else {
          html += `<div class="kv-row">`;
          html += `<span class="kv-key">${escHtml(r.key)}</span>`;
          if (r.discovered) html += ` <span class="info">(discovered)</span>`;
          html += `: <span class="kv-type">${escHtml(r.ctor)}</span>`;
          if (r.topKeys && r.topKeys.length > 0) {
            html += ` { <span class="kv-keys">${r.topKeys.map(k => escHtml(k)).join(', ')}</span>`;
            if (r.topKeys.length === 20) html += ', ...';
            html += ' }';
          }
          html += `</div>`;
        }
      }
      globalsOutput.innerHTML = html;
    } catch (err) {
      globalsOutput.innerHTML = `<span class="error">Error: ${escHtml(err.message)}</span>`;
    }
  });

  $('#btn-find-react').addEventListener('click', async () => {
    globalsOutput.innerHTML = '<span class="info">Searching for React fiber roots...</span>';
    try {
      const code = `
        (function() {
          var results = [];
          var candidates = document.querySelectorAll('body, body > *, #root, #__next, [id*="app"], [id*="root"]');
          var seen = new Set();
          candidates.forEach(function(el) {
            if (seen.has(el)) return;
            seen.add(el);
            var keys = Object.keys(el);
            keys.forEach(function(k) {
              if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$') || k.startsWith('__reactContainer$')) {
                var fiber = el[k];
                var name = '(unknown)';
                try {
                  if (fiber && fiber.type && fiber.type.name) name = fiber.type.name;
                  else if (fiber && fiber.elementType && fiber.elementType.name) name = fiber.elementType.name;
                } catch(e) {}
                results.push({
                  tag: el.tagName.toLowerCase(),
                  id: el.id || null,
                  className: (el.className || '').toString().slice(0, 80),
                  fiberKey: k,
                  componentName: name
                });
              }
            });
          });
          // Also check all iframes
          var iframes = document.querySelectorAll('iframe');
          iframes.forEach(function(iframe, idx) {
            try {
              var doc = iframe.contentDocument;
              if (!doc) return;
              var root = doc.querySelector('#root, body');
              if (!root) return;
              var keys = Object.keys(root);
              keys.forEach(function(k) {
                if (k.startsWith('__reactFiber$') || k.startsWith('__reactContainer$')) {
                  results.push({ tag: 'iframe#' + idx + ' > ' + root.tagName.toLowerCase(), id: root.id, fiberKey: k, iframe: true });
                }
              });
            } catch(e) {
              results.push({ tag: 'iframe#' + idx, error: 'cross-origin: ' + e.message, iframe: true });
            }
          });
          return results;
        })()
      `;
      const results = await evalInPage(code);
      if (!results || results.length === 0) {
        globalsOutput.innerHTML = '<span class="info">No React fiber roots found.</span>';
        return;
      }
      let html = `<div class="success">Found ${results.length} React root(s):</div>`;
      for (const r of results) {
        html += '<div class="kv-row">';
        html += `<span class="el-tag">${escHtml(r.tag)}</span>`;
        if (r.id) html += `<span class="el-id">#${escHtml(r.id)}</span>`;
        if (r.className) html += ` <span class="el-class">.${escHtml(r.className.split(' ')[0])}</span>`;
        html += ` <span class="kv-type">${escHtml(r.fiberKey)}</span>`;
        if (r.componentName) html += ` → <span class="kv-val">${escHtml(r.componentName)}</span>`;
        if (r.error) html += ` <span class="error">${escHtml(r.error)}</span>`;
        if (r.iframe) html += ` <span class="info">(iframe)</span>`;
        html += '</div>';
      }
      globalsOutput.innerHTML = html;
    } catch (err) {
      globalsOutput.innerHTML = `<span class="error">Error: ${escHtml(err.message)}</span>`;
    }
  });

  // ── Tab 2: Messages ─────────────────────────────────────────────────

  const messagesList = $('#messages-list');
  const messagesStatus = $('#messages-status');
  const filterDesignerToExt = $('#filter-designer-to-ext');
  const filterExtToDesigner = $('#filter-ext-to-designer');
  const msgSearch = $('#msg-search');
  let messages = [];
  let paused = false;
  let pollTimer = null;

  function shouldShowMsg(msg) {
    if (msg.dir === 'in' && !filterDesignerToExt.checked) return false;
    if (msg.dir === 'out' && !filterExtToDesigner.checked) return false;
    const search = msgSearch.value.trim().toLowerCase();
    if (search && !msg.method.toLowerCase().includes(search)) return false;
    return true;
  }

  function renderMessages() {
    const filtered = messages.filter(shouldShowMsg);
    // Virtual scroll: show last 200
    const visible = filtered.slice(-200);
    let html = '';
    for (const msg of visible) {
      const dirClass = msg.dir === 'in' ? 'incoming' : 'outgoing';
      const dirArrow = msg.dir === 'in' ? '\u2190' : '\u2192';
      const preview = msg.method === '(unknown)' ? JSON.stringify(msg.data).slice(0, 80) : '';
      html += `<div class="msg-entry" data-idx="${msg._idx}">`;
      html += `<span class="msg-time">${timeStr(msg.ts)}</span>`;
      html += `<span class="msg-dir ${dirClass}">${dirArrow}</span>`;
      html += `<span class="msg-method">${escHtml(msg.method)}</span>`;
      if (preview) html += `<span class="msg-preview">${escHtml(preview)}</span>`;
      html += `</div>`;
      html += `<div class="msg-detail" data-idx="${msg._idx}">${escHtml(formatJson(msg.data))}</div>`;
    }
    messagesList.innerHTML = html;
    messagesStatus.textContent = `${filtered.length} messages (${messages.length} total)${paused ? ' — PAUSED' : ''}`;

    // Auto-scroll to bottom
    messagesList.scrollTop = messagesList.scrollHeight;
  }

  // Click to expand/collapse message detail
  messagesList.addEventListener('click', (e) => {
    const entry = e.target.closest('.msg-entry');
    if (!entry) return;
    const idx = entry.dataset.idx;
    const detail = messagesList.querySelector(`.msg-detail[data-idx="${idx}"]`);
    if (detail) {
      detail.classList.toggle('visible');
      entry.classList.toggle('expanded');
    }
  });

  async function pollMessages() {
    if (paused) return;
    try {
      const code = `
        (function() {
          var buf = window.__plinthInspectorBuffer;
          if (!buf || buf.length === 0) return [];
          var items = buf.splice(0, buf.length);
          return items;
        })()
      `;
      const items = await evalInPage(code);
      if (items && items.length > 0) {
        for (const item of items) {
          item._idx = messages.length;
          messages.push(item);
        }
        // Cap at 2000
        if (messages.length > 2000) {
          messages = messages.slice(-2000);
        }
        renderMessages();
      }
    } catch {
      // Page may not have the buffer yet — ignore
    }
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(pollMessages, 250);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  $('#btn-msg-pause').addEventListener('click', () => {
    paused = !paused;
    $('#btn-msg-pause').textContent = paused ? 'Resume' : 'Pause';
    renderMessages();
  });

  $('#btn-msg-clear').addEventListener('click', () => {
    messages = [];
    renderMessages();
  });

  filterDesignerToExt.addEventListener('change', renderMessages);
  filterExtToDesigner.addEventListener('change', renderMessages);
  msgSearch.addEventListener('input', renderMessages);

  // Start polling when Messages tab is active
  startPolling();

  // ── Tab 3: Elements ─────────────────────────────────────────────────

  const elementsOutput = $('#elements-output');
  const snapshotOutput = $('#snapshot-output');

  $('#btn-dump-elements').addEventListener('click', async () => {
    elementsOutput.innerHTML = '<span class="info">Dumping canvas elements...</span>';
    try {
      const code = `
        (function() {
          function walkEl(el, depth) {
            if (depth > 10) return null;
            var info = {
              tag: el.tagName ? el.tagName.toLowerCase() : '?',
              id: el.id || null,
              className: el.className && typeof el.className === 'string' ? el.className : null,
              wfId: el.getAttribute ? el.getAttribute('data-w-id') : null,
              wfType: el.getAttribute ? el.getAttribute('data-wf-type') : null,
              childCount: el.children ? el.children.length : 0,
              children: []
            };
            if (el.children) {
              for (var i = 0; i < el.children.length && i < 50; i++) {
                var child = walkEl(el.children[i], depth + 1);
                if (child) info.children.push(child);
              }
            }
            return info;
          }
          // Try to find the canvas iframe
          var iframes = document.querySelectorAll('iframe');
          for (var i = 0; i < iframes.length; i++) {
            try {
              var doc = iframes[i].contentDocument;
              if (!doc) continue;
              var body = doc.querySelector('body');
              if (!body) continue;
              // Check if this looks like the canvas (has sections or wf elements)
              if (body.children.length > 0) {
                return { source: 'iframe#' + i, tree: walkEl(body, 0) };
              }
            } catch(e) {
              // cross-origin
            }
          }
          // Fallback: dump main document body
          return { source: 'main', tree: walkEl(document.body, 0) };
        })()
      `;
      const result = await evalInPage(code);
      if (!result || !result.tree) {
        elementsOutput.innerHTML = '<span class="info">No elements found.</span>';
        return;
      }
      elementsOutput.innerHTML = `<div class="info">Source: ${escHtml(result.source)}</div>` + renderElementTree(result.tree, 0);
    } catch (err) {
      elementsOutput.innerHTML = `<span class="error">Error: ${escHtml(err.message)}</span>`;
    }
  });

  function renderElementTree(node, depth) {
    if (!node) return '';
    let html = '<div class="kv-row" style="padding-left:' + (depth * 16) + 'px">';
    html += `<span class="el-tag">&lt;${escHtml(node.tag)}&gt;</span>`;
    if (node.id) html += ` <span class="el-id">#${escHtml(node.id)}</span>`;
    if (node.className) html += ` <span class="el-class">.${escHtml(node.className.split(' ').join(' .'))}</span>`;
    if (node.wfId) html += ` <span class="el-attr">w-id=${escHtml(node.wfId)}</span>`;
    if (node.wfType) html += ` <span class="el-attr">wf-type=${escHtml(node.wfType)}</span>`;
    if (node.childCount > 0 && (!node.children || node.children.length === 0)) {
      html += ` <span class="el-children">(${node.childCount} children, truncated)</span>`;
    }
    html += '</div>';
    if (node.children) {
      for (const child of node.children) {
        html += renderElementTree(child, depth + 1);
      }
    }
    return html;
  }

  $('#btn-inspect-selected').addEventListener('click', async () => {
    elementsOutput.innerHTML = '<span class="info">Looking for selected element state...</span>';
    try {
      const code = `
        (function() {
          // Try common Webflow internal state patterns
          var results = {};
          // Check for selection state in window
          var keys = Object.getOwnPropertyNames(window);
          keys.forEach(function(k) {
            if (/select|chosen|active|current/i.test(k) && /element|node|el/i.test(k)) {
              try {
                var v = window[k];
                if (v) results[k] = { type: typeof v, value: JSON.parse(JSON.stringify(v)) };
              } catch(e) {
                results[k] = { type: typeof window[k], error: e.message };
              }
            }
          });
          // Check $0 (last inspected element in Elements panel)
          try {
            if (typeof $0 !== 'undefined' && $0) {
              results['$0 (inspected)'] = {
                tag: $0.tagName,
                id: $0.id,
                className: $0.className ? $0.className.toString() : null,
                wfId: $0.getAttribute ? $0.getAttribute('data-w-id') : null,
                attributes: Array.from($0.attributes || []).map(function(a) { return a.name + '=' + a.value; })
              };
            }
          } catch(e) {}
          return results;
        })()
      `;
      const results = await evalInPage(code);
      if (!results || Object.keys(results).length === 0) {
        elementsOutput.innerHTML = '<span class="info">No selected element state found. Try selecting an element in the Elements panel ($0).</span>';
        return;
      }
      elementsOutput.innerHTML = `<pre>${escHtml(formatJson(results))}</pre>`;
    } catch (err) {
      elementsOutput.innerHTML = `<span class="error">Error: ${escHtml(err.message)}</span>`;
    }
  });

  // Parse snapshot
  $('#btn-parse-snapshot').addEventListener('click', () => {
    const text = $('#snapshot-paste').value.trim();
    if (!text) {
      snapshotOutput.innerHTML = '<span class="info">Paste snapshot text above first.</span>';
      return;
    }
    try {
      // Parse lines like: "  Section#abc123 .hero-section"
      const lines = text.split('\n');
      const parsed = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        const indent = line.search(/\S/);
        const match = line.trim().match(/^(\w+)(?:#(\S+))?\s*((?:\.\S+\s*)*)/);
        if (match) {
          parsed.push({
            depth: Math.floor(indent / 2),
            type: match[1],
            id: match[2] || null,
            classes: match[3] ? match[3].trim().split(/\s+/).map(c => c.replace(/^\./, '')) : []
          });
        } else {
          parsed.push({ depth: Math.floor(indent / 2), raw: line.trim() });
        }
      }
      snapshotOutput.innerHTML = `<div class="success">Parsed ${parsed.length} elements:</div><pre>${escHtml(formatJson(parsed))}</pre>`;
    } catch (err) {
      snapshotOutput.innerHTML = `<span class="error">Parse error: ${escHtml(err.message)}</span>`;
    }
  });

  // ── Tab 4: Presets ──────────────────────────────────────────────────

  const presetsOutput = $('#presets-output');
  const presetSelect = $('#preset-select');

  // Full list of 114 known presets from @webflow/designer-extension-typings
  const KNOWN_PRESETS = [
    'Block', 'BlockQuote', 'Bold', 'Button', 'CellBlock', 'CodeBlock',
    'Collection', 'CollectionItem', 'CollectionItemsList', 'CollectionListWrapper',
    'Column', 'Columns', 'Container', 'DateTimePicker', 'Div', 'DropdownLink',
    'DropdownList', 'DropdownToggle', 'DropdownWrapper', 'Facebook',
    'FileUploadDefault', 'FileUploadError', 'FileUploadInput',
    'FileUploadUploading', 'FileUploadWrapper', 'FormBlock', 'FormBlockLabel',
    'FormButton', 'FormCheckboxInput', 'FormCheckboxWrapper', 'FormForm',
    'FormInlineLabel', 'FormRadioInput', 'FormRadioWrapper', 'FormSelect',
    'FormSuccessMessage', 'FormErrorMessage', 'FormTextarea', 'FormTextInput',
    'Grid', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HFlex', 'HtmlEmbed',
    'Image', 'Italic', 'LightboxWrapper', 'LightboxImage', 'LightboxThumbnailImage',
    'LineBreak', 'Link', 'LinkBlock', 'List', 'ListItem', 'Map',
    'NavbarButton', 'NavbarContainer', 'NavbarWrapper', 'NavbarBrand',
    'NavbarLink', 'NavbarMenu', 'Pagination', 'PaginationNext',
    'PaginationPrevious', 'Paragraph', 'RichText', 'Row', 'SearchButton',
    'SearchForm', 'SearchInput', 'Section', 'SliderArrowLeft',
    'SliderArrowRight', 'SliderLeft', 'SliderMask', 'SliderNav',
    'SliderRight', 'SliderSlide', 'SliderWrapper', 'Span', 'Strong',
    'Subscript', 'Superscript', 'TabContent', 'TabLink', 'TabMenu',
    'TabPane', 'TabWrapper', 'Twitter', 'VFlex', 'Video', 'YouTube',
    // Additional presets discovered or from newer typings
    'BackgroundVideoWrapper', 'DOM', 'DOMWrapper', 'Icon',
    'LottieAnimation', 'MapWidget', 'PageQuery', 'QuickStack',
    'Rive', 'SocialWidget', 'Spline', 'StringBlock', 'SymbolInstance',
    'TableBody', 'TableCell', 'TableHead', 'TableHeader', 'TableRow',
    'TableWrapper', 'TextBlock', 'TreeItem', 'UserAccount',
    'VisuallyHidden', 'Wrapper'
  ];

  // Populate dropdown
  KNOWN_PRESETS.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p;
    presetSelect.appendChild(opt);
  });

  $('#btn-list-presets').addEventListener('click', () => {
    let html = `<div class="success">${KNOWN_PRESETS.length} known presets:</div>`;
    html += '<div style="column-count: 3; column-gap: 16px;">';
    for (const p of KNOWN_PRESETS) {
      html += `<div class="preset-item">${escHtml(p)}</div>`;
    }
    html += '</div>';
    presetsOutput.innerHTML = html;
  });

  $('#btn-create-preset').addEventListener('click', async () => {
    const preset = presetSelect.value;
    if (!preset) {
      presetsOutput.innerHTML = '<span class="info">Select a preset first.</span>';
      return;
    }
    presetsOutput.innerHTML = `<span class="info">Attempting to create "${escHtml(preset)}"... Watch Messages tab for postMessage traffic.</span>`;

    // Try to trigger preset creation through postMessage
    try {
      const code = `
        (function() {
          // Send a request to create the element via postMessage
          // This mimics what the Designer Extension SDK does internally
          var msg = {
            jsonrpc: '2.0',
            id: 'plinth-inspect-' + Date.now(),
            method: 'createElementFromPreset',
            params: { preset: '${preset}' }
          };
          window.postMessage(msg, '*');
          return 'Sent createElementFromPreset for ${preset}. Check Messages tab for response.';
        })()
      `;
      const result = await evalInPage(code);
      presetsOutput.innerHTML += `<div class="info">${escHtml(result)}</div>`;
      presetsOutput.innerHTML += '<div class="info">Note: This may only work if the Designer Extension context is active. The message traffic will reveal the internal element structure if it succeeds.</div>';
    } catch (err) {
      presetsOutput.innerHTML = `<span class="error">Error: ${escHtml(err.message)}</span>`;
    }
  });

})();
