'use strict';

const fs   = require('fs');
const path = require('path');

const LOG_FILE = path.join(require('os').tmpdir(), 'plinth.log');
const stream   = fs.createWriteStream(LOG_FILE, { flags: 'a' });

function ts() {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

function strip(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Create a logger with a prefix tag (e.g. 'relay', 'mcp', 'bridge').
 *
 *   const log = require('./lib/logger')('relay');
 *   log.info('listening on :3847');   // [12:34:56.789] relay  listening on :3847
 *   log.warn('slow response');
 *   log.error('connection refused');
 *
 * All levels write to /tmp/plinth.log.
 * info/warn also write to stderr (safe for MCP — stdout is reserved).
 * error always writes to stderr.
 */
function createLogger(tag) {
  const pad = tag.padEnd(6);

  function write(level, args) {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    const line = `[${ts()}] ${pad} ${strip(msg)}`;
    stream.write(line + '\n');
    // Also emit to stderr (never stdout — MCP uses stdout for JSON-RPC)
    if (level !== 'debug') {
      process.stderr.write(`[${tag}] ${msg}\n`);
    }
  }

  return {
    info:  (...a) => write('info',  a),
    warn:  (...a) => write('warn',  a),
    error: (...a) => write('error', a),
    debug: (...a) => write('debug', a),  // file only, no stderr
    file: LOG_FILE,
  };
}

module.exports = createLogger;
