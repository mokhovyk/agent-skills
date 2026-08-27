'use strict';

// Dispatcher for the per-tool transcript loaders. Exposes a small surface:
//
//   resolveAndLoad({ tool, path, sessionId, cutoffUuid, cwd })  → session
//   loaders.<name>                                              → individual loader
//
// The normalized session shape every loader produces:
//
//   {
//     tool: 'claude' | 'codex' | 'cursor',
//     cwd:        string | null,
//     sessionId:  string | null,
//     startTime:  ISO-8601 | null,
//     endTime:    ISO-8601 | null,
//     primaryTurns:    [ { index, uuid, parentUuid, isSidechain, timestamp,
//                          model, usage:{input,cache_creation,cache_read,output},
//                          toolUses:[{toolUseId, name, input}], texts:[...] } ],
//     sidechainTurns:  [...],
//     sidechainBlocks: [ { turns:[...], consumed, lastText } ],
//     toolResults:     Map<toolUseId, { content, stdout, stderr, isError,
//                          sizeChars, sizeTokens, timestamp }>,
//     totals:          { input, cache_creation, cache_read, output, paid, cache_hit_rate },
//     compactionFlag:  bool,
//     multipleRecent:  bool,
//     records:         loader-private,
//     usageUnavailable?: bool,
//   }

const fs = require('node:fs');
const claude = require('./claude');
const codex = require('./codex');
const cursor = require('./cursor');
const shared = require('./_shared');

const LOADERS = { [claude.NAME]: claude, [codex.NAME]: codex, [cursor.NAME]: cursor };

function detectFromEnv() {
  if (process.env.CLAUDE_SESSION_ID) return claude.NAME;
  if (process.env.CODEX_SESSION_ID) return codex.NAME;
  if (process.env.CURSOR_COMPOSER_ID || process.env.CURSOR_SESSION_ID) return cursor.NAME;
  return null;
}

function detectFromPath(filePath) {
  if (!filePath) return null;
  for (const loader of Object.values(LOADERS)) {
    if (loader.detect({ filePath })) return loader.NAME;
  }
  return null;
}

function detectFromContent(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    if (filePath.endsWith('.vscdb')) return cursor.NAME;
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(8192);
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const head = buf.slice(0, bytes).toString('utf8');
    const lines = head.split('\n').slice(0, 5).filter(Boolean);
    const samples = lines.map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } });
    // If line-by-line parsing failed and the file looks like one JSON object
    // (e.g. a Cursor export), try the whole-file shape against each loader.
    if (samples.every((s) => s == null) && head.trim().startsWith('{')) {
      try {
        const whole = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        samples[0] = whole;
      } catch (_e) { /* not a single JSON object */ }
    }
    for (const loader of Object.values(LOADERS)) {
      if (loader.detect({ filePath, sampleRecords: samples })) return loader.NAME;
    }
  } catch (_e) { /* fall through */ }
  return null;
}

function detectFromFreshness({ cwd }) {
  // Return whichever tool has the most-recently-modified transcript that
  // looks like it belongs to the current cwd. Each loader handles "what does
  // the current cwd mean for me?" internally.
  const candidates = [];
  try {
    const r = claude.resolveDefault({ cwd });
    candidates.push({ tool: claude.NAME, mtime: fs.statSync(r.path).mtimeMs });
  } catch (_e) { /* no claude transcript */ }
  try {
    const r = codex.resolveDefault({});
    candidates.push({ tool: codex.NAME, mtime: fs.statSync(r.path).mtimeMs });
  } catch (_e) { /* no codex transcript */ }
  if (cursor.defaultDb()) candidates.push({ tool: cursor.NAME, mtime: fs.statSync(cursor.defaultDb()).mtimeMs });
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.tool || null;
}

function pickTool({ tool, filePath, cwd }) {
  if (tool) {
    if (!LOADERS[tool]) throw new Error(`unknown tool: ${tool}`);
    return tool;
  }
  if (filePath) {
    return detectFromPath(filePath) || detectFromContent(filePath) || claude.NAME;
  }
  const fromEnv = detectFromEnv();
  if (fromEnv) return fromEnv;
  const fromFreshness = detectFromFreshness({ cwd });
  if (fromFreshness) return fromFreshness;
  return claude.NAME;
}

function resolveAndLoad({ tool, filePath, sessionId, cutoffUuid, cwd }) {
  const picked = pickTool({ tool, filePath, cwd });
  const loader = LOADERS[picked];
  let resolved;
  if (filePath) resolved = { path: filePath, multipleRecent: false };
  else resolved = loader.resolveDefault({ cwd, sessionId, filePath });
  const session = loader.load(resolved.path, {
    cwd,
    sessionId,
    cutoffUuid,
    multipleRecent: resolved.multipleRecent,
  });
  return { session, loader: picked, transcriptPath: resolved.path };
}

module.exports = {
  LOADERS,
  loaderNames: Object.keys(LOADERS),
  pickTool,
  resolveAndLoad,
  shared,
};
