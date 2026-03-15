'use strict';
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '..', 'results.jsonl');

function appendRound(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  fs.appendFileSync(LOG_FILE, line, 'utf8');
}

function readAll() {
  if (!fs.existsSync(LOG_FILE)) return [];
  return fs.readFileSync(LOG_FILE, 'utf8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

module.exports = { appendRound, readAll };
