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

  // Async eval — runs async code in page context by writing result to a temp global
  // inspectedWindow.eval can't return promises, so we poll for the result
  let _asyncEvalId = 0;
  function evalInPageAsync(code, timeoutMs = 30000) {
    const id = '__plinthAsync_' + (++_asyncEvalId);
    const wrappedCode = `
      (function() {
        window['${id}'] = { status: 'pending' };
        (${code})().then(function(r) {
          window['${id}'] = { status: 'done', result: r };
        }).catch(function(e) {
          window['${id}'] = { status: 'error', error: e.message || String(e) };
        });
        return 'started';
      })()
    `;
    return new Promise(async (resolve, reject) => {
      try {
        await evalInPage(wrappedCode);
      } catch (e) {
        return reject(e);
      }
      const start = Date.now();
      const poll = setInterval(async () => {
        try {
          const state = await evalInPage(`window['${id}']`);
          if (state && state.status === 'done') {
            clearInterval(poll);
            evalInPage(`delete window['${id}']`);
            resolve(state.result);
          } else if (state && state.status === 'error') {
            clearInterval(poll);
            evalInPage(`delete window['${id}']`);
            reject(new Error(state.error));
          } else if (Date.now() - start > timeoutMs) {
            clearInterval(poll);
            evalInPage(`delete window['${id}']`);
            reject(new Error('Async eval timeout'));
          }
        } catch (e) {
          clearInterval(poll);
          reject(e);
        }
      }, 500);
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

  // ── Deep Probe ──────────────────────────────────────────────────────

  $('#btn-deep-probe').addEventListener('click', async () => {
    globalsOutput.innerHTML = '<span class="info">Running deep probe...</span>';
    try {
      const code = `
        (function() {
          var report = {};

          // ── window.wf ──
          try {
            var wf = window.wf;
            if (wf) {
              var wfReport = { _type: typeof wf, _ctor: wf.constructor ? wf.constructor.name : '?' };
              Object.keys(wf).forEach(function(k) {
                try {
                  var v = wf[k];
                  var t = typeof v;
                  if (t === 'function') {
                    // Extract function signature from toString
                    var src = v.toString();
                    var sig = src.slice(0, 200);
                    // Try to get param names
                    var match = sig.match(/^(?:function\\s*\\w*)?\\s*\\(([^)]*)\\)/);
                    var params = match ? match[1] : '(?)';
                    wfReport[k] = { type: 'function', params: params, source: src.slice(0, 500) };
                  } else if (t === 'object' && v !== null) {
                    var keys = [];
                    try { keys = Object.keys(v).slice(0, 30); } catch(e) {}
                    var ctor = v.constructor ? v.constructor.name : 'Object';
                    wfReport[k] = { type: ctor, keys: keys };
                    // If it's small, try to serialize
                    if (keys.length < 10) {
                      try { wfReport[k].value = JSON.parse(JSON.stringify(v)); } catch(e) {}
                    }
                  } else {
                    wfReport[k] = { type: t, value: v };
                  }
                } catch(e) {
                  wfReport[k] = { error: e.message };
                }
              });
              // Also check prototype methods
              var proto = Object.getPrototypeOf(wf);
              if (proto && proto !== Object.prototype) {
                var protoMethods = [];
                Object.getOwnPropertyNames(proto).forEach(function(k) {
                  if (k !== 'constructor' && typeof proto[k] === 'function') protoMethods.push(k);
                });
                if (protoMethods.length > 0) wfReport._protoMethods = protoMethods;
              }
              report['window.wf'] = wfReport;
            }
          } catch(e) { report['window.wf'] = { error: e.message }; }

          // ── window._webflow (Flux store) ──
          try {
            var flux = window._webflow;
            if (flux) {
              var fluxReport = { _type: typeof flux, _ctor: flux.constructor ? flux.constructor.name : '?' };
              var fluxKeys = Object.keys(flux);
              fluxReport._topKeys = fluxKeys.slice(0, 50);
              // Check for common Flux/Redux patterns
              ['getState', 'dispatch', 'subscribe', 'getStore', 'store'].forEach(function(m) {
                if (typeof flux[m] === 'function') {
                  fluxReport[m] = 'function';
                  // If getState, try calling it
                  if (m === 'getState') {
                    try {
                      var state = flux.getState();
                      var stateKeys = Object.keys(state).slice(0, 40);
                      fluxReport._stateKeys = stateKeys;
                      // Sample a few small state slices
                      stateKeys.slice(0, 5).forEach(function(sk) {
                        try {
                          var sv = state[sk];
                          var svType = typeof sv;
                          if (svType === 'object' && sv !== null) {
                            fluxReport['state.' + sk] = { type: sv.constructor ? sv.constructor.name : 'Object', keys: Object.keys(sv).slice(0, 20) };
                          } else {
                            fluxReport['state.' + sk] = { type: svType, value: sv };
                          }
                        } catch(e) {}
                      });
                    } catch(e) { fluxReport._stateError = e.message; }
                  }
                } else if (flux[m] !== undefined) {
                  fluxReport[m] = typeof flux[m];
                }
              });
              // Check for store property
              if (flux.store && typeof flux.store === 'object') {
                var storeKeys = [];
                try { storeKeys = Object.keys(flux.store).slice(0, 30); } catch(e) {}
                fluxReport._storeKeys = storeKeys;
              }
              // Check prototype
              var fluxProto = Object.getPrototypeOf(flux);
              if (fluxProto && fluxProto !== Object.prototype) {
                var fluxMethods = [];
                Object.getOwnPropertyNames(fluxProto).forEach(function(k) {
                  if (k !== 'constructor' && typeof fluxProto[k] === 'function') fluxMethods.push(k);
                });
                if (fluxMethods.length > 0) fluxReport._protoMethods = fluxMethods;
              }
              report['window._webflow'] = fluxReport;
            }
          } catch(e) { report['window._webflow'] = { error: e.message }; }

          // ── window.wfenvironment ──
          try {
            var env = window.wfenvironment;
            if (env) {
              try {
                report['window.wfenvironment'] = JSON.parse(JSON.stringify(env));
              } catch(e) {
                report['window.wfenvironment'] = { keys: Object.keys(env).slice(0, 30), error: 'not serializable' };
              }
            }
          } catch(e) { report['window.wfenvironment'] = { error: e.message }; }

          // ── window.webflowInitialData ──
          try {
            var init = window.webflowInitialData;
            if (init) {
              var initReport = { _keys: Object.keys(init).slice(0, 30) };
              // Sample top-level values
              Object.keys(init).slice(0, 15).forEach(function(k) {
                try {
                  var v = init[k];
                  var t = typeof v;
                  if (t === 'object' && v !== null) {
                    var ctor = v.constructor ? v.constructor.name : 'Object';
                    var subKeys = Object.keys(v).slice(0, 20);
                    initReport[k] = { type: ctor, keys: subKeys };
                  } else if (t === 'string' && v.length > 200) {
                    initReport[k] = { type: 'string', length: v.length, preview: v.slice(0, 200) };
                  } else {
                    initReport[k] = { type: t, value: v };
                  }
                } catch(e) {
                  initReport[k] = { error: e.message };
                }
              });
              report['window.webflowInitialData'] = initReport;
            }
          } catch(e) { report['window.webflowInitialData'] = { error: e.message }; }

          // ── Bonus: look for element/node registries on window ──
          try {
            var registries = {};
            Object.getOwnPropertyNames(window).forEach(function(k) {
              if (/element|node|component|store|redux|dispatch|action/i.test(k)) {
                try {
                  var v = window[k];
                  if (v !== undefined && v !== null && typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
                    var t = typeof v;
                    if (t === 'function') {
                      registries[k] = 'function(' + (v.length || 0) + ' params)';
                    } else if (t === 'object') {
                      registries[k] = (v.constructor ? v.constructor.name : 'Object') + ' {' + Object.keys(v).slice(0, 10).join(', ') + '}';
                    }
                  }
                } catch(e) {}
              }
            });
            if (Object.keys(registries).length > 0) {
              report['_registries'] = registries;
            }
          } catch(e) {}

          return report;
        })()
      `;

      const report = await evalInPage(code);
      findings.deepProbe = report;

      let html = '';
      for (const [section, data] of Object.entries(report)) {
        html += `<div class="kv-row" style="margin-top:12px"><span class="kv-key" style="font-size:13px;font-weight:bold">${escHtml(section)}</span></div>`;
        html += renderDeepProbeSection(data, 1);
      }
      globalsOutput.innerHTML = html;
    } catch (err) {
      globalsOutput.innerHTML = `<span class="error">Error: ${escHtml(err.message)}</span>`;
    }
  });

  function renderDeepProbeSection(data, depth) {
    if (!data || typeof data !== 'object') {
      return `<div class="kv-row" style="padding-left:${depth * 16}px"><span class="kv-val">${escHtml(String(data))}</span></div>`;
    }
    let html = '';
    for (const [key, val] of Object.entries(data)) {
      html += `<div class="kv-row" style="padding-left:${depth * 16}px">`;
      html += `<span class="kv-key">${escHtml(key)}</span>: `;
      if (val === null || val === undefined) {
        html += `<span class="info">null</span>`;
      } else if (typeof val === 'string') {
        html += `<span class="kv-val">${escHtml(val)}</span>`;
      } else if (typeof val === 'number' || typeof val === 'boolean') {
        html += `<span class="kv-type">${val}</span>`;
      } else if (Array.isArray(val)) {
        html += `<span class="kv-keys">[${val.map(v => escHtml(String(v))).join(', ')}]</span>`;
      } else if (typeof val === 'object') {
        // Check if it's a leaf-like object (type + value/params/source)
        if (val.type === 'function' && val.source) {
          html += `<span class="kv-type">fn(${escHtml(val.params || '?')})</span>`;
          html += `</div>`;
          html += `<div class="kv-row" style="padding-left:${(depth + 1) * 16}px">`;
          html += `<span class="info" style="white-space:pre-wrap;font-size:10px">${escHtml(val.source)}</span>`;
        } else if (val.type && val.keys) {
          html += `<span class="kv-type">${escHtml(val.type)}</span> { <span class="kv-keys">${val.keys.map(k => escHtml(k)).join(', ')}</span> }`;
          if (val.value !== undefined) {
            html += `</div>`;
            html += `<div class="kv-row" style="padding-left:${(depth + 1) * 16}px">`;
            html += `<span class="info" style="white-space:pre-wrap;font-size:10px">${escHtml(formatJson(val.value))}</span>`;
          }
        } else if (val.type && val.value !== undefined) {
          html += `<span class="kv-type">${escHtml(val.type)}</span> = <span class="kv-val">${escHtml(String(val.value))}</span>`;
        } else if (val.error) {
          html += `<span class="error">${escHtml(val.error)}</span>`;
        } else {
          // Recurse for nested objects
          html += `</div>`;
          html += renderDeepProbeSection(val, depth + 1);
          continue;
        }
      }
      html += `</div>`;
    }
    return html;
  }

  // ── WFDL Playground Probe ────────────────────────────────────────────

  $('#btn-whtml-playground').addEventListener('click', async () => {
    globalsOutput.innerHTML = '<span class="info">Probing WFDL/WHTML playground and dispatch system...</span>';
    try {
      const code = `
        (function() {
          var result = {};

          // 1. AssistantStore deep inspection
          try {
            var as = window._webflow.state.AssistantStore;
            if (as) {
              var asData = typeof as.toJSON === 'function' ? as.toJSON() : as;
              result.assistantStore = {};
              Object.keys(asData).forEach(function(k) {
                var v = asData[k];
                if (v === null || v === undefined) { result.assistantStore[k] = v; return; }
                if (typeof v === 'object') {
                  if (Array.isArray(v)) result.assistantStore[k] = { type: 'array', length: v.length };
                  else result.assistantStore[k] = { type: 'object', keys: Object.keys(v).slice(0, 10), keyCount: Object.keys(v).length };
                } else {
                  result.assistantStore[k] = v;
                }
              });
            }
          } catch(e) { result.assistantStoreError = e.message; }

          // 2. Find dispatch and action types
          try {
            var wb = window._webflow;
            result.dispatchType = typeof wb.dispatch;

            // Try to find action creators / constants by searching for "playground" in the dispatch system
            // Look at the dispatch function signature
            if (typeof wb.dispatch === 'function') {
              result.dispatchArity = wb.dispatch.length;
              result.dispatchStr = wb.dispatch.toString().slice(0, 300);
            }

            // Try dispatching to open the playground
            // First, try common Flux action patterns
            var actionPatterns = [
              { type: 'SET_WHTML_PLAYGROUND_IS_OPEN', payload: true },
              { type: 'TOGGLE_WHTML_PLAYGROUND' },
              { type: 'OPEN_WHTML_PLAYGROUND' },
              { type: 'SET_ASSISTANT_STATE', key: 'whtmlPlaygroundIsOpen', value: true },
              { actionType: 'SET_WHTML_PLAYGROUND_IS_OPEN', data: true },
              { actionType: 'TOGGLE_WHTML_PLAYGROUND' },
            ];

            // Don't dispatch yet — just report the patterns we'll try
            result.actionPatternsToTry = actionPatterns.length;
          } catch(e) { result.dispatchError = e.message; }

          // 3. Search for playground-related strings in loaded scripts
          try {
            var playgroundHits = [];
            // Check if there's a global reference to whtml/playground
            var searchKeys = ['whtml', 'whtmlPlayground', 'WHTML', 'playground', 'addToCanvas'];
            searchKeys.forEach(function(key) {
              // Search in _webflow's action types or constants
              if (window.__wf_actions) {
                Object.keys(window.__wf_actions).forEach(function(k) {
                  if (k.toLowerCase().indexOf(key.toLowerCase()) >= 0) {
                    playgroundHits.push('__wf_actions.' + k);
                  }
                });
              }
            });

            // Check if AssistantStore has actionHandlers or registered reducers
            var as = window._webflow.state.AssistantStore;
            if (as) {
              var proto = Object.getPrototypeOf(as);
              if (proto && proto !== Object.prototype) {
                var protoMethods = Object.getOwnPropertyNames(proto).filter(function(k) { return typeof proto[k] === 'function'; });
                result.assistantStoreProtoMethods = protoMethods;
              }
            }

            if (playgroundHits.length > 0) result.playgroundHits = playgroundHits;
          } catch(e) { result.searchError = e.message; }

          // 4. Try to find the Flux dispatcher and its registered callbacks
          try {
            var wb = window._webflow;
            // Common Flux dispatcher patterns
            var dispInfo = {};

            // Check if there's a registered dispatcher
            if (wb._dispatcher || wb.dispatcher || wb.Dispatcher) {
              var d = wb._dispatcher || wb.dispatcher || wb.Dispatcher;
              dispInfo.found = true;
              dispInfo.type = typeof d;
              dispInfo.keys = Object.keys(d).slice(0, 15);
              if (d._callbacks) dispInfo.callbackCount = Object.keys(d._callbacks).length;
              if (d._actionHandlers) dispInfo.actionHandlers = Object.keys(d._actionHandlers).slice(0, 30);
            }

            // Check if _webflow has getDispatcher or similar
            ['getDispatcher', 'getStore', 'getActions', 'getActionTypes', 'actionTypes'].forEach(function(m) {
              if (typeof wb[m] === 'function') {
                try {
                  var r = wb[m]();
                  dispInfo[m] = typeof r === 'object' ? Object.keys(r).slice(0, 20) : typeof r;
                } catch(e) { dispInfo[m] = 'error: ' + e.message; }
              } else if (wb[m] && typeof wb[m] === 'object') {
                dispInfo[m] = Object.keys(wb[m]).slice(0, 20);
              }
            });

            // Try direct property access on _webflow for action-related keys
            Object.keys(wb).forEach(function(k) {
              if (/action|dispatch|store|reduce|flux/i.test(k)) {
                dispInfo['wb.' + k] = typeof wb[k];
              }
            });

            result.dispatcher = dispInfo;
          } catch(e) { result.dispatcherError = e.message; }

          // 5. Search reducer source for playground action types
          try {
            var wb = window._webflow;
            var reducerSrc = wb.reducer.toString();

            // Search for playground/whtml in reducer source
            var playgroundMatches = [];
            var searchTerms = ['playground', 'whtml', 'Playground', 'WHTML', 'whtmlPlayground'];
            searchTerms.forEach(function(term) {
              var idx = reducerSrc.indexOf(term);
              if (idx >= 0) {
                // Extract surrounding context (100 chars before and after)
                var start = Math.max(0, idx - 100);
                var end = Math.min(reducerSrc.length, idx + term.length + 100);
                playgroundMatches.push({
                  term: term,
                  position: idx,
                  context: reducerSrc.slice(start, end)
                });
              }
            });
            result.reducerPlaygroundMatches = playgroundMatches;
            result.reducerLength = reducerSrc.length;

            // Also check lastAction shape for clue about dispatch format
            if (wb.lastAction) {
              var la = wb.lastAction;
              result.lastAction = {
                keys: Object.keys(la).slice(0, 15),
                type: la.type,
                actionType: la.actionType,
                preview: JSON.stringify(la).slice(0, 300)
              };
            }

            // Check _dispatch source for action shape clues
            if (typeof wb._dispatch === 'function') {
              result._dispatchSource = wb._dispatch.toString().slice(0, 500);
            }

            // Search stores object for AssistantStore handlers
            if (wb.stores) {
              var storeKeys = Object.keys(wb.stores);
              result.storeCount = storeKeys.length;
              // Find assistant store
              var assistantIdx = storeKeys.findIndex(function(k) { return /assistant/i.test(k); });
              if (assistantIdx >= 0) {
                var aStore = wb.stores[storeKeys[assistantIdx]];
                result.assistantStoreEntry = {
                  key: storeKeys[assistantIdx],
                  type: typeof aStore,
                  keys: typeof aStore === 'object' ? Object.keys(aStore).slice(0, 20) : [],
                  source: typeof aStore === 'function' ? aStore.toString().slice(0, 500) : null
                };
              }
            }
          } catch(e) { result.reducerSearchError = e.message; }

          // 6. Try to open playground with correct action shapes
          try {
            var wb = window._webflow;

            // Check lastAction to learn action shape
            var actionShapes = [];
            if (wb.lastAction) {
              actionShapes.push('lastAction keys: ' + Object.keys(wb.lastAction).join(', '));
            }

            // Try common patterns based on what we know about the reducer
            var attempts = [];
            var patterns = [
              { type: 'TOGGLE_WHTML_PLAYGROUND' },
              { type: 'OPEN_WHTML_PLAYGROUND' },
              { type: 'SET_WHTML_PLAYGROUND_IS_OPEN', value: true },
              { type: 'SET_WHTML_PLAYGROUND_IS_OPEN', payload: { isOpen: true } },
              { type: 'ASSISTANT_SET_WHTML_PLAYGROUND_IS_OPEN', payload: true },
              { type: 'assistant/setWhtmlPlaygroundIsOpen', payload: true },
              { type: 'SET_ASSISTANT_STATE', payload: { whtmlPlaygroundIsOpen: true } },
            ];

            patterns.forEach(function(action) {
              try {
                wb.dispatch(action);
                var state = wb.state.AssistantStore;
                var data = typeof state.toJSON === 'function' ? state.toJSON() : state;
                attempts.push({ action: action.type, isOpen: data.whtmlPlaygroundIsOpen });
              } catch(e) {
                attempts.push({ action: action.type, error: e.message });
              }
            });

            result.dispatchAttempts = attempts;
            result.playgroundOpenAfterDispatch = attempts.some(function(a) { return a.isOpen === true; });
          } catch(e) { result.openAttemptError = e.message; }

          // 7. Probe the wf.addToCanvas function for clues
          try {
            var addFn = window.wf.addToCanvas;
            result.addToCanvas = {
              arity: addFn.length,
              source: addFn.toString().slice(0, 800),
              name: addFn.name
            };
          } catch(e) { result.addToCanvasError = e.message; }

          // 8. Also get more of addToCanvas — the full source
          try {
            var src = window.wf.addToCanvas.toString();
            result.addToCanvasFull = src.length > 800 ? src.slice(800, 1600) : '(already fully captured)';
            result.addToCanvasLength = src.length;
          } catch(e) {}

          // 9. Check for any DOM elements with "playground" or "whtml" in the current page
          try {
            var domHits = [];
            document.querySelectorAll('[class*="playground"], [class*="whtml"], [class*="Playground"], [id*="playground"], [id*="whtml"], [data-automation-id*="playground"], [data-automation-id*="whtml"]').forEach(function(el) {
              domHits.push({
                tag: el.tagName.toLowerCase(),
                id: el.id || null,
                className: (el.className || '').toString().slice(0, 100),
                visible: el.offsetParent !== null,
                innerHTML: el.innerHTML.slice(0, 200)
              });
            });
            if (domHits.length > 0) result.playgroundDomElements = domHits;
          } catch(e) {}

          return result;
        })()
      `;

      const result = await evalInPage(code);
      findings.whtmlPlayground = result;

      const json = formatJson(result);
      let html = `<div class="success">WFDL Playground probe complete</div>`;
      html += `<div style="margin:8px 0">`;
      html += `<button id="btn-download-playground">Download playground-probe.json</button>`;
      html += `</div>`;
      html += `<pre style="max-height:600px;overflow:auto;font-size:10px">${escHtml(json)}</pre>`;
      globalsOutput.innerHTML = html;

      document.getElementById('btn-download-playground')?.addEventListener('click', () => {
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'playground-probe.json';
        a.click();
        URL.revokeObjectURL(url);
      });
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

  // ── WFDL Lab ────────────────────────────────────────────────────────

  const labStatus = $('#lab-status');

  // WFDL uses CSS-like curly-brace syntax: Type { children }
  // Text is quoted strings. Confirmed: "Section { Container { Heading { "Hello" } } }" is valid.
  const WFDL_ELEMENTS = [
    // ── Element types (bare) ──
    { name: 'div', wfdl: 'div { }' },
    { name: 'section', wfdl: 'section { }' },
    { name: 'container', wfdl: 'container { }' },
    { name: 'block', wfdl: 'block { }' },
    { name: 'grid', wfdl: 'grid { }' },
    { name: 'hflex', wfdl: 'hflex { }' },
    { name: 'vflex', wfdl: 'vflex { }' },
    { name: 'columns', wfdl: 'columns { }' },
    { name: 'column', wfdl: 'column { }' },
    { name: 'row', wfdl: 'row { }' },
    { name: 'quickstack', wfdl: 'quickstack { }' },
    // Text elements
    { name: 'heading', wfdl: 'heading { "Hello" }' },
    { name: 'Heading', wfdl: 'Heading { "Hello" }' },
    { name: 'h1', wfdl: 'h1 { "Hello" }' },
    { name: 'h2', wfdl: 'h2 { "Hello" }' },
    { name: 'h3', wfdl: 'h3 { "Hello" }' },
    { name: 'paragraph', wfdl: 'paragraph { "Text" }' },
    { name: 'p', wfdl: 'p { "Text" }' },
    { name: 'text', wfdl: 'text { "Hello" }' },
    { name: 'textblock', wfdl: 'textblock { "Hello" }' },
    { name: 'TextBlock', wfdl: 'TextBlock { "Hello" }' },
    { name: 'richtext', wfdl: 'richtext { }' },
    { name: 'span', wfdl: 'span { "Text" }' },
    { name: 'strong', wfdl: 'strong { "Bold" }' },
    { name: 'em', wfdl: 'em { "Italic" }' },
    { name: 'blockquote', wfdl: 'blockquote { "Quote" }' },
    // Links / Interactive
    { name: 'link', wfdl: 'link { "Click" }' },
    { name: 'a', wfdl: 'a { "Click" }' },
    { name: 'linkblock', wfdl: 'linkblock { }' },
    { name: 'button', wfdl: 'button { "Click" }' },
    { name: 'image', wfdl: 'image { }' },
    { name: 'img', wfdl: 'img { }' },
    { name: 'video', wfdl: 'video { }' },
    { name: 'htmlembed', wfdl: 'htmlembed { }' },
    // Lists
    { name: 'list', wfdl: 'list { }' },
    { name: 'listitem', wfdl: 'listitem { }' },
    { name: 'ul', wfdl: 'ul { }' },
    { name: 'ol', wfdl: 'ol { }' },
    { name: 'li', wfdl: 'li { }' },
    // Form
    { name: 'form', wfdl: 'form { }' },
    { name: 'formblock', wfdl: 'formblock { }' },
    { name: 'input', wfdl: 'input { }' },
    { name: 'textarea', wfdl: 'textarea { }' },
    { name: 'select', wfdl: 'select { }' },
    // Nav
    { name: 'navbar', wfdl: 'navbar { }' },
    { name: 'navbarwrapper', wfdl: 'navbarwrapper { }' },
    // Slider
    { name: 'slider', wfdl: 'slider { }' },
    { name: 'sliderwrapper', wfdl: 'sliderwrapper { }' },
    // Tabs
    { name: 'tabs', wfdl: 'tabs { }' },
    { name: 'tabwrapper', wfdl: 'tabwrapper { }' },
    // Dropdown
    { name: 'dropdown', wfdl: 'dropdown { }' },
    { name: 'dropdownwrapper', wfdl: 'dropdownwrapper { }' },
    // Lightbox
    { name: 'lightbox', wfdl: 'lightbox { }' },
    { name: 'lightboxwrapper', wfdl: 'lightboxwrapper { }' },
    // Table
    { name: 'table', wfdl: 'table { }' },
    { name: 'tablewrapper', wfdl: 'tablewrapper { }' },
    // Media
    { name: 'youtube', wfdl: 'youtube { }' },
    { name: 'map', wfdl: 'map { }' },
    { name: 'lottieanimation', wfdl: 'lottieanimation { }' },
    // ── Case variants (PascalCase vs lowercase) ──
    { name: 'Section (pascal)', wfdl: 'Section { }' },
    { name: 'Container (pascal)', wfdl: 'Container { }' },
    { name: 'Div (pascal)', wfdl: 'Div { }' },
    { name: 'DivBlock (pascal)', wfdl: 'DivBlock { }' },
    { name: 'Grid (pascal)', wfdl: 'Grid { }' },
    { name: 'HFlex (pascal)', wfdl: 'HFlex { }' },
    { name: 'VFlex (pascal)', wfdl: 'VFlex { }' },
    { name: 'Image (pascal)', wfdl: 'Image { }' },
    { name: 'Link (pascal)', wfdl: 'Link { "Click" }' },
    { name: 'Button (pascal)', wfdl: 'Button { "Click" }' },
    { name: 'Paragraph (pascal)', wfdl: 'Paragraph { "Text" }' },
    { name: 'List (pascal)', wfdl: 'List { }' },
    { name: 'ListItem (pascal)', wfdl: 'ListItem { }' },
    { name: 'FormBlock (pascal)', wfdl: 'FormBlock { }' },
    { name: 'SliderWrapper (pascal)', wfdl: 'SliderWrapper { }' },
    { name: 'TabWrapper (pascal)', wfdl: 'TabWrapper { }' },
    // ── Syntax features ──
    { name: 'text in section', wfdl: 'section { text "hello" }' },
    { name: 'nested', wfdl: 'section { div { heading { "Title" } paragraph { "Body" } } }' },
    { name: 'deep nest', wfdl: 'Section { Container { Div { Heading { "Title" } Paragraph { "Text" } } } }' },
    // CSS class syntax?
    { name: '.class-name', wfdl: 'div.test-class { }' },
    { name: '.class spaced', wfdl: 'div .test-class { }' },
    { name: '#id', wfdl: 'div#test-id { }' },
    // Properties/attributes?
    { name: 'prop colon', wfdl: 'div { color: red }' },
    { name: 'prop key-value', wfdl: 'image { src: "test.jpg" }' },
    { name: 'style block', wfdl: 'div { style { color: red } }' },
    { name: 'text directive', wfdl: 'div { text "hello world" }' },
    { name: 'multiple text', wfdl: 'div { "hello" "world" }' },
    // Sibling elements
    { name: 'siblings', wfdl: 'div { } div { }' },
    { name: 'section+section', wfdl: 'section { } section { }' },
  ];

  // Export WFDL — deep probe of DesignerStore, all stores, and page tree
  $('#btn-export-wfdl').addEventListener('click', async () => {
    elementsOutput.innerHTML = '<span class="info">Deep-probing all stores for page element tree...</span>';
    labStatus.textContent = 'Probing stores...';
    try {
      const code = `
        (function() {
          var result = {};

          // 1. DesignerStore — use ImmutableJS accessors (not Object.keys)
          try {
            var state = window._webflow.state;
            var ds = state.DesignerStore;
            if (ds) {
              var dsInfo = {};

              // ImmutableJS: try .toJSON() to get real keys
              if (typeof ds.toJSON === 'function') {
                try {
                  var dsJson = ds.toJSON();
                  dsInfo.toJSON_keys = Object.keys(dsJson);
                  // Sample each key's type and structure
                  Object.keys(dsJson).forEach(function(k) {
                    var v = dsJson[k];
                    if (v === null || v === undefined) { dsInfo['key_' + k] = v; return; }
                    var info = { type: typeof v };
                    if (typeof v === 'object') {
                      info.ctor = v.constructor ? v.constructor.name : '?';
                      if (Array.isArray(v)) {
                        info.length = v.length;
                        if (v.length > 0) {
                          var first = v[0];
                          info.firstType = typeof first;
                          if (typeof first === 'object' && first !== null) {
                            info.firstKeys = Object.keys(first).slice(0, 10);
                          }
                        }
                      } else {
                        var objKeys = Object.keys(v);
                        info.keyCount = objKeys.length;
                        info.keys = objKeys.slice(0, 15);
                      }
                    } else if (typeof v === 'string') {
                      info.value = v.slice(0, 100);
                    } else {
                      info.value = String(v);
                    }
                    dsInfo['key_' + k] = info;
                  });
                } catch(e) { dsInfo.toJsonError = e.message; }
              }

              // ImmutableJS: try .toJS() as fallback
              if (typeof ds.toJS === 'function' && !dsInfo.toJSON_keys) {
                try {
                  var dsJs = ds.toJS();
                  dsInfo.toJS_keys = Object.keys(dsJs);
                } catch(e) { dsInfo.toJsError = e.message; }
              }

              // ImmutableJS: try .keySeq().toArray()
              if (typeof ds.keySeq === 'function') {
                try { dsInfo.keySeq = ds.keySeq().toArray(); } catch(e) { dsInfo.keySeqError = e.message; }
              }

              // Try direct property access for common tree properties
              var treeProps = ['nodes', 'elements', 'tree', 'dom', 'body', 'page', 'pages',
                'rootNode', 'rootElement', 'pageNodes', 'children', 'nodeMap', 'elementMap',
                'selectedElement', 'selectedNode', 'currentPage', 'pageBody'];
              treeProps.forEach(function(p) {
                try {
                  var v = typeof ds.get === 'function' ? ds.get(p) : ds[p];
                  if (v !== undefined && v !== null) {
                    var info = { type: typeof v };
                    if (typeof v === 'object') {
                      info.ctor = v.constructor ? v.constructor.name : '?';
                      if (typeof v.toJSON === 'function') {
                        try {
                          var j = v.toJSON();
                          info.keys = Object.keys(j).slice(0, 10);
                          info.keyCount = Object.keys(j).length;
                        } catch(e) {}
                      } else if (typeof v.size !== 'undefined') {
                        info.size = v.size;
                      } else {
                        try { info.keys = Object.keys(v).slice(0, 10); } catch(e) {}
                      }
                    }
                    dsInfo['prop_' + p] = info;
                  }
                } catch(e) {}
              });

              result.designerStore = dsInfo;
              result.currentPageId = ds.currentPageId;
            }
          } catch(e) {
            result.designerStoreError = e.message;
          }

          // 2. Scan ALL stores in _webflow.state for element/node data
          try {
            var allStores = {};
            var stateKeys = Object.keys(window._webflow.state);
            result.allStoreNames = stateKeys;

            stateKeys.forEach(function(storeName) {
              var store = window._webflow.state[storeName];
              if (!store || typeof store !== 'object') return;

              var storeInfo = { ctor: store.constructor ? store.constructor.name : '?' };

              // Get keys via ImmutableJS or plain object
              var keys = [];
              if (typeof store.toJSON === 'function') {
                try {
                  var sj = store.toJSON();
                  keys = Object.keys(sj);
                  storeInfo.keys = keys.slice(0, 20);
                  storeInfo.totalKeys = keys.length;
                } catch(e) { storeInfo.toJsonError = e.message; }
              } else if (typeof store.keySeq === 'function') {
                try {
                  keys = store.keySeq().toArray();
                  storeInfo.keys = keys.slice(0, 20);
                  storeInfo.totalKeys = keys.length;
                } catch(e) {}
              } else {
                try {
                  keys = Object.keys(store);
                  storeInfo.keys = keys.slice(0, 20);
                  storeInfo.totalKeys = keys.length;
                } catch(e) {}
              }

              // Flag stores that look like they contain element/node data
              var interesting = keys.some(function(k) {
                return /node|element|tree|dom|body|page|render|wfdl|child|parent|style|class/i.test(k);
              });
              if (interesting || /node|element|tree|dom|page|render/i.test(storeName)) {
                storeInfo.flagged = true;
              }

              allStores[storeName] = storeInfo;
            });
            result.stores = allStores;
          } catch(e) {
            result.storesError = e.message;
          }

          // 3. Deep-dive into flagged stores — look for page tree data
          try {
            var state = window._webflow.state;
            var deepDive = {};

            // Check for common store names that might hold elements
            var candidates = ['ElementsStore', 'NodesStore', 'PageStore', 'TreeStore',
              'DOMStore', 'NodeStore', 'ElementStore', 'RenderStore', 'PageElementsStore',
              'CanvasStore', 'DocumentStore', 'SiteStore', 'CurrentPageStore'];
            candidates.forEach(function(name) {
              if (state[name]) {
                var s = state[name];
                var info = {};
                if (typeof s.toJSON === 'function') {
                  try {
                    var j = s.toJSON();
                    info.keys = Object.keys(j).slice(0, 30);
                    // Sample values that look like node/element data
                    Object.keys(j).slice(0, 5).forEach(function(k) {
                      var v = j[k];
                      if (v && typeof v === 'object') {
                        info['sample_' + k] = {
                          ctor: v.constructor ? v.constructor.name : '?',
                          keys: Object.keys(v).slice(0, 15),
                          preview: JSON.stringify(v).slice(0, 500)
                        };
                      } else {
                        info['sample_' + k] = v;
                      }
                    });
                  } catch(e) { info.error = e.message; }
                }
                deepDive[name] = info;
              }
            });

            // Also check any store with "node" or "element" in its name (case-insensitive)
            Object.keys(state).forEach(function(name) {
              if (!deepDive[name] && /node|element|tree|page|dom|canvas|render/i.test(name)) {
                var s = state[name];
                var info = {};
                if (typeof s === 'object' && s !== null) {
                  if (typeof s.toJSON === 'function') {
                    try {
                      var j = s.toJSON();
                      info.keys = Object.keys(j).slice(0, 30);
                      info.totalKeys = Object.keys(j).length;
                      // Preview first 3
                      Object.keys(j).slice(0, 3).forEach(function(k) {
                        var v = j[k];
                        info['sample_' + k] = v && typeof v === 'object' ?
                          { keys: Object.keys(v).slice(0, 15), preview: JSON.stringify(v).slice(0, 300) } : v;
                      });
                    } catch(e) { info.error = e.message; }
                  } else {
                    try { info.keys = Object.keys(s).slice(0, 30); } catch(e) {}
                  }
                }
                deepDive[name] = info;
              }
            });

            if (Object.keys(deepDive).length > 0) result.deepDive = deepDive;
          } catch(e) {
            result.deepDiveError = e.message;
          }

          // 4. Inspect the __SitePlugin.page component definition
          try {
            var comps = window._webflow.state.DesignerStore.components;
            if (comps && typeof comps.get === 'function') {
              var pageComp = comps.get('__SitePlugin', 'page');
              if (pageComp) {
                var pcInfo = { type: typeof pageComp, ctor: pageComp.constructor ? pageComp.constructor.name : '?' };
                // Get all methods and properties
                var methods = [], props = [];
                var proto = pageComp;
                var visited = new Set();
                while (proto && proto !== Object.prototype && !visited.has(proto)) {
                  visited.add(proto);
                  Object.getOwnPropertyNames(proto).forEach(function(k) {
                    try {
                      if (typeof proto[k] === 'function' && k !== 'constructor') methods.push(k);
                      else if (k !== 'constructor' && typeof pageComp[k] !== 'function') {
                        var val = pageComp[k];
                        if (val && typeof val === 'object') {
                          props.push(k + ': ' + (val.constructor ? val.constructor.name : typeof val) + ' (' + Object.keys(val).slice(0, 5).join(', ') + ')');
                        } else {
                          props.push(k + ': ' + JSON.stringify(val).slice(0, 60));
                        }
                      }
                    } catch(e) {}
                  });
                  proto = Object.getPrototypeOf(proto);
                }
                pcInfo.methods = methods;
                pcInfo.props = props;

                // Try calling methods that might return tree
                ['getRender', 'render', 'getBody', 'getTree', 'getNodes', 'getChildren', 'toWFDL', 'serialize', 'toJSON'].forEach(function(m) {
                  if (typeof pageComp[m] === 'function') {
                    try {
                      var r = pageComp[m]();
                      pcInfo['call_' + m] = typeof r === 'object' && r !== null ?
                        { ctor: r.constructor ? r.constructor.name : '?', keys: Object.keys(r).slice(0, 15), preview: JSON.stringify(r).slice(0, 500) } :
                        { type: typeof r, value: String(r).slice(0, 200) };
                    } catch(e) { pcInfo['call_' + m] = 'error: ' + e.message; }
                  }
                });

                result.sitePluginPage = pcInfo;
              }
            }
          } catch(e) {
            result.sitePluginPageError = e.message;
          }

          // 5. Try alternative paths to page tree
          try {
            var altPaths = {};

            // wf.exportTrainingData() — check components more carefully
            var td = wf.exportTrainingData();
            altPaths.trainingDataKeys = Object.keys(td);
            if (td.components) {
              altPaths.components = {
                type: typeof td.components,
                ctor: td.components.constructor ? td.components.constructor.name : '?'
              };
              if (typeof td.components === 'string') {
                altPaths.components.preview = td.components.slice(0, 1000);
              } else if (Array.isArray(td.components)) {
                altPaths.components.length = td.components.length;
                if (td.components.length > 0) {
                  altPaths.components.firstPreview = JSON.stringify(td.components[0]).slice(0, 500);
                }
              } else if (typeof td.components === 'object') {
                altPaths.components.keys = Object.keys(td.components).slice(0, 20);
                altPaths.components.preview = JSON.stringify(td.components).slice(0, 500);
              }
            }

            // Check if wf has any other useful methods we missed
            var wfMethods = [];
            Object.keys(wf).forEach(function(k) {
              if (typeof wf[k] === 'function') wfMethods.push(k + '(' + wf[k].length + ')');
            });
            altPaths.wfMethods = wfMethods;

            result.altPaths = altPaths;
          } catch(e) {
            result.altPathsError = e.message;
          }

          return result;
        })()
      `;
      const result = await evalInPage(code);
      findings.wfdlExport = result;

      const json = formatJson(result);
      let html = `<div class="success">WFDL / DesignerStore probe complete</div>`;
      html += `<div style="margin:8px 0">`;
      html += `<button id="btn-download-wfdl-export">Download Full Probe JSON</button>`;
      html += `</div>`;
      html += `<pre style="max-height:500px;overflow:auto;font-size:10px">${escHtml(json)}</pre>`;
      elementsOutput.innerHTML = html;

      document.getElementById('btn-download-wfdl-export')?.addEventListener('click', () => {
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'wfdl-probe.json';
        a.click();
        URL.revokeObjectURL(url);
        labStatus.textContent = 'Downloaded wfdl-probe.json';
      });
      labStatus.textContent = 'Probe done.';
    } catch (err) {
      elementsOutput.innerHTML = `<span class="error">Error: ${escHtml(err.message)}</span>`;
      labStatus.textContent = 'Error.';
    }
  });

  // Dump Node Tree — extract full AbstractNodeStore.root
  $('#btn-dump-tree').addEventListener('click', async () => {
    elementsOutput.innerHTML = '<span class="info">Extracting full page node tree from AbstractNodeStore...</span>';
    labStatus.textContent = 'Extracting tree...';
    try {
      const code = `
        (function() {
          var store = window._webflow.state.AbstractNodeStore;
          if (!store) return { error: 'AbstractNodeStore not found' };

          var root;
          if (typeof store.toJSON === 'function') {
            root = store.toJSON().root;
          } else if (store.root) {
            root = store.root;
          }
          if (!root) return { error: 'No root node found' };

          // Also grab StyleBlockStore for class name resolution
          var styleMap = {};
          try {
            var sbs = window._webflow.state.StyleBlockStore;
            var sbData;
            if (typeof sbs.toJSON === 'function') sbData = sbs.toJSON();
            else sbData = sbs;
            if (sbData && sbData.styleBlocks) {
              var blocks = sbData.styleBlocks;
              // styleBlocks might be ImmutableJS
              var plain = typeof blocks.toJSON === 'function' ? blocks.toJSON() : blocks;
              Object.keys(plain).forEach(function(id) {
                var sb = plain[id];
                var plainSb = typeof sb.toJSON === 'function' ? sb.toJSON() : sb;
                if (plainSb && plainSb.name) {
                  styleMap[id] = plainSb.name;
                }
              });
            }
          } catch(e) {}

          // Recursively serialize the tree with class names resolved
          function serializeNode(node, depth) {
            if (!node || depth > 20) return null;
            var n = typeof node.toJSON === 'function' ? node.toJSON() : node;
            var result = { id: n.id, tag: n.data ? n.data.tag : n.type };

            // Resolve class names from styleBlockIds
            if (n.data && n.data.styleBlockIds && n.data.styleBlockIds.length > 0) {
              result.classes = n.data.styleBlockIds.map(function(sid) {
                return styleMap[sid] || sid;
              });
            }

            // Text content
            if (n.data && n.data.text === true && n.children && n.children.length > 0) {
              // Text nodes: children contain text runs
              var textContent = [];
              n.children.forEach(function(child) {
                var c = typeof child === 'object' ? (typeof child.toJSON === 'function' ? child.toJSON() : child) : child;
                if (c && c.text) textContent.push(typeof c.text === 'string' ? c.text : JSON.stringify(c.text));
                else if (typeof c === 'string') textContent.push(c);
                else if (c && c.v) textContent.push(c.v);
              });
              if (textContent.length > 0) result.text = textContent.join('');
            }

            // Key data properties
            if (n.data) {
              if (n.data.attributes && n.data.attributes.length > 0) {
                result.attrs = {};
                n.data.attributes.forEach(function(attr) {
                  if (typeof attr === 'object' && attr.key) result.attrs[attr.key] = attr.value;
                  else if (Array.isArray(attr) && attr.length >= 2) result.attrs[attr[0]] = attr[1];
                });
              }
              if (n.data.slot) result.slot = n.data.slot;
              if (n.data.xattr && n.data.xattr.length > 0) result.xattr = n.data.xattr;
            }
            if (n.type) result.type = n.type;

            // Recurse children (skip text runs already handled)
            if (n.children && n.children.length > 0 && !(n.data && n.data.text === true)) {
              result.children = [];
              n.children.forEach(function(child) {
                var c = serializeNode(child, depth + 1);
                if (c) result.children.push(c);
              });
            }

            return result;
          }

          var tree = serializeNode(root, 0);

          // Count total nodes
          function countNodes(n) {
            if (!n) return 0;
            var c = 1;
            if (n.children) n.children.forEach(function(ch) { c += countNodes(ch); });
            return c;
          }

          return {
            nodeCount: countNodes(tree),
            styleBlockCount: Object.keys(styleMap).length,
            tree: tree
          };
        })()
      `;
      const result = await evalInPage(code);
      findings.nodeTree = result;

      if (result.error) {
        elementsOutput.innerHTML = `<span class="error">${escHtml(result.error)}</span>`;
        labStatus.textContent = 'Error.';
        return;
      }

      const json = formatJson(result);
      let html = `<div class="success">Extracted ${result.nodeCount} nodes (${result.styleBlockCount} style blocks resolved)</div>`;
      html += `<div style="margin:8px 0">`;
      html += `<button id="btn-download-tree">Download node-tree.json</button>`;
      html += `</div>`;
      html += `<pre style="max-height:500px;overflow:auto;font-size:10px">${escHtml(json)}</pre>`;
      elementsOutput.innerHTML = html;

      document.getElementById('btn-download-tree')?.addEventListener('click', () => {
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'node-tree.json';
        a.click();
        URL.revokeObjectURL(url);
        labStatus.textContent = 'Downloaded node-tree.json';
      });
      labStatus.textContent = `${result.nodeCount} nodes extracted.`;
    } catch (err) {
      elementsOutput.innerHTML = `<span class="error">Error: ${escHtml(err.message)}</span>`;
      labStatus.textContent = 'Error.';
    }
  });

  // Test addToCanvas — probe Element construction + canvas insertion
  $('#btn-test-add').addEventListener('click', async () => {
    elementsOutput.innerHTML = `<span class="info">Probing Element construction paths...</span>`;
    labStatus.textContent = 'Probing...';
    try {
      const code = `
        (function() {
          var results = {};

          // 1. Ensure __plinthRequire is available (re-capture if needed)
          try {
            if (!window.__plinthRequire) {
              var captured = null;
              var mainChunk = window.webpackChunk;
              if (!mainChunk) { results.error = 'No webpackChunk found'; return results; }
              var fakeModuleId = '__plinth_probe_' + Date.now();
              mainChunk.push([[fakeModuleId], {
                [fakeModuleId]: function(module, exports, __webpack_require__) {
                  captured = __webpack_require__;
                }
              }, function(runtime) { if (runtime) runtime(fakeModuleId); }]);
              if (!captured) { results.error = 'Failed to capture __webpack_require__'; return results; }
              window.__plinthRequire = captured;
            }
            results.capturedRequire = true;
          } catch(e) {
            results.captureError = e.message;
            return results;
          }

          // 2. Load modules
          try {
          var r = window.__plinthRequire;
          var parser     = r(110970);  // WFDL parser
          var expressions = r(629107); // Expressions, Component, Plugins
          var compMap    = r(123699);  // ComponentMap
          var testSuite  = r(768948);  // forTestSuite, toSource
          var treeOps    = r(591280);  // HgV, tgb, Ycc, h6G
          var exprCtors  = r(953932);  // EElement, EList, EText, ERecord, EBoolean
          var Expr = expressions.Expressions;
          var wfPlugins = window._webflow?.state?.DesignerStore?.plugins;

          results.modulesLoaded = {
            parser: !!parser, expressions: !!Expr, compMap: !!compMap?.m,
            testSuite: !!testSuite, treeOps: !!treeOps, exprCtors: !!exprCtors
          };

          // ── Strategy 1: Build element and dispatch ELEMENT_ADDED ──
          // From probe #14 we know:
          //   - Real element is RAW {id: STRING, type: ARRAY, data: ...}, NOT expression-wrapped
          //   - position: "append", anchorId: bodyId
          //   - elementPreset: QN array like ["Basic","DivBlock"]
          //   - idMap values are strings, not arrays
          //   - initialStyleBlockId: a UUID string
          //   - designerState/styleBlockState/uiNodeState: refs to current state
          // From probe #15: expression-wrapped element CRASHED the page
          try {
            var Component = expressions.Component;
            var EP = expressions.ElementPreset;
            var tgb = treeOps.tgb;

            // Get body element ID
            var dsState = window._webflow?.state?.DesignerStore;
            var dsComponents = dsState?.components;
            var pageComp = dsComponents.get(tgb);
            var pageRender = Component.getRender(pageComp);
            var pageEl = Expr.getElement(pageRender);
            var bodyId = pageEl?.id;
            results.bodyId = bodyId;

            var childrenList = pageEl?.data?.val?.children?.val;
            results.beforeChildCount = childrenList?.length || childrenList?.size || 0;

            // ── Approach A: Use EElement constructor directly with string IDs ──
            try {
              var EC = exprCtors;
              var uuid = crypto.randomUUID();
              var styleId = crypto.randomUUID();

              // Build element using expression constructors (string ID, not array)
              var divElement = EC.EElement({
                id: uuid,
                type: ['Basic', 'Block'],
                data: EC.ERecord({
                  tag: EC.EEnum('div'),
                  text: EC.EBoolean(false),
                  children: EC.EList([])
                })
              });

              // divElement is expression-wrapped: {type: "Element", val: {id, type, data}}
              // Unwrap to get raw element
              var rawElement = Expr.getElement(divElement);

              results.approachA = {
                exprType: divElement?.type,
                rawType: rawElement?.type,
                rawId: rawElement?.id,
                rawIdType: typeof rawElement?.id,
                rawDataType: typeof rawElement?.data,
                rawConstructor: rawElement?.constructor?.name
              };

              // Dispatch
              window._webflow.dispatch({
                type: 'ELEMENT_ADDED',
                payload: {
                  anchorId: bodyId,
                  nativeId: uuid,
                  position: 'append',
                  anchorPath: null,
                  elementPreset: ['Basic', 'DivBlock'],
                  initialStyleBlockId: styleId,
                  styleBlockState: window._webflow?.state?.StyleBlockStore,
                  designerState: window._webflow?.state?.DesignerStore,
                  uiNodeState: window._webflow?.state?.UiNodeStore,
                  element: rawElement,
                  idMap: { 'Div Block': uuid },
                  assetsToImport: [],
                  componentMapPatch: null
                }
              });
              results.approachA.dispatched = true;

              // Check result
              var pc2 = window._webflow?.state?.DesignerStore?.components?.get(tgb);
              var pr2 = pc2 ? Component.getRender(pc2) : null;
              var pe2 = pr2 ? Expr.getElement(pr2) : null;
              var ch2 = pe2?.data?.val?.children?.val;
              results.approachA.afterCount = ch2?.length || ch2?.size || 0;
              results.approachA.worked = results.approachA.afterCount > results.beforeChildCount;

            } catch(e) {
              results.approachAError = e.message?.slice(0, 500);
              results.approachAStack = e.stack?.slice(0, 500);
            }

            // ── Approach B: Use instantiateFactory but unwrap + fix IDs ──
            if (!results.approachA?.worked) {
              try {
                var capturedPresets = {};
                wfPlugins.elementPresets.forEach(function(preset, qn) {
                  var parts = String(qn).split(',');
                  capturedPresets[parts[0] + '::' + parts[1]] = preset;
                });
                var divPreset = capturedPresets['Basic::DivBlock'];
                var uuid2 = crypto.randomUUID();
                var styleId2 = crypto.randomUUID();
                var inst = EP.instantiateFactory(divPreset, [uuid2]);

                // Unwrap expression
                var rawEl = inst.element?.val;

                // Fix ID from array to string
                var fixedEl;
                if (rawEl) {
                  // Check if rawEl is frozen/immutable
                  results.approachB = {
                    rawElFrozen: Object.isFrozen(rawEl),
                    rawElIdType: typeof rawEl.id,
                    rawElIdIsArray: Array.isArray(rawEl.id),
                    rawElConstructor: rawEl.constructor?.name
                  };

                  if (Array.isArray(rawEl.id)) {
                    // Create new object with string id, preserving data reference
                    fixedEl = { id: rawEl.id[0] || uuid2, type: rawEl.type, data: rawEl.data };
                  } else {
                    fixedEl = rawEl;
                  }

                  results.approachB.fixedId = fixedEl.id;
                  results.approachB.fixedIdType = typeof fixedEl.id;
                }

                // Fix idMap
                var fixedIdMap = {};
                Object.keys(inst.idMap).forEach(function(k) {
                  var v = inst.idMap[k];
                  fixedIdMap[k] = Array.isArray(v) ? v[0] : v;
                });

                window._webflow.dispatch({
                  type: 'ELEMENT_ADDED',
                  payload: {
                    anchorId: bodyId,
                    nativeId: fixedEl.id,
                    position: 'append',
                    anchorPath: null,
                    elementPreset: ['Basic', 'DivBlock'],
                    initialStyleBlockId: styleId2,
                    styleBlockState: window._webflow?.state?.StyleBlockStore,
                    designerState: window._webflow?.state?.DesignerStore,
                    uiNodeState: window._webflow?.state?.UiNodeStore,
                    element: fixedEl,
                    idMap: fixedIdMap,
                    assetsToImport: [],
                    componentMapPatch: null
                  }
                });
                results.approachB.dispatched = true;

                var pc3 = window._webflow?.state?.DesignerStore?.components?.get(tgb);
                var pr3 = pc3 ? Component.getRender(pc3) : null;
                var pe3 = pr3 ? Expr.getElement(pr3) : null;
                var ch3 = pe3?.data?.val?.children?.val;
                results.approachB.afterCount = ch3?.length || ch3?.size || 0;
                results.approachB.worked = results.approachB.afterCount > results.beforeChildCount;

              } catch(e) {
                results.approachBError = e.message?.slice(0, 500);
                results.approachBStack = e.stack?.slice(0, 500);
              }
            }

            // ── Approach C: Use expression-wrapped element (last resort) ──
            // Probe #15 crashed with this, but maybe it was a different issue.
            // Try with ALL other fields correct, just expression-wrapped element.
            if (!results.approachA?.worked && !results.approachB?.worked) {
              try {
                var EC3 = exprCtors;
                var uuid3 = crypto.randomUUID();
                var styleId3 = crypto.randomUUID();

                var wrappedElement = EC3.EElement({
                  id: uuid3,
                  type: ['Basic', 'Block'],
                  data: EC3.ERecord({
                    tag: EC3.EEnum('div'),
                    text: EC3.EBoolean(false),
                    children: EC3.EList([])
                  })
                });

                window._webflow.dispatch({
                  type: 'ELEMENT_ADDED',
                  payload: {
                    anchorId: bodyId,
                    nativeId: uuid3,
                    position: 'append',
                    anchorPath: null,
                    elementPreset: ['Basic', 'DivBlock'],
                    initialStyleBlockId: styleId3,
                    styleBlockState: window._webflow?.state?.StyleBlockStore,
                    designerState: window._webflow?.state?.DesignerStore,
                    uiNodeState: window._webflow?.state?.UiNodeStore,
                    element: wrappedElement,
                    idMap: { 'Div Block': uuid3 },
                    assetsToImport: [],
                    componentMapPatch: null
                  }
                });
                results.approachC = { dispatched: true };

                var pc4 = window._webflow?.state?.DesignerStore?.components?.get(tgb);
                var pr4 = pc4 ? Component.getRender(pc4) : null;
                var pe4 = pr4 ? Expr.getElement(pr4) : null;
                var ch4 = pe4?.data?.val?.children?.val;
                results.approachC.afterCount = ch4?.length || ch4?.size || 0;
                results.approachC.worked = results.approachC.afterCount > results.beforeChildCount;

              } catch(e) {
                results.approachCError = e.message?.slice(0, 500);
                results.approachCStack = e.stack?.slice(0, 500);
              }
            }

          } catch(e) {
            results.strategy1Error = e.message?.slice(0, 500);
            results.strategy1Stack = e.stack?.slice(0, 500);
          }

          } catch(e) {
            results.fatalError = e.message;
          }

          return results;
        })()
      `;

      const result = await evalInPage(code);
      findings.webpackInject = result;

      const json = formatJson(result);
      let html = `<div class="info">Webpack module injection results</div>`;

      if (result.capturedRequire) {
        html += `<div class="success"><strong>__webpack_require__ captured!</strong></div>`;
      } else {
        html += `<div class="error">Failed to capture __webpack_require__: ${escHtml(result.error || result.captureError || 'unknown')}</div>`;
      }

      if (result.modulesLoaded) {
        const loaded = Object.entries(result.modulesLoaded)
          .filter(([k]) => !k.endsWith('Keys'))
          .map(([k, v]) => `${k}: ${v ? 'YES' : 'no'}`)
          .join(' | ');
        html += `<div class="kv-row"><strong>Modules:</strong> ${loaded}</div>`;
      }

      // Strategy 1: ElementPreset instantiation
      if (result.instantiatedElement?.isElement) {
        html += `<div class="success"><strong>S1: DivBlock instantiated as Element!</strong></div>`;
        html += `<div class="kv-row" style="font-size:10px">${escHtml(result.instantiatedElement.toSource || '')}</div>`;
      }
      if (result.sectionInstantiated?.isElement) {
        html += `<div class="success"><strong>S1: Section instantiated as Element!</strong></div>`;
      }
      if (result.presetsByNamespace) {
        const total = Object.values(result.presetsByNamespace).reduce((s, a) => s + a.length, 0);
        html += `<div class="kv-row"><strong>Presets:</strong> ${total} across ${Object.keys(result.presetsByNamespace).length} namespaces</div>`;
      }

      // Strategy 2: Body inspection + tree ops
      if (result.bodyExprType) {
        html += `<div class="kv-row"><strong>S2: Page body type:</strong> ${escHtml(JSON.stringify(result.bodyExprType))}</div>`;
      }
      if (result.bodyChildren) {
        html += `<div class="kv-row"><strong>S2: Body children:</strong> type=${result.bodyChildren.type}, count=${result.bodyChildren.length}</div>`;
      }
      if (result.treeOpsByArity) {
        const a4 = result.treeOpsByArity['4'] || [];
        if (a4.length > 0) html += `<div class="kv-row"><strong>4-arg ops:</strong> ${a4.map(f => f.name || f.key).join(', ')}</div>`;
      }

      // Strategy 3: Page body + tree ops
      if (result.pageBody?.isElement) {
        html += `<div class="success"><strong>S3: Page body is Element</strong> (id: ${result.pageBodyId})</div>`;
        if (result.pageBodyChildren) {
          html += `<div class="kv-row">Body children: ${result.pageBodyChildren.type}, count: ${result.pageBodyChildren.listLength}</div>`;
        }
      }

      // Strategy 4: Module 50114 / addToCanvas
      if (result.hasAddToCanvas) {
        html += `<div class="success"><strong>S4: addToCanvas function found!</strong></div>`;
      }
      if (result.mod50114Functions) {
        const fnames = Object.values(result.mod50114Functions).map(f => f.name || '(anon)').filter(n => n !== '(anon)');
        if (fnames.length > 0) html += `<div class="kv-row"><strong>Module 50114:</strong> ${fnames.join(', ')}</div>`;
      }

      // Errors
      ['strategy1Error', 'strategy2Error', 'strategy3Error', 'strategy4Error', 'fatalError'].forEach(k => {
        if (result[k]) html += `<div class="error"><strong>${k}:</strong> ${escHtml(result[k])}</div>`;
      });

      html += `<div style="margin:8px 0"><button id="btn-download-add-result">Download webpack-inject.json</button></div>`;
      html += `<pre style="max-height:500px;overflow:auto;font-size:10px">${escHtml(json)}</pre>`;
      elementsOutput.innerHTML = html;

      document.getElementById('btn-download-add-result')?.addEventListener('click', () => {
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'webpack-inject.json';
        a.click();
        URL.revokeObjectURL(url);
      });

      labStatus.textContent = 'Done. Check results.';
    } catch (err) {
      elementsOutput.innerHTML = `<span class="error">Error: ${escHtml(err.message)}</span>`;
      labStatus.textContent = 'Error.';
    }
  });

  // ── Builder: Add elements via ELEMENT_ADDED dispatch ──────────────

  const builderType = $('#builder-type');
  const builderHeadingLevel = $('#builder-heading-level');
  const builderText = $('#builder-text');
  const builderPosition = $('#builder-position');
  const builderOutput = $('#builder-output');

  // Show/hide heading level selector
  builderType.addEventListener('change', () => {
    builderHeadingLevel.style.display = builderType.value === 'Heading' ? '' : 'none';
  });

  // Element type configs: [qualifiedType, presetQN, dataBuilder]
  // dataBuilder is a function name string that will be expanded in the eval code
  const ELEMENT_CONFIGS = {
    Section:   { type: "['Layout','Section']",  preset: "['Layout','Section']",   tag: 'section', hasChildren: true },
    DivBlock:  { type: "['Basic','Block']",     preset: "['Basic','DivBlock']",   tag: 'div', hasText: false, hasChildren: true },
    Heading:   { type: "['Basic','Heading']",   preset: "['Basic','Heading']",    tag: null, hasChildren: true, hasTextChild: true },
    Paragraph: { type: "['Basic','Paragraph']", preset: "['Basic','Paragraph']",  hasChildren: true, hasTextChild: true },
    Button:    { type: "['Basic','Link']",      preset: "['Basic','Button']",     hasChildren: true, hasTextChild: true, isButton: true },
    TextBlock: { type: "['Basic','Block']",     preset: "['Basic','TextBlock']",  tag: 'div', hasText: true, hasChildren: true, hasTextChild: true },
    HFlex:     { type: "['Layout','HFlex']",    preset: "['Layout','HFlex']",     tag: 'div', hasChildren: true },
    VFlex:     { type: "['Layout','VFlex']",    preset: "['Layout','VFlex']",     tag: 'div', hasChildren: true },
    Grid:      { type: "['Layout','Grid']",     preset: "['Layout','Grid']",      tag: 'div', hasChildren: true },
    Link:      { type: "['Basic','Link']",      preset: "['Basic','LinkBlock']",  hasChildren: true },
  };

  $('#btn-builder-add').addEventListener('click', async () => {
    const elType = builderType.value;
    const text = builderText.value.trim();
    const headingLevel = builderHeadingLevel.value;
    const position = builderPosition.value;
    const config = ELEMENT_CONFIGS[elType];

    if (!config) {
      builderOutput.innerHTML = `<span class="error">Unknown element type: ${escHtml(elType)}</span>`;
      return;
    }

    builderOutput.innerHTML = `<span class="info">Adding ${escHtml(elType)}...</span>`;

    // Build the data fields code string (injected into eval)
    const dataFieldsCode = buildDataFieldsCode(config, headingLevel,
      JSON.stringify(text || getDefaultText(elType)));
    const idMapKey = getIdMapKey(elType);

    try {
      const code = `
        (function() {
          try {
            // Bootstrap __plinthRequire if needed
            if (!window.__plinthRequire) {
              var captured = null;
              var mainChunk = window.webpackChunk;
              if (!mainChunk) return { error: 'No webpackChunk found on page' };
              var fakeId = '__plinth_builder_' + Date.now();
              mainChunk.push([[fakeId], {
                [fakeId]: function(m, e, req) { captured = req; }
              }, function(rt) { if (rt) rt(fakeId); }]);
              if (!captured) return { error: 'Failed to capture __webpack_require__' };
              window.__plinthRequire = captured;
            }
            var r = window.__plinthRequire;
            var expressions = r(629107);
            var exprCtors = r(953932);
            var treeOps = r(591280);
            var Expr = expressions.Expressions;
            var Component = expressions.Component;
            var EC = exprCtors;

            // Get body element
            var dsState = window._webflow?.state?.DesignerStore;
            if (!dsState) return { error: 'DesignerStore not found' };
            var tgb = treeOps.tgb;
            var pageComp = dsState.components.get(tgb);
            var pageRender = Component.getRender(pageComp);
            var bodyEl = Expr.getElement(pageRender);
            var bodyId = bodyEl?.id;
            if (!bodyId) return { error: 'Body element not found' };

            var childrenList = bodyEl?.data?.val?.children?.val;
            var beforeCount = childrenList?.length || childrenList?.size || 0;

            // Generate IDs
            var uuid = crypto.randomUUID();
            var styleId = crypto.randomUUID();
            var textUuid = crypto.randomUUID();

            // Build element data based on type
            var dataFields = {};
            ${dataFieldsCode}

            var element = EC.EElement({
              id: uuid,
              type: ${config.type},
              data: EC.ERecord(dataFields)
            });

            var rawElement = Expr.getElement(element);
            if (!rawElement) return { error: 'Failed to unwrap element' };

            // Determine anchor
            var anchorId = bodyId;
            var pos = ${JSON.stringify(position)};
            if (pos === 'after' && childrenList) {
              var len = childrenList.length || childrenList.size || 0;
              if (len > 0) {
                var last = childrenList[len - 1] || (typeof childrenList.get === 'function' ? childrenList.get(len - 1) : null);
                anchorId = last?.val?.id || bodyId;
                pos = 'after';
              } else {
                pos = 'append';
              }
            } else {
              pos = 'append';
            }

            // Build idMap
            var idMap = {};
            idMap[${JSON.stringify(idMapKey)}] = uuid;

            // Dispatch
            window._webflow.dispatch({
              type: 'ELEMENT_ADDED',
              payload: {
                anchorId: anchorId,
                nativeId: uuid,
                position: pos,
                anchorPath: null,
                elementPreset: ${config.preset},
                initialStyleBlockId: styleId,
                styleBlockState: window._webflow?.state?.StyleBlockStore,
                designerState: dsState,
                uiNodeState: window._webflow?.state?.UiNodeStore,
                element: rawElement,
                idMap: idMap,
                assetsToImport: [],
                componentMapPatch: null
              }
            });

            // Verify
            var pageComp2 = window._webflow?.state?.DesignerStore?.components?.get(tgb);
            var pageRender2 = pageComp2 ? Component.getRender(pageComp2) : null;
            var bodyEl2 = pageRender2 ? Expr.getElement(pageRender2) : null;
            var children2 = bodyEl2?.data?.val?.children?.val;
            var afterCount = children2?.length || children2?.size || 0;

            return {
              success: afterCount > beforeCount,
              elementId: uuid,
              styleBlockId: styleId,
              beforeCount: beforeCount,
              afterCount: afterCount,
              type: ${JSON.stringify(elType)},
              position: pos,
              anchorId: anchorId
            };
          } catch(e) {
            return { error: e.message, stack: e.stack?.slice(0, 500) };
          }
        })()
      `;

      const result = await evalInPage(code);

      if (result.error) {
        builderOutput.innerHTML = `<span class="error">Error: ${escHtml(result.error)}</span>`;
        if (result.stack) builderOutput.innerHTML += `<pre style="font-size:9px;color:#f88">${escHtml(result.stack)}</pre>`;
      } else if (result.success) {
        builderOutput.innerHTML = `<span class="success">${escHtml(elType)} added! ID: ${result.elementId} (${result.beforeCount}\u2192${result.afterCount} children)</span>`;
      } else {
        builderOutput.innerHTML = `<span class="error">${escHtml(elType)} dispatch completed but child count unchanged (${result.beforeCount}\u2192${result.afterCount})</span>`;
        builderOutput.innerHTML += `<pre style="font-size:10px">${escHtml(formatJson(result))}</pre>`;
      }
    } catch (err) {
      builderOutput.innerHTML = `<span class="error">Error: ${escHtml(err.message)}</span>`;
    }
  });

  function getDefaultText(elType) {
    switch (elType) {
      case 'Heading': return 'Heading';
      case 'Paragraph': return 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.';
      case 'Button': return 'Button Text';
      case 'TextBlock': return 'Text block content';
      default: return '';
    }
  }

  function getIdMapKey(elType) {
    switch (elType) {
      case 'DivBlock': return 'Div Block';
      case 'TextBlock': return 'TextBlock';
      case 'HFlex': return 'HFlex';
      case 'VFlex': return 'VFlex';
      case 'LinkBlock': case 'Link': return 'Link Block';
      default: return elType;
    }
  }

  function buildDataFieldsCode(config, headingLevel, escapedText) {
    // Generates JS code string that builds dataFields inside the eval context
    const lines = [];

    if (config.tag === null && config.type.includes('Heading')) {
      // Heading — tag depends on level
      lines.push(`dataFields.tag = EC.EEnum('h${headingLevel}');`);
    } else if (config.tag) {
      lines.push(`dataFields.tag = EC.EEnum('${config.tag}');`);
    }

    if (config.hasText !== undefined) {
      lines.push(`dataFields.text = EC.EBoolean(${config.hasText});`);
    }

    if (config.isButton) {
      lines.push(`dataFields.button = EC.EBoolean(true);`);
      lines.push(`dataFields.block = EC.EText('');`);
      lines.push(`dataFields.search = EC.ERecord({ exclude: EC.EBoolean(true) });`);
      lines.push(`dataFields.eventIds = EC.EList([]);`);
      lines.push(`dataFields.link = EC.ELiteral({ name: ['Basic','Link'], value: { mode: 'external', url: '#' } });`);
    }

    if (config.hasChildren) {
      if (config.hasTextChild) {
        lines.push(`var textContent = ${escapedText};`);
        lines.push(`if (textContent) {`);
        lines.push(`  dataFields.children = EC.EList([`);
        lines.push(`    EC.EElement({ id: textUuid, type: ['Basic','String'], data: EC.EText(textContent) })`);
        lines.push(`  ]);`);
        lines.push(`} else {`);
        lines.push(`  dataFields.children = EC.EList([]);`);
        lines.push(`}`);
      } else {
        lines.push(`dataFields.children = EC.EList([]);`);
      }
    }

    // Section needs grid data
    if (config.tag === 'section') {
      lines.push(`dataFields.grid = EC.ERecord({ type: EC.EText('section') });`);
    }

    return lines.join('\n            ');
  }

  // ── Find setStyle: locate StyleActionCreators in webpack ──────────

  $('#btn-find-setstyle').addEventListener('click', async () => {
    builderOutput.innerHTML = '<span class="info">Searching webpack modules for StyleActionCreators.setStyle...</span>';
    try {
      const code = `
        (function() {
          var results = {};

          // ── Strategy 1: Check _webflow.creators ──
          var creators = window._webflow?.creators;
          if (creators) {
            var creatorKeys = Object.keys(creators);
            results.creatorsCount = creatorKeys.length;
            // Find anything with "style" (case-insensitive)
            var styleCreators = creatorKeys.filter(function(k) {
              return k.toLowerCase().indexOf('style') >= 0;
            });
            results.styleCreatorKeys = styleCreators;
            // Probe each style creator
            results.styleCreatorDetails = {};
            styleCreators.forEach(function(k) {
              var c = creators[k];
              var detail = { type: typeof c };
              if (typeof c === 'object' && c !== null) {
                detail.keys = Object.keys(c).slice(0, 30);
                // Check for setStyle
                if (typeof c.setStyle === 'function') {
                  detail.hasSetStyle = true;
                  detail.setStyleArity = c.setStyle.length;
                  detail.setStyleStr = String(c.setStyle).slice(0, 200);
                }
                // Check for other style methods
                var methods = Object.keys(c).filter(function(m) { return typeof c[m] === 'function'; });
                detail.methods = methods.slice(0, 30);
              } else if (typeof c === 'function') {
                detail.arity = c.length;
                detail.str = String(c).slice(0, 200);
              }
              results.styleCreatorDetails[k] = detail;
            });
            // Also check for setStyle at top level of any creator
            var setStyleIn = creatorKeys.filter(function(k) {
              var c = creators[k];
              return c && typeof c === 'object' && typeof c.setStyle === 'function';
            });
            results.creatorsWithSetStyle = setStyleIn;
          } else {
            results.creatorsCount = 0;
            results.noCreators = true;
          }

          // ── Strategy 2: Search _webflow for setStyle directly ──
          var wf = window._webflow;
          if (wf) {
            if (typeof wf.setStyle === 'function') {
              results.wfSetStyle = { arity: wf.setStyle.length, str: String(wf.setStyle).slice(0, 200) };
            }
            // Check wf.actions or wf.actionCreators
            ['actions', 'actionCreators', 'styleActions', 'StyleActionCreators'].forEach(function(prop) {
              if (wf[prop]) {
                results['wf.' + prop] = {
                  type: typeof wf[prop],
                  keys: typeof wf[prop] === 'object' ? Object.keys(wf[prop]).slice(0, 20) : undefined
                };
              }
            });
          }

          // ── Strategy 3: Search webpack module cache ──
          var req = window.__plinthRequire;
          if (req && req.c) {
            var moduleIds = Object.keys(req.c);
            results.moduleCacheSize = moduleIds.length;
            var found = [];

            for (var i = 0; i < moduleIds.length; i++) {
              var mid = moduleIds[i];
              try {
                var mod = req.c[mid];
                if (!mod || !mod.exports) continue;
                var exp = mod.exports;

                // Check direct export
                if (typeof exp.setStyle === 'function') {
                  found.push({
                    moduleId: mid,
                    location: 'exports.setStyle',
                    arity: exp.setStyle.length,
                    str: String(exp.setStyle).slice(0, 300),
                    siblingKeys: Object.keys(exp).filter(function(k) { return typeof exp[k] === 'function'; }).slice(0, 30)
                  });
                }
                // Check default export
                if (exp.default && typeof exp.default.setStyle === 'function') {
                  found.push({
                    moduleId: mid,
                    location: 'exports.default.setStyle',
                    arity: exp.default.setStyle.length,
                    str: String(exp.default.setStyle).slice(0, 300),
                    siblingKeys: Object.keys(exp.default).filter(function(k) { return typeof exp.default[k] === 'function'; }).slice(0, 30)
                  });
                }
                // Check named exports for StyleActionCreators
                var expKeys = Object.keys(exp);
                for (var j = 0; j < expKeys.length; j++) {
                  var ek = expKeys[j];
                  if (ek.toLowerCase().indexOf('styleaction') >= 0 || ek === 'StyleActionCreators') {
                    var sac = exp[ek];
                    found.push({
                      moduleId: mid,
                      location: 'exports.' + ek,
                      type: typeof sac,
                      keys: typeof sac === 'object' ? Object.keys(sac).slice(0, 30) : undefined,
                      hasSetStyle: sac && typeof sac.setStyle === 'function'
                    });
                  }
                }
              } catch(e) {}
            }
            results.webpackFound = found;
          } else if (req && !req.c) {
            // Try the chunk injection approach to get module cache
            results.noModuleCache = true;
            results.requireKeys = Object.keys(req).slice(0, 20);
          } else {
            results.noRequire = true;
          }

          // ── Strategy 4: Search via dispatch spy metadata ──
          // The meta said "StyleActionCreators::setStyle" — search all bound dispatch functions
          if (wf && wf._dispatch) {
            // Look for StyleActionCreators as a global or on __WEBFLOW__ namespaces
            var searchKeys = ['StyleActionCreators', 'styleActionCreators', 'StyleActions'];
            searchKeys.forEach(function(sk) {
              if (window[sk]) {
                results['window.' + sk] = {
                  type: typeof window[sk],
                  keys: typeof window[sk] === 'object' ? Object.keys(window[sk]).slice(0, 20) : undefined
                };
              }
            });
          }

          // ── Strategy 5: Look for bound action creators on the store/flux object ──
          if (wf) {
            var wfKeys = Object.keys(wf);
            results.wfKeys = wfKeys.slice(0, 50);
            // Look for anything that has setStyle as a method
            var wfWithSetStyle = wfKeys.filter(function(k) {
              try {
                var v = wf[k];
                return v && typeof v === 'object' && typeof v.setStyle === 'function';
              } catch(e) { return false; }
            });
            results.wfKeysWithSetStyle = wfWithSetStyle;

            // Check if creators has a nested structure
            if (creators) {
              var allCreatorKeys = Object.keys(creators);
              // Flatten: check each creator for setStyle
              var deepSearch = [];
              allCreatorKeys.forEach(function(ck) {
                try {
                  var c = creators[ck];
                  if (!c || typeof c !== 'object') return;
                  var cKeys = Object.keys(c);
                  cKeys.forEach(function(mk) {
                    try {
                      var m = c[mk];
                      if (m && typeof m === 'object' && typeof m.setStyle === 'function') {
                        deepSearch.push(ck + '.' + mk);
                      }
                    } catch(e) {}
                  });
                } catch(e) {}
              });
              results.deepCreatorsWithSetStyle = deepSearch;
            }
          }

          // ── Strategy 6: Chunk injection to scan ALL modules ──
          // If module cache is empty, use webpackChunk push to scan
          if ((!req || !req.c || Object.keys(req.c).length === 0) && window.webpackChunk) {
            var scanResults = [];
            try {
              window.webpackChunk.push([['__plinth_style_probe'], {},
                function(__webpack_require__) {
                  var cache = __webpack_require__.c;
                  if (!cache) return;
                  var mids = Object.keys(cache);
                  for (var i = 0; i < mids.length; i++) {
                    try {
                      var m = cache[mids[i]];
                      if (!m || !m.exports) continue;
                      var e = m.exports;
                      // Check for setStyle
                      if (typeof e.setStyle === 'function') {
                        scanResults.push({
                          id: mids[i], loc: 'exports.setStyle',
                          arity: e.setStyle.length,
                          str: String(e.setStyle).slice(0, 300),
                          siblings: Object.keys(e).filter(function(k) { return typeof e[k] === 'function'; }).slice(0, 30)
                        });
                      }
                      if (e.default && typeof e.default === 'object' && typeof e.default.setStyle === 'function') {
                        scanResults.push({
                          id: mids[i], loc: 'exports.default.setStyle',
                          arity: e.default.setStyle.length,
                          str: String(e.default.setStyle).slice(0, 300),
                          siblings: Object.keys(e.default).filter(function(k) { return typeof e.default[k] === 'function'; }).slice(0, 30)
                        });
                      }
                      // Also find anything with "setStyle" in any nested key
                      var eKeys = Object.keys(e);
                      for (var j = 0; j < eKeys.length; j++) {
                        try {
                          var v = e[eKeys[j]];
                          if (v && typeof v === 'object' && typeof v.setStyle === 'function' && eKeys[j] !== 'default') {
                            scanResults.push({
                              id: mids[i], loc: 'exports.' + eKeys[j] + '.setStyle',
                              arity: v.setStyle.length,
                              parentKeys: Object.keys(v).filter(function(k) { return typeof v[k] === 'function'; }).slice(0, 30)
                            });
                          }
                        } catch(e2) {}
                      }
                    } catch(e) {}
                  }
                  // Save require for future use
                  window.__plinthRequire = __webpack_require__;
                  results.chunkModuleCacheSize = mids.length;
                }
              ]);
            } catch(e) {
              results.chunkScanError = e.message;
            }
            results.chunkScanResults = scanResults;
          }

          return results;
        })()
      `;

      const result = await evalInPage(code);

      let html = '<div class="success">setStyle Probe Results:</div>';

      // Strategy 1: creators
      if (result.creatorsWithSetStyle && result.creatorsWithSetStyle.length > 0) {
        html += `<div style="color:#8f8;font-weight:bold;margin:8px 0">FOUND setStyle in _webflow.creators: ${escHtml(result.creatorsWithSetStyle.join(', '))}</div>`;
      }
      if (result.styleCreatorKeys && result.styleCreatorKeys.length > 0) {
        html += `<div style="margin:4px 0"><strong style="color:#ff8">Style-related creator keys (${result.styleCreatorKeys.length}):</strong></div>`;
        for (const [k, detail] of Object.entries(result.styleCreatorDetails || {})) {
          html += `<div class="kv-row" style="margin:2px 0;border-bottom:1px solid #333;padding-bottom:4px">`;
          html += `<strong style="color:#8cf">${escHtml(k)}</strong>`;
          if (detail.hasSetStyle) html += ` <span style="color:#8f8;font-weight:bold">HAS setStyle (arity ${detail.setStyleArity})</span>`;
          if (detail.methods) html += `<div style="font-size:10px;color:#888">methods: ${escHtml(detail.methods.join(', '))}</div>`;
          if (detail.keys) html += `<div style="font-size:10px;color:#666">keys: ${escHtml(detail.keys.join(', '))}</div>`;
          if (detail.setStyleStr) html += `<pre style="font-size:9px;max-height:100px;overflow:auto">${escHtml(detail.setStyleStr)}</pre>`;
          html += `</div>`;
        }
      }

      // Strategy 2: _webflow direct
      if (result.wfSetStyle) {
        html += `<div style="color:#8f8;font-weight:bold;margin:8px 0">FOUND _webflow.setStyle!</div>`;
        html += `<pre style="font-size:9px">${escHtml(formatJson(result.wfSetStyle))}</pre>`;
      }
      if (result.wfKeysWithSetStyle && result.wfKeysWithSetStyle.length > 0) {
        html += `<div style="color:#8f8;margin:4px 0">_webflow keys with setStyle: ${escHtml(result.wfKeysWithSetStyle.join(', '))}</div>`;
      }

      // Strategy 3 & 6: webpack
      const wpFound = (result.webpackFound || []).concat(result.chunkScanResults || []);
      if (wpFound.length > 0) {
        html += `<div style="color:#8f8;font-weight:bold;margin:8px 0">FOUND in webpack modules (${wpFound.length} hits):</div>`;
        for (const hit of wpFound) {
          html += `<div class="kv-row" style="margin:4px 0;border-bottom:1px solid #333;padding-bottom:4px">`;
          html += `<strong style="color:#ff8">Module ${escHtml(String(hit.moduleId || hit.id))}</strong>`;
          html += ` → <span style="color:#8cf">${escHtml(hit.location || hit.loc)}</span>`;
          if (hit.arity !== undefined) html += ` (arity ${hit.arity})`;
          if (hit.siblings || hit.siblingKeys) {
            const sibs = hit.siblings || hit.siblingKeys;
            html += `<div style="font-size:10px;color:#888">sibling methods: ${escHtml(sibs.join(', '))}</div>`;
          }
          if (hit.parentKeys) {
            html += `<div style="font-size:10px;color:#888">parent methods: ${escHtml(hit.parentKeys.join(', '))}</div>`;
          }
          if (hit.str) html += `<pre style="font-size:9px;max-height:100px;overflow:auto">${escHtml(hit.str)}</pre>`;
          html += `</div>`;
        }
      }

      // Deep creator search
      if (result.deepCreatorsWithSetStyle && result.deepCreatorsWithSetStyle.length > 0) {
        html += `<div style="color:#8f8;margin:4px 0">Deep creator paths with setStyle: ${escHtml(result.deepCreatorsWithSetStyle.join(', '))}</div>`;
      }

      // Diagnostics
      html += `<div style="margin-top:12px;border-top:1px solid #444;padding-top:8px"><strong style="color:#888">Diagnostics:</strong></div>`;
      html += `<div style="font-size:10px;color:#666">Creators count: ${result.creatorsCount || 0}</div>`;
      html += `<div style="font-size:10px;color:#666">Module cache: ${result.moduleCacheSize || result.chunkModuleCacheSize || 'N/A'}</div>`;
      if (result.wfKeys) html += `<div style="font-size:10px;color:#666">_webflow keys: ${escHtml(result.wfKeys.join(', '))}</div>`;
      if (result.noRequire) html += `<div style="color:#fa8">No __plinthRequire — click "Test addToCanvas" first to inject webpack hook</div>`;
      if (result.noModuleCache) html += `<div style="color:#fa8">__plinthRequire exists but .c is empty — used chunk injection fallback</div>`;

      // Download full results
      html += `<div style="margin:8px 0"><button id="btn-download-setstyle-probe" style="background:#4a2a4a;color:#f8f;padding:4px 12px">Download probe-setstyle.json</button></div>`;
      builderOutput.innerHTML = html;

      document.getElementById('btn-download-setstyle-probe')?.addEventListener('click', () => {
        const blob = new Blob([formatJson(result)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'probe-setstyle.json'; a.click();
        URL.revokeObjectURL(url);
      });
    } catch (err) {
      builderOutput.innerHTML = `<span class="error">Error: ${escHtml(err.message)}</span>`;
    }
  });

  // ── Dump All Creators: enumerate all _webflow.creators namespaces ──

  $('#btn-dump-creators').addEventListener('click', async () => {
    builderOutput.innerHTML = '<span class="info">Enumerating all _webflow.creators namespaces...</span>';
    try {
      const code = `
        (function() {
          var creators = window._webflow?.creators;
          if (!creators) return { error: '_webflow.creators not found' };

          var namespaces = {};
          var keys = Object.keys(creators);

          for (var i = 0; i < keys.length; i++) {
            var name = keys[i];
            var c = creators[name];
            var ns = { type: typeof c };

            if (typeof c === 'object' && c !== null) {
              var allKeys = Object.keys(c);
              var methods = [];
              var properties = [];

              for (var j = 0; j < allKeys.length; j++) {
                var k = allKeys[j];
                try {
                  var v = c[k];
                  if (typeof v === 'function') {
                    methods.push({ name: k, arity: v.length });
                  } else if (k !== 'displayName') {
                    properties.push({ name: k, type: typeof v, value: v === null ? null : typeof v === 'string' ? v.slice(0, 80) : typeof v === 'number' || typeof v === 'boolean' ? v : undefined });
                  }
                } catch(e) {}
              }

              ns.displayName = c.displayName || null;
              ns.methodCount = methods.length;
              ns.methods = methods;
              ns.properties = properties.length > 0 ? properties : undefined;
            } else if (typeof c === 'function') {
              ns.arity = c.length;
              ns.str = String(c).slice(0, 150);
            }

            namespaces[name] = ns;
          }

          return {
            count: keys.length,
            namespaces: namespaces
          };
        })()
      `;

      const result = await evalInPage(code);

      if (result.error) {
        builderOutput.innerHTML = `<span class="error">${escHtml(result.error)}</span>`;
        return;
      }

      // Categorize namespaces by likely purpose
      const categories = {
        'Style & CSS': ['Style', 'CSS', 'Class', 'Font', 'Color', 'Swatch', 'Variable', 'Token'],
        'Elements & DOM': ['Element', 'Node', 'Component', 'Drag', 'Drop', 'Canvas', 'Panel'],
        'CMS & Data': ['Collection', 'Binding', 'Dynamic', 'Field', 'Item', 'CMS', 'Data'],
        'Page & Site': ['Page', 'Site', 'Publish', 'Save', 'Route', 'SEO', 'Settings'],
        'Interactions': ['Interaction', 'Animation', 'Trigger', 'IX'],
        'Ecommerce': ['Commerce', 'Product', 'Cart', 'Checkout'],
      };

      function categorize(name) {
        for (const [cat, keywords] of Object.entries(categories)) {
          if (keywords.some(kw => name.toLowerCase().includes(kw.toLowerCase()))) return cat;
        }
        return 'Other';
      }

      // Group
      const grouped = {};
      for (const [name, ns] of Object.entries(result.namespaces)) {
        const cat = categorize(name);
        if (!grouped[cat]) grouped[cat] = [];
        grouped[cat].push({ name, ...ns });
      }

      let html = `<div style="margin:4px 0 8px 0;display:flex;align-items:center;gap:8px">
        <button id="btn-download-creators" style="background:#3a3a2a;color:#ff8;padding:4px 12px;font-weight:bold">Download creators-dump.json</button>
        <span class="success" style="margin:0">${result.count} creator namespaces found</span>
      </div>`;

      for (const [cat, items] of Object.entries(grouped).sort((a, b) => a[0].localeCompare(b[0]))) {
        html += `<div style="margin:12px 0 4px 0;color:#ff8;font-weight:bold;border-bottom:1px solid #444;padding-bottom:2px">${escHtml(cat)} (${items.length})</div>`;

        for (const ns of items) {
          html += `<div class="kv-row" style="margin:4px 0;padding:4px 0;border-bottom:1px solid #333">`;
          html += `<strong style="color:#8cf">${escHtml(ns.name)}</strong>`;
          if (ns.displayName) html += ` <span style="color:#666;font-size:10px">${escHtml(ns.displayName)}</span>`;
          html += ` <span style="color:#888;font-size:10px">(${ns.methodCount} methods)</span>`;

          if (ns.methods && ns.methods.length > 0) {
            html += `<div style="font-size:10px;margin-top:2px">`;
            for (const m of ns.methods) {
              // Highlight key methods
              const isKey = ['setStyle', 'setStyles', 'addElement', 'createElement', 'deleteElement',
                'save', 'publish', 'bind', 'subscribe', 'setVariable', 'createVariable',
                'addToCanvas', 'insertElement', 'moveElement', 'duplicateElement',
                'setContent', 'setText', 'setProperty', 'updateStyle', 'applyStyle',
                'createStyle', 'deleteStyle', 'renameStyle'].some(k =>
                  m.name.toLowerCase().includes(k.toLowerCase()));
              const color = isKey ? '#8f8' : '#aaa';
              html += `<span style="color:${color};margin-right:8px">${escHtml(m.name)}(${m.arity})</span>`;
            }
            html += `</div>`;
          }
          html += `</div>`;
        }
      }

      builderOutput.innerHTML = html;
      document.getElementById('btn-download-creators')?.addEventListener('click', () => {
        const blob = new Blob([formatJson(result)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'creators-dump.json'; a.click();
        URL.revokeObjectURL(url);
      });
    } catch (err) {
      builderOutput.innerHTML = `<span class="error">Error: ${escHtml(err.message)}</span>`;
    }
  });

  // ── Test setStyle: call StyleActionCreators.setStyle on selected element ──

  $('#btn-test-setstyle').addEventListener('click', async () => {
    builderOutput.innerHTML = '<span class="info">Testing StyleActionCreators.setStyle...</span>';
    try {
      const code = `
        (function() {
          var results = {};

          // Get StyleActionCreators
          var SAC = window._webflow?.creators?.StyleActionCreators;
          if (!SAC) return { error: 'StyleActionCreators not found at _webflow.creators.StyleActionCreators' };
          if (typeof SAC.setStyle !== 'function') return { error: 'SAC.setStyle is not a function' };

          results.sacMethods = Object.keys(SAC).filter(function(k) { return typeof SAC[k] === 'function'; });

          // Probe setStyle, startSetStyle, endSetStyle arities
          results.arities = {
            setStyle: SAC.setStyle.length,
            setStyles: SAC.setStyles ? SAC.setStyles.length : null,
            startSetStyle: SAC.startSetStyle ? SAC.startSetStyle.length : null,
            endSetStyle: SAC.endSetStyle ? SAC.endSetStyle.length : null,
            stylePeekStart: SAC.stylePeekStart ? SAC.stylePeekStart.length : null,
            stylePeekEnd: SAC.stylePeekEnd ? SAC.stylePeekEnd.length : null
          };

          // Check what element is currently selected
          var state = window._webflow?.state;
          var selectedId = null;
          if (state) {
            // Try to find the selected node
            var ds = state.DesignerStore;
            if (ds) {
              // DesignerStore likely has selectedNodeId or similar
              var dsKeys = Object.keys(ds).slice(0, 30);
              results.designerStoreKeys = dsKeys;
              // Try common patterns
              if (ds.selectedNodeId) selectedId = ds.selectedNodeId;
              else if (ds.selectedNativeId) selectedId = ds.selectedNativeId;
              else if (ds.selectedElementNativeId) selectedId = ds.selectedElementNativeId;
              // Also try get() in case it's Immutable
              if (!selectedId && typeof ds.get === 'function') {
                try {
                  selectedId = ds.get('selectedNodeId') || ds.get('selectedNativeId') || ds.get('selectedElementNativeId');
                } catch(e) {}
              }
              results.selectedId = selectedId;
            }

            // Get the current style rule for the selected element
            var styleStore = state.StyleBlockStore;
            if (styleStore) {
              results.styleStoreType = styleStore.constructor?.name;
              results.styleStoreHasGet = typeof styleStore.get === 'function';
            }
          }

          // Install dispatch spy to capture what setStyle sends
          var capturedActions = [];
          var origDispatch = window._webflow._dispatch;
          if (!window.__plinthSpyOrig) window.__plinthSpyOrig = origDispatch;
          var realOrig = window.__plinthSpyOrig;

          window._webflow._dispatch = function(action, lane) {
            try {
              capturedActions.push({
                type: action?.type,
                payloadKeys: action?.payload ? Object.keys(action.payload).slice(0, 20) : [],
                time: Date.now()
              });
            } catch(e) {}
            return realOrig.apply(this, arguments);
          };

          // Try calling the 3-phase style change
          try {
            // Phase 1: start
            results.phase1 = 'calling startSetStyle()';
            SAC.startSetStyle();
            results.phase1 = 'success';
          } catch(e) {
            results.phase1Error = e.message;
          }

          try {
            // Phase 2: setStyle — set background-color to a test color
            results.phase2 = 'calling setStyle({path: "backgroundColor", value: "hsla(0, 100%, 50%, 1.00)"})';
            SAC.setStyle({ path: 'backgroundColor', value: 'hsla(0, 100%, 50%, 1.00)' });
            results.phase2 = 'success';
          } catch(e) {
            results.phase2Error = e.message + '\\n' + e.stack?.slice(0, 500);
          }

          try {
            // Phase 3: endSetStyle — commit
            results.phase3 = 'calling endSetStyle({commit: true})';
            SAC.endSetStyle({ commit: true });
            results.phase3 = 'success';
          } catch(e) {
            results.phase3Error = e.message;
          }

          // Restore dispatch and report captured actions
          window._webflow._dispatch = realOrig;
          results.capturedActions = capturedActions;
          results.capturedCount = capturedActions.length;

          return results;
        })()
      `;

      const result = await evalInPage(code);

      let html = '';
      if (result.error) {
        html = `<span class="error">${escHtml(result.error)}</span>`;
      } else {
        // Show results
        const allSuccess = result.phase1 === 'success' && result.phase2 === 'success' && result.phase3 === 'success';

        if (allSuccess) {
          html += `<div style="color:#8f8;font-weight:bold;font-size:14px;margin:8px 0">setStyle WORKED — all 3 phases succeeded!</div>`;
        }

        html += `<div style="margin:4px 0"><strong>Phase 1 (startSetStyle):</strong> <span style="color:${result.phase1 === 'success' ? '#8f8' : '#f88'}">${escHtml(result.phase1 || result.phase1Error)}</span></div>`;
        html += `<div style="margin:4px 0"><strong>Phase 2 (setStyle):</strong> <span style="color:${result.phase2 === 'success' ? '#8f8' : '#f88'}">${escHtml(result.phase2 || result.phase2Error)}</span></div>`;
        html += `<div style="margin:4px 0"><strong>Phase 3 (endSetStyle):</strong> <span style="color:${result.phase3 === 'success' ? '#8f8' : '#f88'}">${escHtml(result.phase3 || result.phase3Error)}</span></div>`;

        if (result.capturedActions && result.capturedActions.length > 0) {
          html += `<div style="margin:8px 0"><strong>Dispatched actions (${result.capturedCount}):</strong></div>`;
          for (const a of result.capturedActions) {
            html += `<div style="font-size:10px;color:#ff8;margin:2px 0">${escHtml(a.type)} <span style="color:#888">[${escHtml(a.payloadKeys.join(', '))}]</span></div>`;
          }
        }

        if (result.selectedId) {
          html += `<div style="margin:4px 0;font-size:10px;color:#888">Selected element: ${escHtml(result.selectedId)}</div>`;
        } else {
          html += `<div style="margin:4px 0;font-size:10px;color:#fa8">No element selected — select one on canvas first for targeted styles</div>`;
        }

        html += `<div style="margin:8px 0"><button id="btn-download-setstyle-test" style="background:#4a2a2a;color:#f88;padding:4px 12px">Download test-setstyle.json</button></div>`;
      }

      builderOutput.innerHTML = html;
      document.getElementById('btn-download-setstyle-test')?.addEventListener('click', () => {
        const blob = new Blob([formatJson(result)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'test-setstyle.json'; a.click();
        URL.revokeObjectURL(url);
      });
    } catch (err) {
      builderOutput.innerHTML = `<span class="error">Error: ${escHtml(err.message)}</span>`;
    }
  });

  // ── Spy: Capture style and binding dispatch actions ──────────────

  // Generic action spy — installs on _dispatch, filters by keyword, captures full payloads
  // Now tracks total dispatch count + noise count for diagnostics
  async function installActionSpy(filterKeywords, label) {
    const keywords = JSON.stringify(filterKeywords);
    const code = `
      (function() {
        try {
          var flux = window._webflow;
          if (!flux || !flux._dispatch) return { error: '_webflow._dispatch not found' };

          // Read any previously captured actions first
          var prev = window.__plinthSpyResults || [];
          var stats = {
            totalDispatches: window.__plinthSpyTotal || 0,
            noiseFiltered: window.__plinthSpyNoise || 0,
            skippedTypes: window.__plinthSpySkipped ? Object.keys(window.__plinthSpySkipped).slice(0,20).map(function(k) {
              return k + ' (' + window.__plinthSpySkipped[k] + 'x)';
            }) : []
          };

          // Reset counters
          window.__plinthSpyResults = [];
          window.__plinthSpyTotal = 0;
          window.__plinthSpyNoise = 0;
          window.__plinthSpySkipped = {};

          // Install/reinstall spy — always get the real original
          if (!window.__plinthSpyOrig) {
            window.__plinthSpyOrig = flux._dispatch;
          }
          var orig = window.__plinthSpyOrig;
          var keywords = ${keywords};

          flux._dispatch = function(action, lane) {
            try {
              window.__plinthSpyTotal = (window.__plinthSpyTotal || 0) + 1;
              var t = action?.type || '';
              // Filter: capture actions matching any keyword, skip noise
              var dominated = ['NODE_HOVERED','POST_MESSAGE_RECEIVED','CANVAS_SCROLL',
                'MULTIPLAYER_PRESENCE','ANALYTICS','LEFT_SIDEBAR_SCREENSHOT',
                'GRID_CELL_HOVERED','CANVAS_USER_SCROLL','AUDIT_QUEUED'];
              var isNoise = dominated.some(function(n) { return t.indexOf(n) >= 0; });

              if (isNoise) {
                window.__plinthSpyNoise = (window.__plinthSpyNoise || 0) + 1;
              } else {
                var matchesFilter = keywords.length === 0 || keywords.some(function(kw) {
                  return t.toUpperCase().indexOf(kw.toUpperCase()) >= 0;
                });

                if (matchesFilter && window.__plinthSpyResults.length < 100) {
                  var entry = {
                    type: t,
                    keys: action ? Object.keys(action).filter(function(k) { return k !== 'state' && k !== 'timestamp'; }).slice(0, 15) : [],
                    lane: lane,
                    time: Date.now()
                  };
                  if (action?.payload && typeof action.payload === 'object') {
                    entry.payloadKeys = Object.keys(action.payload).slice(0, 25);
                    // Deep-capture payload values (safe stringify)
                    var vals = {};
                    Object.keys(action.payload).slice(0, 25).forEach(function(k) {
                      var v = action.payload[k];
                      if (v === null || v === undefined) vals[k] = v;
                      else if (typeof v === 'string') vals[k] = v.slice(0, 200);
                      else if (typeof v === 'number' || typeof v === 'boolean') vals[k] = v;
                      else if (Array.isArray(v)) vals[k] = { _array: true, length: v.length, first: String(v[0]).slice(0, 100) };
                      else if (typeof v === 'object') {
                        vals[k] = {
                          _type: typeof v,
                          constructor: v.constructor?.name,
                          keys: Object.keys(v).slice(0, 15),
                          hasGet: typeof v.get === 'function',
                          size: typeof v.size === 'number' ? v.size : undefined
                        };
                      }
                      else vals[k] = typeof v;
                    });
                    entry.payloadValues = vals;
                  }
                  window.__plinthSpyResults.push(entry);
                } else if (!matchesFilter) {
                  // Track skipped non-noise types for diagnostics
                  if (!window.__plinthSpySkipped) window.__plinthSpySkipped = {};
                  window.__plinthSpySkipped[t] = (window.__plinthSpySkipped[t] || 0) + 1;
                }
              }
            } catch(e) {}
            return orig.apply(this, arguments);
          };

          return {
            installed: true,
            previousCaptures: prev.length,
            captured: prev,
            stats: stats
          };
        } catch(e) {
          return { error: e.message };
        }
      })()
    `;
    return evalInPage(code);
  }

  // Poll spy status — returns live counts without draining captures
  async function pollSpyStatus() {
    const code = `
      (function() {
        return {
          total: window.__plinthSpyTotal || 0,
          noise: window.__plinthSpyNoise || 0,
          captured: (window.__plinthSpyResults || []).length,
          types: (window.__plinthSpyResults || []).map(function(r) { return r.type; })
        };
      })()
    `;
    return evalInPage(code);
  }

  // Live spy status poller
  let spyPollInterval = null;
  function startSpyPolling(label) {
    stopSpyPolling();
    spyPollInterval = setInterval(async () => {
      try {
        const status = await pollSpyStatus();
        const statusEl = document.getElementById('spy-live-status');
        if (statusEl) {
          statusEl.textContent = `[${label}] dispatches: ${status.total} | noise: ${status.noise} | captured: ${status.captured}` +
            (status.types.length > 0 ? ` | types: ${[...new Set(status.types)].join(', ')}` : '');
          statusEl.style.color = status.captured > 0 ? '#8f8' : '#ff8';
        }
      } catch(e) {}
    }, 500);
  }
  function stopSpyPolling() {
    if (spyPollInterval) {
      clearInterval(spyPollInterval);
      spyPollInterval = null;
    }
  }

  // Shared: render spy capture results — download button at TOP, not buried at bottom
  function renderSpyCaptures(result, label, filename, groupByType) {
    stopSpyPolling();
    const captured = result.captured;

    // Download button FIRST
    let html = `<div style="margin:4px 0 8px 0;display:flex;align-items:center;gap:8px">
      <button id="btn-download-spy-dl" style="background:#2a4a2a;color:#8f8;padding:4px 12px;font-weight:bold">Download ${escHtml(filename)}</button>
      <span class="success" style="margin:0">Captured ${captured.length} actions</span>
    </div>`;

    if (result.stats) {
      html += `<div style="font-size:10px;color:#888;margin-bottom:4px">Total dispatches: ${result.stats.totalDispatches} | Noise filtered: ${result.stats.noiseFiltered}</div>`;
      if (result.stats.skippedTypes.length > 0) {
        html += `<div style="font-size:10px;color:#666;margin-bottom:4px">Skipped: ${escHtml(result.stats.skippedTypes.join(', '))}</div>`;
      }
    }

    if (groupByType) {
      const byType = {};
      for (const a of captured) {
        if (!byType[a.type]) byType[a.type] = [];
        byType[a.type].push(a);
      }
      for (const [type, actions] of Object.entries(byType)) {
        const first = actions[0];
        html += `<div class="kv-row" style="margin:4px 0;border-bottom:1px solid #333;padding-bottom:4px">`;
        html += `<strong style="color:#ff8">${escHtml(type)}</strong> <span style="color:#888">(${actions.length}x)</span>`;
        if (first.payloadKeys) {
          html += `<div style="font-size:10px;color:#888">keys: ${escHtml(first.payloadKeys.join(', '))}</div>`;
        }
        if (first.payloadValues) {
          html += `<pre style="font-size:9px;max-height:100px;overflow:auto">${escHtml(formatJson(first.payloadValues))}</pre>`;
        }
        html += `</div>`;
      }
    } else {
      for (const action of captured) {
        html += `<div class="kv-row" style="margin:4px 0;border-bottom:1px solid #333;padding-bottom:4px">`;
        html += `<strong style="color:#ff8">${escHtml(action.type)}</strong>`;
        if (action.payloadKeys) {
          html += `<div style="font-size:10px;color:#888">keys: ${escHtml(action.payloadKeys.join(', '))}</div>`;
        }
        if (action.payloadValues) {
          html += `<pre style="font-size:9px;max-height:150px;overflow:auto">${escHtml(formatJson(action.payloadValues))}</pre>`;
        }
        html += `</div>`;
      }
    }

    builderOutput.innerHTML = html;
    document.getElementById('btn-download-spy-dl')?.addEventListener('click', () => {
      const blob = new Blob([formatJson(captured)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    });
  }

  // Shared: render spy "waiting" state with live polling
  function renderSpyWaiting(result, label, instructions) {
    let html = `<div class="success">${escHtml(label)} spy installed!</div>`;
    if (result.stats && result.stats.totalDispatches > 0) {
      html += `<div style="color:#888;font-size:11px;margin:4px 0">Previous run: ${result.stats.totalDispatches} dispatches, ${result.stats.noiseFiltered} noise, 0 captured</div>`;
      if (result.stats.skippedTypes.length > 0) {
        html += `<div style="font-size:10px;color:#666">Skipped: ${escHtml(result.stats.skippedTypes.join(', '))}</div>`;
      }
    }
    html += `<div id="spy-live-status" style="color:#ff8;font-size:11px;margin:6px 0;font-family:monospace">[${escHtml(label)}] waiting for dispatches...</div>`;
    for (const step of instructions) {
      html += `<div class="info">${escHtml(step)}</div>`;
    }
    builderOutput.innerHTML = html;
    startSpyPolling(label);
  }

  // Generic spy button handler
  async function handleSpyButton(keywords, label, filename, groupByType, instructions) {
    builderOutput.innerHTML = `<span class="info">Installing ${escHtml(label)} action spy...</span>`;
    try {
      const result = await installActionSpy(keywords, label);
      if (result.error) {
        builderOutput.innerHTML = `<span class="error">${escHtml(result.error)}</span>`;
        stopSpyPolling();
        return;
      }
      if (result.captured && result.captured.length > 0) {
        renderSpyCaptures(result, label, filename, groupByType);
      } else {
        renderSpyWaiting(result, label, instructions);
      }
    } catch (err) {
      builderOutput.innerHTML = `<span class="error">Error: ${escHtml(err.message)}</span>`;
      stopSpyPolling();
    }
  }

  // Spy Styles button
  $('#btn-spy-styles').addEventListener('click', () => handleSpyButton(
    ['STYLE', 'CLASS', 'BLOCK', 'CSS', 'PROPERTY', 'SELECTOR', 'VARIABLE', 'TOKEN', 'THEME', 'SWATCH', 'COLOR'],
    'styles', 'spy-styles.json', false,
    ['1. Select an element on the canvas',
     '2. Change a CSS property in the Style panel (e.g. background color)',
     '3. Watch the live counter — click "Spy Styles" again when captured > 0']
  ));

  // Spy Bindings button
  $('#btn-spy-bindings').addEventListener('click', () => handleSpyButton(
    ['BIND', 'COLLECTION', 'DYNAMIC', 'FIELD', 'CMS', 'ITEM', 'CONTEXT'],
    'bindings', 'spy-bindings.json', false,
    ['1. Select a text element inside a Collection List',
     '2. Bind it to a CMS field via "Get text from" in Settings',
     '3. Watch the live counter — click "Spy Bindings" again when captured > 0']
  ));

  // Spy All button — capture everything non-noise
  $('#btn-spy-all').addEventListener('click', () => handleSpyButton(
    [], 'all', 'spy-all.json', true,
    ['1. Do any action in the Designer (select element, change style, etc.)',
     '2. Watch the live counter above',
     '3. Click "Spy All" again to see captured actions']
  ));

  // Spy Variables button
  $('#btn-spy-variables').addEventListener('click', () => handleSpyButton(
    ['VARIABLE', 'TOKEN', 'SWATCH', 'THEME', 'COLOR', 'DESIGN_TOKEN', 'CSS_VAR'],
    'variables', 'spy-variables.json', false,
    ['1. Open Variables panel (or Style panel → use a variable)',
     '2. Create, edit, or apply a variable/swatch',
     '3. Watch the live counter — click "Spy Variables" again when captured > 0']
  ));

  // Deep Style Spy — captures full style payload with CSS property diffs
  $('#btn-spy-deep-style').addEventListener('click', async () => {
    builderOutput.innerHTML = '<span class="info">Installing deep style spy...</span>';
    try {
      const code = `
        (function() {
          try {
            var flux = window._webflow;
            if (!flux || !flux._dispatch) return { error: '_webflow._dispatch not found' };

            // Read previous captures
            var prev = window.__plinthDeepStyleResults || [];

            // Reset
            window.__plinthDeepStyleResults = [];
            window.__plinthDeepStyleCount = 0;

            // Install spy
            if (!window.__plinthSpyOrig) {
              window.__plinthSpyOrig = flux._dispatch;
            }
            var orig = window.__plinthSpyOrig;

            flux._dispatch = function(action, lane) {
              try {
                window.__plinthDeepStyleCount = (window.__plinthDeepStyleCount || 0) + 1;
                var t = action?.type || '';

                // Capture style-related actions with DEEP payload serialization
                if (t === '__DEPRECATED__STYLE_BLOCK_STATE_CHANGED' ||
                    t === 'SET_STYLE_STARTED' || t === 'SET_STYLE_ENDED' ||
                    t === 'STYLE_SHEET_RENDERED' ||
                    t === 'MULTIPLAYER_DATA_UPDATES_ACCEPTED') {

                  var entry = { type: t, time: Date.now() };
                  var p = action?.payload;
                  if (!p) { entry.noPayload = true; }
                  else if (t === '__DEPRECATED__STYLE_BLOCK_STATE_CHANGED') {
                    // Deep-capture the style change
                    entry.nodeNativeId = p.nodeNativeId;
                    entry.autoCreatedStyleBlockGuid = p.autoCreatedStyleBlockGuid;
                    entry.ruleRemoved = p.ruleRemoved;
                    entry.ephemeral = p.ephemeral;
                    entry.expectedStyleRuleGuid = p.expectedStyleRuleGuid;

                    // styleState: extract a SAMPLE of CSS properties (first 30 non-default)
                    if (p.styleState && typeof p.styleState === 'object') {
                      var ss = p.styleState;
                      var ssKeys = Object.keys(ss);
                      entry.styleStateKeyCount = ssKeys.length;
                      // Get the computed style property name map
                      entry.styleStateSample = {};
                      var count = 0;
                      for (var i = 0; i < ssKeys.length && count < 50; i++) {
                        var k = ssKeys[i];
                        var v = ss[k];
                        // Skip internal keys and empty/default values
                        if (k.startsWith('__')) {
                          entry.styleStateSample[k] = typeof v === 'string' ? v.slice(0, 100) : typeof v;
                          count++;
                          continue;
                        }
                        if (v !== '' && v !== 'none' && v !== 'auto' && v !== 'normal' &&
                            v !== '0px' && v !== 'rgb(0, 0, 0)' && v !== 'rgba(0, 0, 0, 0)' &&
                            v !== 'start' && v !== 'stretch' && v !== 'visible') {
                          entry.styleStateSample[k] = typeof v === 'string' ? v.slice(0, 200) : typeof v;
                          count++;
                        }
                      }
                    }

                    // styleBlockState: probe Immutable.js structure
                    if (p.styleBlockState) {
                      var sbs = p.styleBlockState;
                      entry.styleBlockState = {
                        constructor: sbs.constructor?.name,
                        hasMap: !!sbs._map,
                        hasToJS: typeof sbs.toJS === 'function',
                        hasGet: typeof sbs.get === 'function',
                        size: sbs.size
                      };
                      // Try toJS() to get plain object
                      if (typeof sbs.toJS === 'function') {
                        try {
                          var plain = sbs.toJS();
                          var plainKeys = Object.keys(plain);
                          entry.styleBlockState.keys = plainKeys.slice(0, 30);
                          entry.styleBlockState.totalKeys = plainKeys.length;
                          // Sample some values
                          var sample = {};
                          for (var j = 0; j < Math.min(plainKeys.length, 15); j++) {
                            var pk = plainKeys[j];
                            var pv = plain[pk];
                            if (pv === null || pv === undefined) sample[pk] = pv;
                            else if (typeof pv === 'string') sample[pk] = pv.slice(0, 200);
                            else if (typeof pv === 'number' || typeof pv === 'boolean') sample[pk] = pv;
                            else if (typeof pv === 'object') sample[pk] = { type: typeof pv, keys: Object.keys(pv).slice(0, 10), constructor: pv.constructor?.name };
                            else sample[pk] = typeof pv;
                          }
                          entry.styleBlockState.sample = sample;
                        } catch(e) {
                          entry.styleBlockState.toJSError = e.message;
                        }
                      }
                      // Try get() for known keys
                      if (typeof sbs.get === 'function') {
                        try {
                          var tryKeys = ['rules', 'styles', 'breakpoints', 'variants', 'properties'];
                          var found = {};
                          for (var k = 0; k < tryKeys.length; k++) {
                            var gv = sbs.get(tryKeys[k]);
                            if (gv !== undefined) found[tryKeys[k]] = { type: typeof gv, constructor: gv?.constructor?.name, hasToJS: typeof gv?.toJS === 'function' };
                          }
                          entry.styleBlockState.getResults = found;
                        } catch(e) {}
                      }
                    }

                    // meta
                    if (p.meta) {
                      try { entry.meta = JSON.parse(JSON.stringify(p.meta)); } catch(e) { entry.meta = 'unserializable'; }
                    }
                  } else if (t === 'SET_STYLE_ENDED') {
                    entry.commit = p.commit;
                    if (p.oldStates) {
                      entry.oldStatesKeys = Object.keys(p.oldStates);
                      // Probe oldStates.style
                      if (p.oldStates.style) {
                        var os = p.oldStates.style;
                        entry.oldStyleState = {
                          constructor: os.constructor?.name,
                          type: typeof os,
                          keyCount: typeof os === 'object' ? Object.keys(os).length : 0
                        };
                      }
                      if (p.oldStates.styleBlock) {
                        var ob = p.oldStates.styleBlock;
                        entry.oldStyleBlock = {
                          constructor: ob.constructor?.name,
                          hasToJS: typeof ob?.toJS === 'function',
                          size: ob?.size
                        };
                      }
                    }
                  } else if (t === 'MULTIPLAYER_DATA_UPDATES_ACCEPTED') {
                    entry.messageId = p.messageId;
                    entry.pageId = p.pageId;
                    if (p.operations) {
                      entry.operationKeys = Object.keys(p.operations);
                      // Deep-capture the operations.styles if present
                      if (p.operations.styles) {
                        try {
                          var stylesOp = p.operations.styles;
                          if (typeof stylesOp === 'object') {
                            entry.stylesOperation = {
                              constructor: stylesOp.constructor?.name,
                              keys: Object.keys(stylesOp).slice(0, 20),
                              type: typeof stylesOp
                            };
                            // Try to serialize
                            try { entry.stylesOperationData = JSON.parse(JSON.stringify(stylesOp)); } catch(e) { entry.stylesOperationData = 'unserializable'; }
                          }
                        } catch(e) {}
                      }
                    }
                  }

                  if (window.__plinthDeepStyleResults.length < 30) {
                    window.__plinthDeepStyleResults.push(entry);
                  }
                }
              } catch(e) {}
              return orig.apply(this, arguments);
            };

            return {
              installed: true,
              previousCaptures: prev.length,
              captured: prev,
              dispatchCount: window.__plinthDeepStyleCount || 0
            };
          } catch(e) {
            return { error: e.message };
          }
        })()
      `;

      const result = await evalInPage(code);

      if (result.error) {
        builderOutput.innerHTML = `<span class="error">${escHtml(result.error)}</span>`;
        stopSpyPolling();
        return;
      }

      if (result.captured && result.captured.length > 0) {
        stopSpyPolling();
        let html = `<div style="margin:4px 0 8px 0;display:flex;align-items:center;gap:8px">
          <button id="btn-download-spy-dl" style="background:#2a4a2a;color:#8f8;padding:4px 12px;font-weight:bold">Download spy-deep-style.json</button>
          <span class="success" style="margin:0">Captured ${result.captured.length} style actions</span>
        </div>`;
        for (const action of result.captured) {
          html += `<div class="kv-row" style="margin:4px 0;border-bottom:1px solid #333;padding-bottom:4px">`;
          html += `<strong style="color:#ff8">${escHtml(action.type)}</strong>`;
          if (action.ephemeral !== undefined) html += ` <span style="color:#888">[ephemeral=${action.ephemeral}]</span>`;
          if (action.nodeNativeId) html += ` <span style="color:#8cf">${escHtml(action.nodeNativeId)}</span>`;
          if (action.expectedStyleRuleGuid) html += `<div style="font-size:10px;color:#888">rule: ${escHtml(action.expectedStyleRuleGuid)}</div>`;
          // Show styleState sample
          if (action.styleStateSample) {
            html += `<div style="font-size:10px;color:#8f8">styleState (${action.styleStateKeyCount} keys, showing non-default):</div>`;
            html += `<pre style="font-size:9px;max-height:150px;overflow:auto">${escHtml(formatJson(action.styleStateSample))}</pre>`;
          }
          if (action.styleBlockState) {
            html += `<div style="font-size:10px;color:#f88">styleBlockState:</div>`;
            html += `<pre style="font-size:9px;max-height:150px;overflow:auto">${escHtml(formatJson(action.styleBlockState))}</pre>`;
          }
          if (action.commit !== undefined) html += `<div style="font-size:10px;color:#8f8">commit: ${action.commit}</div>`;
          if (action.operationKeys) html += `<div style="font-size:10px;color:#8cf">operations: ${escHtml(action.operationKeys.join(', '))}</div>`;
          if (action.stylesOperationData) {
            html += `<pre style="font-size:9px;max-height:150px;overflow:auto">${escHtml(formatJson(action.stylesOperationData))}</pre>`;
          }
          html += `</div>`;
        }
        builderOutput.innerHTML = html;
        document.getElementById('btn-download-spy-dl')?.addEventListener('click', () => {
          const blob = new Blob([formatJson(result.captured)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = 'spy-deep-style.json'; a.click();
          URL.revokeObjectURL(url);
        });
      } else {
        // Install polling for deep style spy
        let html = `<div class="success">Deep style spy installed!</div>`;
        html += `<div id="spy-live-status" style="color:#ff8;font-size:11px;margin:6px 0;font-family:monospace">[deep-style] waiting...</div>`;
        html += `<div class="info">1. Select an element on the canvas</div>
          <div class="info">2. Change ONE CSS property (e.g. set background-color to red)</div>
          <div class="info">3. Click "Deep Style Spy" again to get the full payload</div>`;
        builderOutput.innerHTML = html;
        // Custom polling for deep style spy
        stopSpyPolling();
        spyPollInterval = setInterval(async () => {
          try {
            const status = await evalInPage(`({
              count: (window.__plinthDeepStyleResults || []).length,
              total: window.__plinthDeepStyleCount || 0,
              types: (window.__plinthDeepStyleResults || []).map(function(r) { return r.type; })
            })`);
            const el = document.getElementById('spy-live-status');
            if (el) {
              el.textContent = `[deep-style] dispatches: ${status.total} | style actions: ${status.count}` +
                (status.types.length > 0 ? ` | ${[...new Set(status.types)].join(', ')}` : '');
              el.style.color = status.count > 0 ? '#8f8' : '#ff8';
            }
          } catch(e) {}
        }, 500);
      }
    } catch (err) {
      builderOutput.innerHTML = `<span class="error">Error: ${escHtml(err.message)}</span>`;
      stopSpyPolling();
    }
  });

  // Validate WFDL — test a string without adding to canvas
  $('#btn-validate-wfdl').addEventListener('click', async () => {
    // Use the snapshot paste textarea for input
    const wfdlStr = $('#snapshot-paste').value.trim();
    if (!wfdlStr) {
      snapshotOutput.innerHTML = '<span class="info">Paste a WFDL string into the textarea above, then click Validate WFDL.</span>';
      return;
    }
    snapshotOutput.innerHTML = '<span class="info">Validating WFDL...</span>';
    try {
      // Escape the string for embedding in eval
      const escaped = JSON.stringify(wfdlStr);
      const code = `
        (function() {
          var wf = window.wf;
          if (!wf || typeof wf.validateWFDL !== 'function') return { error: 'wf.validateWFDL not available' };
          try {
            var result = wf.validateWFDL(${escaped});
            return JSON.parse(JSON.stringify(result));
          } catch(e) {
            return { error: e.message };
          }
        })()
      `;
      const result = await evalInPage(code);
      findings.lastWfdlValidation = { input: wfdlStr, result };

      if (result.isValid) {
        snapshotOutput.innerHTML = `<div class="success">WFDL is valid!</div><pre style="font-size:10px">${escHtml(formatJson(result))}</pre>`;
      } else {
        snapshotOutput.innerHTML = `<div class="error">WFDL invalid:</div><pre style="font-size:10px">${escHtml(formatJson(result))}</pre>`;
      }
    } catch (err) {
      snapshotOutput.innerHTML = `<span class="error">Error: ${escHtml(err.message)}</span>`;
    }
  });

  // WFDL Element Lab — validate every element type to discover valid syntax
  $('#btn-wfdl-lab').addEventListener('click', async () => {
    const btn = $('#btn-wfdl-lab');
    btn.disabled = true;
    elementsOutput.innerHTML = '<span class="info">Running WFDL Element Lab...</span>';

    const results = {};
    const total = WFDL_ELEMENTS.length;

    for (let i = 0; i < total; i++) {
      const el = WFDL_ELEMENTS[i];
      labStatus.textContent = `Validating ${i + 1}/${total}: ${el.name}...`;

      try {
        const escaped = JSON.stringify(el.wfdl);
        const code = `
          (function() {
            var wf = window.wf;
            if (!wf || typeof wf.validateWFDL !== 'function') return { error: 'no validateWFDL' };
            try {
              return JSON.parse(JSON.stringify(wf.validateWFDL(${escaped})));
            } catch(e) {
              return { error: e.message };
            }
          })()
        `;
        const result = await evalInPage(code);
        results[el.name] = { wfdl: el.wfdl, ...result };
      } catch (err) {
        results[el.name] = { wfdl: el.wfdl, error: err.message };
      }
    }

    findings.wfdlLab = results;

    // Render
    const valid = Object.entries(results).filter(([, v]) => v.isValid);
    const invalid = Object.entries(results).filter(([, v]) => !v.isValid);

    let html = `<div class="success">WFDL Element Lab: ${valid.length} valid, ${invalid.length} invalid</div>`;

    if (valid.length > 0) {
      html += '<div style="margin-top:8px"><span class="kv-key" style="font-weight:bold">Valid WFDL:</span></div>';
      for (const [name, r] of valid) {
        html += `<div class="kv-row" style="margin-top:4px">`;
        html += `<span class="success">\u2713</span> <span class="kv-key">${escHtml(name)}</span>`;
        html += ` <span class="info">${escHtml(r.wfdl)}</span>`;
        html += `</div>`;
        if (r.validationSteps) {
          html += `<div class="kv-row" style="padding-left:20px"><span class="kv-keys">${escHtml(formatJson(r.validationSteps))}</span></div>`;
        }
      }
    }

    if (invalid.length > 0) {
      html += '<div style="margin-top:12px"><span class="kv-key" style="font-weight:bold">Invalid WFDL:</span></div>';
      for (const [name, r] of invalid) {
        html += `<div class="kv-row" style="margin-top:4px">`;
        html += `<span class="error">\u2717</span> <span class="kv-key">${escHtml(name)}</span>`;
        html += ` <span class="info">${escHtml(r.wfdl)}</span>`;
        html += `</div>`;
        const errMsg = r.error?.message || r.error || '';
        if (errMsg) {
          html += `<div class="kv-row" style="padding-left:20px"><span class="error">${escHtml(typeof errMsg === 'string' ? errMsg : formatJson(errMsg))}</span></div>`;
        }
      }
    }

    elementsOutput.innerHTML = html;
    labStatus.textContent = `Done — ${valid.length} valid, ${invalid.length} invalid.`;
    btn.disabled = false;
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
          // This mimics what the Designer does internally via postMessage
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
      presetsOutput.innerHTML += '<div class="info">Note: The message traffic will reveal the internal element structure if it succeeds.</div>';
    } catch (err) {
      presetsOutput.innerHTML = `<span class="error">Error: ${escHtml(err.message)}</span>`;
    }
  });

  // ── Export / Full Scan ────────────────────────────────────────────

  const exportStatus = $('#export-status');
  let findings = { globals: null, react: null, elements: null, presets: null, methods: null };

  function setExportStatus(msg) {
    exportStatus.textContent = msg;
  }

  // ── Reusable probe functions (return data, not HTML) ─────────────

  async function probeGlobals() {
    const code = `
      (function() {
        var keys = ${JSON.stringify(WEBFLOW_KEYS)};
        var results = [];
        keys.forEach(function(k) {
          try {
            var v = window[k];
            if (v !== undefined) {
              var type = typeof v;
              var ctor = v && v.constructor ? v.constructor.name : type;
              var topKeys = [];
              if (type === 'object' && v !== null) {
                try { topKeys = Object.keys(v).slice(0, 30); } catch(e) {}
              }
              results.push({ key: k, type: type, ctor: ctor, topKeys: topKeys });
            }
          } catch(e) {
            results.push({ key: k, error: e.message });
          }
        });
        try {
          Object.getOwnPropertyNames(window).forEach(function(k) {
            if (/webflow|^wf|^_wf|^__wf/i.test(k) && !keys.includes(k)) {
              try {
                var v = window[k];
                results.push({ key: k, type: typeof v, ctor: v && v.constructor ? v.constructor.name : typeof v, topKeys: [], discovered: true });
              } catch(e) {}
            }
          });
        } catch(e) {}
        return results;
      })()
    `;
    return evalInPage(code);
  }

  async function probeReact() {
    const code = `
      (function() {
        var results = [];
        var els = document.querySelectorAll('body, body > *, #root, #__next, [id*="app"], [id*="root"]');
        var seen = new Set();
        els.forEach(function(el) {
          if (seen.has(el)) return; seen.add(el);
          Object.keys(el).forEach(function(k) {
            if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$') || k.startsWith('__reactContainer$')) {
              var fiber = el[k], name = '(unknown)';
              try { if (fiber && fiber.type && fiber.type.name) name = fiber.type.name; } catch(e) {}
              results.push({ tag: el.tagName.toLowerCase(), id: el.id || null, fiberKey: k, component: name });
            }
          });
        });
        var iframes = document.querySelectorAll('iframe');
        iframes.forEach(function(iframe, idx) {
          try {
            var doc = iframe.contentDocument; if (!doc) return;
            var root = doc.querySelector('#root, body'); if (!root) return;
            Object.keys(root).forEach(function(k) {
              if (k.startsWith('__reactFiber$') || k.startsWith('__reactContainer$')) {
                results.push({ tag: 'iframe#' + idx + '>' + root.tagName.toLowerCase(), id: root.id, fiberKey: k, iframe: true });
              }
            });
          } catch(e) {
            results.push({ tag: 'iframe#' + idx, error: 'cross-origin', iframe: true });
          }
        });
        return results;
      })()
    `;
    return evalInPage(code);
  }

  async function probeElements() {
    const code = `
      (function() {
        function walk(el, d) {
          if (d > 8) return null;
          var r = { tag: el.tagName ? el.tagName.toLowerCase() : '?', id: el.id || null, cls: el.className && typeof el.className === 'string' ? el.className : null, wfId: el.getAttribute ? el.getAttribute('data-w-id') : null, wfType: el.getAttribute ? el.getAttribute('data-wf-type') : null, kids: [] };
          if (el.children) { for (var i = 0; i < el.children.length && i < 50; i++) { var c = walk(el.children[i], d+1); if (c) r.kids.push(c); } }
          return r;
        }
        var iframes = document.querySelectorAll('iframe');
        for (var i = 0; i < iframes.length; i++) {
          try { var doc = iframes[i].contentDocument; if (!doc) continue; var body = doc.querySelector('body'); if (body && body.children.length > 0) return { source: 'iframe#' + i, tree: walk(body, 0) }; } catch(e) {}
        }
        return { source: 'main', tree: walk(document.body, 0) };
      })()
    `;
    return evalInPage(code);
  }

  // ── Format findings as markdown ──────────────────────────────────

  function findingsToMarkdown() {
    const lines = ['# Plinth Inspector — Findings', '', `Scanned: ${new Date().toISOString()}`, ''];

    lines.push('---', '', '## Window Globals', '');
    if (findings.globals && findings.globals.length > 0) {
      for (const g of findings.globals) {
        if (g.error) {
          lines.push(`- \`window.${g.key}\` — ERROR: ${g.error}`);
        } else {
          let line = `- \`window.${g.key}\` — ${g.ctor}`;
          if (g.topKeys && g.topKeys.length > 0) {
            line += ` { ${g.topKeys.join(', ')}${g.topKeys.length >= 30 ? ', ...' : ''} }`;
          }
          if (g.discovered) line += ' (discovered)';
          lines.push(line);
        }
      }
    } else {
      lines.push('No Webflow-related globals found.');
    }

    lines.push('', '## React Roots', '');
    if (findings.react && findings.react.length > 0) {
      for (const r of findings.react) {
        let line = `- \`${r.tag}`;
        if (r.id) line += `#${r.id}`;
        line += `\` — ${r.fiberKey}`;
        if (r.component) line += ` → ${r.component}`;
        if (r.error) line += ` (${r.error})`;
        if (r.iframe) line += ' (iframe)';
        lines.push(line);
      }
    } else {
      lines.push('No React fiber roots found.');
    }

    lines.push('', '## Canvas DOM', '');
    if (findings.elements) {
      lines.push(`Source: ${findings.elements.source}`, '', '```');
      function walkTree(node, indent) {
        let line = '  '.repeat(indent) + `<${node.tag}>`;
        if (node.id) line += ` #${node.id}`;
        if (node.cls) line += ` .${node.cls.split(' ').join(' .')}`;
        if (node.wfId) line += ` [data-w-id="${node.wfId}"]`;
        if (node.wfType) line += ` [data-wf-type="${node.wfType}"]`;
        lines.push(line);
        if (node.kids) { for (const k of node.kids) { walkTree(k, indent + 1); } }
      }
      if (findings.elements.tree) walkTree(findings.elements.tree, 0);
      lines.push('```');
    } else {
      lines.push('No elements dumped.');
    }

    lines.push('', '## JSON-RPC Methods', '');
    if (findings.methods && findings.methods.length > 0) {
      // Deduplicate by method name, count occurrences
      const methodMap = {};
      for (const m of findings.methods) {
        if (!methodMap[m.method]) {
          methodMap[m.method] = { count: 0, dirs: new Set(), sample: m.data };
        }
        methodMap[m.method].count++;
        methodMap[m.method].dirs.add(m.dir === 'in' ? 'Designer→Ext' : 'Ext→Designer');
      }
      for (const [name, info] of Object.entries(methodMap).sort((a, b) => a[0].localeCompare(b[0]))) {
        lines.push(`### ${name}`);
        lines.push(`- Direction: ${[...info.dirs].join(', ')}`);
        lines.push(`- Seen: ${info.count}x`);
        lines.push(`- Sample payload:`);
        lines.push('```json', formatJson(info.sample), '```');
        lines.push('');
      }
    } else {
      lines.push('No messages captured yet. Re-scan to capture postMessage traffic.');
    }

    lines.push('', '## Preset Children', '');
    if (findings.presets && Object.keys(findings.presets).length > 0) {
      for (const [name, children] of Object.entries(findings.presets).sort((a, b) => a[0].localeCompare(b[0]))) {
        if (children === 'error') {
          lines.push(`- **${name}** — failed to create`);
        } else if (children.length === 0) {
          lines.push(`- **${name}** — (no auto-children)`);
        } else {
          lines.push(`- **${name}** → ${children.join(', ')}`);
        }
      }
    } else {
      lines.push('Not yet probed. Use "Probe All Presets" to discover child structures.');
    }

    lines.push('', '## Internal Element Types', '');
    // Extract unique wfType values from elements tree
    if (findings.elements && findings.elements.tree) {
      const types = new Set();
      function extractTypes(node) {
        if (node.wfType) types.add(node.wfType);
        if (node.kids) node.kids.forEach(extractTypes);
      }
      extractTypes(findings.elements.tree);
      if (types.size > 0) {
        for (const t of [...types].sort()) {
          lines.push(`- \`${t}\``);
        }
      } else {
        lines.push('No data-wf-type attributes found in DOM.');
      }
    } else {
      lines.push('Run Full Scan first.');
    }

    lines.push('', '## Deep Probe', '');
    if (findings.deepProbe) {
      lines.push('```json', formatJson(findings.deepProbe), '```');
    } else {
      lines.push('Not yet run. Click "Deep Probe" in the Globals tab first.');
    }

    lines.push('', '## WFDL Element Lab', '');
    if (findings.wfdlLab) {
      const valid = Object.entries(findings.wfdlLab).filter(([, v]) => v.isValid);
      const invalid = Object.entries(findings.wfdlLab).filter(([, v]) => !v.isValid);
      lines.push(`Tested ${Object.keys(findings.wfdlLab).length} WFDL snippets: ${valid.length} valid, ${invalid.length} invalid.`);
      lines.push('');
      if (valid.length > 0) {
        lines.push('### Valid WFDL');
        for (const [name, r] of valid) {
          lines.push(`- **${name}**: \`${r.wfdl}\``);
        }
      }
      if (invalid.length > 0) {
        lines.push('', '### Invalid WFDL');
        for (const [name, r] of invalid) {
          const errMsg = r.error?.message || r.error || 'unknown error';
          lines.push(`- **${name}**: \`${r.wfdl}\` — ${typeof errMsg === 'string' ? errMsg : formatJson(errMsg)}`);
        }
      }
    } else {
      lines.push('Not yet run. Click "WFDL Element Lab" in the Elements tab first.');
    }

    lines.push('', '## WFDL Export', '');
    if (findings.wfdlExport && findings.wfdlExport.data) {
      lines.push('Full export available via Download button. Summary:');
      const data = findings.wfdlExport.data;
      if (typeof data === 'object') {
        lines.push('```json', formatJson(Object.keys(data)), '```');
      }
    } else if (findings.wfdlExport && findings.wfdlExport.summary) {
      lines.push('```json', formatJson(findings.wfdlExport.summary), '```');
    } else {
      lines.push('Not yet run. Click "Export WFDL" in the Elements tab first.');
    }

    lines.push('', '## Gotchas', '', '<!-- Add observations here -->');

    return lines.join('\n');
  }

  // ── Full Scan ────────────────────────────────────────────────────

  $('#btn-full-scan').addEventListener('click', async () => {
    const btn = $('#btn-full-scan');
    btn.disabled = true;
    setExportStatus('Scanning globals...');
    try {
      findings.globals = await probeGlobals();
      setExportStatus('Finding React roots...');
      findings.react = await probeReact();
      setExportStatus('Dumping canvas DOM...');
      findings.elements = await probeElements();
      // Snapshot current messages
      findings.methods = messages.filter(m => m.method !== '(unknown)');
      setExportStatus(`Done — ${findings.globals?.length || 0} globals, ${findings.react?.length || 0} roots, ${findings.methods?.length || 0} methods. Use Copy/Download.`);
    } catch (err) {
      setExportStatus('Error: ' + err.message);
    }
    btn.disabled = false;
  });

  // ── Probe All Presets ────────────────────────────────────────────

  $('#btn-probe-presets').addEventListener('click', async () => {
    const btn = $('#btn-probe-presets');
    btn.disabled = true;
    findings.presets = {};

    // We need the extension to be open. We'll send createElementFromPreset
    // for a batch of presets and watch the message buffer for responses.
    // Each preset gets a tagged request ID so we can match responses.
    const total = KNOWN_PRESETS.length;
    let done = 0;

    for (const preset of KNOWN_PRESETS) {
      done++;
      setExportStatus(`Probing preset ${done}/${total}: ${preset}...`);

      const reqId = 'plinth-probe-' + preset + '-' + Date.now();
      try {
        // Clear the buffer, send the create request, wait, then drain
        await evalInPage(`
          (function() {
            window.__plinthInspectorBuffer.length = 0;
            window.postMessage({
              jsonrpc: '2.0',
              id: '${reqId}',
              method: 'createElementFromPreset',
              params: { preset: '${preset}' }
            }, '*');
          })()
        `);

        // Wait for response
        await new Promise(r => setTimeout(r, 300));

        // Drain buffer and look for response
        const captured = await evalInPage(`
          (function() {
            var buf = window.__plinthInspectorBuffer;
            var items = buf.splice(0, buf.length);
            return items;
          })()
        `);

        // Find the response that matches our request
        const response = captured.find(m =>
          m.data && (m.data.id === reqId || (m.data.result && m.dir === 'in'))
        );

        if (response && response.data && response.data.result) {
          // Try to extract child element types from the result
          const result = response.data.result;
          const children = [];
          function extractChildren(obj) {
            if (!obj || typeof obj !== 'object') return;
            if (obj.type) children.push(obj.type);
            if (obj.presetName) children.push(obj.presetName);
            if (obj.children && Array.isArray(obj.children)) {
              obj.children.forEach(extractChildren);
            }
            if (obj.nodes && Array.isArray(obj.nodes)) {
              obj.nodes.forEach(extractChildren);
            }
          }
          extractChildren(result);
          findings.presets[preset] = children;
        } else {
          // No structured response — record what we got
          const methodsSeen = captured
            .filter(m => m.method !== '(unknown)')
            .map(m => m.method);
          findings.presets[preset] = methodsSeen.length > 0 ? methodsSeen : [];
        }
      } catch {
        findings.presets[preset] = 'error';
      }
    }

    setExportStatus(`Preset probe complete — ${Object.keys(findings.presets).length} presets tested. Use Copy/Download.`);
    btn.disabled = false;
  });

  // ── Copy / Download ──────────────────────────────────────────────

  $('#btn-copy-findings').addEventListener('click', () => {
    const md = findingsToMarkdown();
    // DevTools panels can't use navigator.clipboard — use execCommand fallback
    const ta = document.createElement('textarea');
    ta.value = md;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      setExportStatus('Copied to clipboard!');
    } catch {
      setExportStatus('Copy failed — use Download instead.');
    }
    document.body.removeChild(ta);
  });

  $('#btn-download-findings').addEventListener('click', () => {
    const md = findingsToMarkdown();
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'findings.md';
    a.click();
    URL.revokeObjectURL(url);
    setExportStatus('Downloaded findings.md');
  });

})();
