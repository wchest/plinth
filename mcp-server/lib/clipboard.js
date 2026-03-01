'use strict';

const { execSync } = require('child_process');

/**
 * Write text to the system clipboard with a given MIME type.
 *
 * Tries, in order:
 *   1. wl-copy  (Wayland / Linux)
 *   2. xclip    (X11 / Linux)
 *   3. pbcopy   (macOS — text/plain only)
 *
 * Returns { method } on success; throws on failure.
 */
function writeToClipboard(text, mimeType = 'text/plain') {
  const buf = Buffer.from(text, 'utf8');
  const opts = { input: buf, stdio: ['pipe', 'ignore', 'ignore'] };

  // Wayland
  try {
    execSync(`wl-copy --type ${JSON.stringify(mimeType)}`, opts);
    return { method: 'wl-copy' };
  } catch (_) {}

  // X11 — xclip
  try {
    execSync(`xclip -selection clipboard -t ${JSON.stringify(mimeType)}`, opts);
    return { method: 'xclip' };
  } catch (_) {}

  // macOS — pbcopy (text/plain only, but Webflow should still accept it)
  try {
    execSync('pbcopy', opts);
    return { method: 'pbcopy' };
  } catch (_) {}

  throw new Error(
    'No clipboard tool available. ' +
    'Install wl-clipboard (Wayland), xclip (X11), or run on macOS.',
  );
}

module.exports = { writeToClipboard };
