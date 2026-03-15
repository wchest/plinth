'use strict';

const path = require('path');

/**
 * Wix platform init — collects Wix-specific credentials.
 *
 * Wix authentication uses API Keys (simpler) or OAuth (app-based).
 * For now we support API Keys which require:
 *   - An API key (created in Wix API Keys Manager)
 *   - A site ID (meta site ID from the Wix dashboard)
 */

async function collectCredentials(rl, args, ui) {
  console.log(`\n${ui.dim('Wix support is experimental. Editor automation is limited.')}\n`);

  const siteId = args.siteId || await ui.prompt(rl, 'Wix Site ID (meta site ID)', '');
  const name   = args.name   || await ui.prompt(rl, 'Site name (for display)', path.basename(process.cwd()));

  let apiKey = args.apiToken || process.env.WIX_API_KEY;
  if (!apiKey) {
    rl.close();
    apiKey = await ui.promptSecret('Wix API key');
  } else {
    console.log(`API key: ${ui.dim('(from argument/env)')}`);
  }

  if (!siteId) {
    console.error(ui.fail('Site ID is required.'));
    process.exit(1);
  }

  return { siteId, name, apiKey };
}

async function validateCredentials(config) {
  const { siteId, apiKey } = config;

  if (!apiKey) {
    return `${siteId} (no API key — bridge-only mode)`;
  }

  try {
    const res = await fetch('https://www.wixapis.com/site-properties/v4/properties', {
      headers: {
        'Authorization': apiKey,
        'wix-site-id': siteId,
      },
    });

    if (!res.ok) {
      if (res.status === 401) throw new Error('API key is invalid or missing permissions.');
      if (res.status === 404) throw new Error('Site not found. Check the site ID.');
      throw new Error(`Wix API returned ${res.status}`);
    }

    const data = await res.json();
    return data.properties?.siteDisplayName || siteId;
  } catch (e) {
    if (e.message.includes('fetch')) {
      throw new Error('Could not reach Wix API. Check your network connection.');
    }
    throw e;
  }
}

function nextSteps(config) {
  const c = {
    reset:  '\x1b[0m',
    dim:    '\x1b[2m',
    cyan:   '\x1b[36m',
    yellow: '\x1b[33m',
  };
  return [
    `1. Start the relay:         ${c.cyan}plinth dev${c.reset}`,
    `2. Open the Wix Editor`,
    `3. Start Claude Code:       ${c.cyan}claude${c.reset}`,
    '',
    `${c.yellow}Note: Wix editor automation is experimental.${c.reset}`,
    `${c.dim}The Wix editor does not expose public APIs for DOM manipulation.${c.reset}`,
    `${c.dim}Bridge support requires reverse-engineering the editor internals.${c.reset}`,
  ];
}

module.exports = { collectCredentials, validateCredentials, nextSteps };
