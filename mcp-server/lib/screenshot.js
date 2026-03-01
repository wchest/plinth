'use strict';

/**
 * screenshot.js
 *
 * Takes a screenshot of a Webflow page using puppeteer-core + system Chrome.
 * puppeteer-core is an optional peer dependency — if not installed, functions
 * throw a descriptive error with the install command.
 *
 * Usage:
 *   const { takeScreenshot } = require('./screenshot');
 *   const base64 = await takeScreenshot('https://my-site.webflow.io', {
 *     sectionClass: 'hero-section',   // screenshot just this element
 *     fullPage: true,                  // otherwise viewport only
 *   });
 */

const { execSync } = require('child_process');

// ── Browser detection ─────────────────────────────────────────────────────────

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
  '/usr/local/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try {
      execSync(`test -x "${p}"`, { stdio: 'pipe' });
      return p;
    } catch (_) {}
  }
  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Check whether screenshots are available on this machine.
 * Returns { available: true } or { available: false, reason: string, install: string }.
 */
function checkAvailability() {
  let puppeteer;
  try {
    puppeteer = require('puppeteer-core');
  } catch (_) {
    return {
      available: false,
      reason:    'puppeteer-core is not installed',
      install:   'cd /path/to/plinth/mcp-server && npm install puppeteer-core',
    };
  }

  const chromePath = findChrome();
  if (!chromePath) {
    return {
      available: false,
      reason:    'No Chrome or Chromium browser found on this machine',
      install:   'Install Google Chrome, or set the CHROME_PATH environment variable to your browser path',
    };
  }

  return { available: true, chromePath };
}

/**
 * Take a screenshot of a URL and return it as a base64 PNG string.
 *
 * @param {string} url                  Page URL to screenshot
 * @param {object} options
 * @param {string} [options.sectionClass] If set, screenshot just this CSS class element
 * @param {boolean} [options.fullPage]   Full-page screenshot (default: true if no sectionClass)
 * @param {number} [options.width]       Viewport width (default: 1280)
 * @param {number} [options.height]      Viewport height (default: 900)
 * @param {number} [options.waitMs]      Extra wait after load in ms (default: 1000)
 * @returns {Promise<string>}            base64-encoded PNG
 */
async function takeScreenshot(url, options = {}) {
  const availability = checkAvailability();
  if (!availability.available) {
    throw new Error(`${availability.reason}. ${availability.install}`);
  }

  const puppeteer = require('puppeteer-core');

  const browser = await puppeteer.launch({
    executablePath: availability.chromePath,
    headless:       'new',
    args:           ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({
      width:  options.width  ?? 1280,
      height: options.height ?? 900,
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45_000 });

    // Extra wait for fonts / lazy images to settle
    await new Promise((r) => setTimeout(r, options.waitMs ?? 1500));

    let screenshot;

    if (options.sectionClass) {
      // Try to screenshot just the named section element
      const selector = `.${options.sectionClass}`;
      try {
        await page.waitForSelector(selector, { timeout: 10_000 });
        const el = await page.$(selector);
        if (el) {
          screenshot = await el.screenshot({ type: 'png', encoding: 'base64' });
        }
      } catch (_) { /* fall through to full-page */ }
    }

    if (!screenshot) {
      screenshot = await page.screenshot({
        type:     'png',
        encoding: 'base64',
        fullPage: options.fullPage ?? (options.sectionClass == null),
      });
    }

    return screenshot;
  } finally {
    await browser.close();
  }
}

module.exports = { takeScreenshot, checkAvailability, findChrome };
