// Create the "Plinth" panel in Chrome DevTools
chrome.devtools.panels.create(
  'Plinth',          // title
  null,              // no icon
  'panel.html',      // panel page
  (panel) => {
    // Panel created — no additional setup needed.
    // panel.js handles everything once the panel HTML loads.
  }
);
