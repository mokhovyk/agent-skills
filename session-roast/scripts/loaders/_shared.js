'use strict';

// Shared helpers used by every per-tool loader. The normalized session shape
// produced by each loader is documented in ./index.js.

const crypto = require('node:crypto');
const path = require('node:path');

const CHARS_PER_TOKEN = 4;

function tokensFromChars(chars) {
  return Math.max(0, Math.round((chars || 0) / CHARS_PER_TOKEN));
}

function tokensFromText(text) {
  return tokensFromChars(typeof text === 'string' ? text.length : 0);
}

function asString(x) {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  if (Array.isArray(x)) return x.map(asString).join('\n');
  if (typeof x === 'object') {
    if (typeof x.text === 'string') return x.text;
    if (typeof x.content === 'string') return x.content;
    return JSON.stringify(x);
  }
  return String(x);
}

function sha1Short(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 6);
}

function anonPath(p) {
  if (!p) return p;
  const ext = path.extname(p);
  return `path/${sha1Short(p)}${ext}`;
}

function basename(p) {
  if (!p) return p;
  return path.basename(p);
}

function anonBash(cmd) {
  if (!cmd) return cmd;
  const trimmed = cmd.trim();
  const m = trimmed.match(/^([A-Za-z0-9_/.\-]+)/);
  const bin = m ? path.basename(m[1]) : trimmed.slice(0, 12);
  return `${bin} <args>`;
}

function canonicalize(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(canonicalize);
  const out = {};
  for (const key of Object.keys(v).sort()) out[key] = canonicalize(v[key]);
  return out;
}

function stableHash(value) {
  return crypto.createHash('sha1').update(JSON.stringify(canonicalize(value))).digest('hex').slice(0, 12);
}

function readJSONL(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_e) { /* tolerate truncated tail */ }
  }
  return out;
}

function computeTotals(primaryTurns) {
  const totals = { input: 0, cache_creation: 0, cache_read: 0, output: 0 };
  for (const t of primaryTurns) {
    totals.input += t.usage.input;
    totals.cache_creation += t.usage.cache_creation;
    totals.cache_read += t.usage.cache_read;
    totals.output += t.usage.output;
  }
  totals.paid = totals.output + totals.cache_creation;
  const denom = totals.input + totals.cache_creation + totals.cache_read;
  totals.cache_hit_rate = denom > 0 ? totals.cache_read / denom : 0;
  return totals;
}

function buildSidechainBlocks(assistantTurns) {
  const blocks = [];
  let block = null;
  for (const t of assistantTurns) {
    if (t.isSidechain) {
      if (!block) block = { turns: [], consumed: 0, lastText: '' };
      block.turns.push(t);
      block.consumed += t.usage.input + t.usage.cache_creation + t.usage.output;
      if (t.texts.length) block.lastText = t.texts.join('\n');
    } else if (block) {
      blocks.push(block);
      block = null;
    }
  }
  if (block) blocks.push(block);
  return blocks;
}

function emptyUsage() {
  return { input: 0, cache_creation: 0, cache_read: 0, output: 0 };
}

function newAssistantTurn({ uuid, parentUuid, isSidechain, timestamp, model, usage, index }) {
  return {
    index: isSidechain ? null : index,
    uuid,
    parentUuid: parentUuid || null,
    isSidechain: !!isSidechain,
    timestamp: timestamp || null,
    model: model || null,
    usage: usage || emptyUsage(),
    toolUses: [],
    texts: [],
  };
}

function newToolResult({ content, stdout, stderr, isError, timestamp }) {
  const text = asString(content);
  const chars = (text.length || ((stdout || '').length + (stderr || '').length));
  return {
    content: text,
    stdout: stdout || '',
    stderr: stderr || '',
    isError: !!isError,
    sizeChars: chars,
    sizeTokens: tokensFromChars(chars),
    timestamp: timestamp || null,
  };
}

module.exports = {
  CHARS_PER_TOKEN,
  tokensFromChars,
  tokensFromText,
  asString,
  sha1Short,
  anonPath,
  basename,
  anonBash,
  canonicalize,
  stableHash,
  readJSONL,
  computeTotals,
  buildSidechainBlocks,
  emptyUsage,
  newAssistantTurn,
  newToolResult,
};
