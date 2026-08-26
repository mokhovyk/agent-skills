'use strict';

// Cursor loader (experimental).
//
// Cursor's "Composer" / Agent transcripts are stored in a SQLite database at
// ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb on
// macOS (the equivalent paths on Linux are under ~/.config/Cursor/User/).
// Inside the database, the `cursorDiskKV` table holds rows keyed by:
//   composerData:<composerId>          → conversation metadata
//   bubbleId:<composerId>:<bubbleId>   → individual messages ("bubbles")
//   messageRequestContext:<…>          → per-request attached context
//   codeBlockDiff:<…>                  → applied/suggested code edits
//   inlineDiff:<…>                     → inline diffs
// Each value is a JSON blob. The schema is unstable across Cursor releases;
// this loader follows a best-effort path and falls back to zeros where the
// data isn't available (notably token usage, which Cursor does not expose
// in the local store).
//
// The loader shells out to the `sqlite3` CLI in read-only mode. Cursor must
// not be writing concurrently to the file; if it is, the query may fail.
// `--session <composerId>` selects a specific composer; otherwise the
// most-recently-active composer is used.
//
// Alternative input: a JSON file exported from Cursor (or a JSONL with the
// shape `{ bubbles: [...] }`) is accepted directly and bypasses the SQLite
// query path.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const shared = require('./_shared');

const NAME = 'cursor';

function defaultDbPaths() {
  const home = os.homedir();
  return [
    path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
    path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
    path.join(home, 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  ];
}

function defaultDb() {
  return defaultDbPaths().find((p) => fs.existsSync(p)) || null;
}

function detect({ filePath, sampleRecords }) {
  if (filePath && (filePath.endsWith('.vscdb') || /[/\\]Cursor[/\\]/.test(filePath))) return true;
  if (Array.isArray(sampleRecords)) {
    for (const r of sampleRecords) {
      if (!r || typeof r !== 'object') continue;
      if (r.bubbleId || r.composerId || (Array.isArray(r.bubbles) && r.bubbles.length)) return true;
    }
  }
  return false;
}

function runSqlite(db, sql) {
  const res = spawnSync('sqlite3', ['-readonly', '-json', db, sql], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.error) throw new Error(`sqlite3 unavailable: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`sqlite3 failed: ${res.stderr || res.stdout || `exit ${res.status}`}`);
  if (!res.stdout.trim()) return [];
  try { return JSON.parse(res.stdout); }
  catch (e) { throw new Error(`sqlite3 returned non-JSON: ${e.message}`); }
}

function listComposers(db) {
  const rows = runSqlite(db, `SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%';`);
  return rows.map((row) => {
    let parsed = {};
    try { parsed = JSON.parse(row.value); } catch (_e) { /* leave empty */ }
    return {
      composerId: parsed.composerId || row.key.split(':')[1] || null,
      data: parsed,
    };
  });
}

function pickComposer(db, sessionId) {
  const composers = listComposers(db);
  if (sessionId) {
    const hit = composers.find((c) => c.composerId === sessionId);
    if (!hit) throw new Error(`composer not found: ${sessionId}`);
    return hit;
  }
  // Pick the composer with the most bubbles or the latest update timestamp.
  // The `lastUpdatedAt` / `lastSubmittedAt` fields aren't always present, so
  // we fall back to bubble count.
  let best = null;
  let bestScore = -Infinity;
  for (const c of composers) {
    const d = c.data || {};
    const ts = d.lastUpdatedAt || d.lastSubmittedAt || d.createdAt || 0;
    const score = Number(ts) || (Array.isArray(d.fullConversationHeadersOnly) ? d.fullConversationHeadersOnly.length : 0);
    if (score > bestScore) { bestScore = score; best = c; }
  }
  if (!best) throw new Error('no composers found in Cursor state.vscdb');
  return best;
}

function loadBubbles(db, composerId) {
  const rows = runSqlite(db, `SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:${composerId}:%';`);
  const bubbles = [];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.value);
      bubbles.push(parsed);
    } catch (_e) { /* skip */ }
  }
  return bubbles;
}

function bubbleOrder(bubble, headers) {
  const id = bubble.bubbleId || bubble.id;
  if (!id || !Array.isArray(headers)) return 0;
  const idx = headers.findIndex((h) => h && (h.bubbleId === id || h.id === id));
  return idx >= 0 ? idx : 0;
}

function classifyBubble(bubble) {
  // Cursor uses `type` to discriminate user/assistant. The exact integer
  // mapping has changed across versions; we read whichever signal is present.
  if (bubble.type === 1 || bubble.role === 'user' || bubble.isUser) return 'user';
  if (bubble.type === 2 || bubble.role === 'assistant') return 'assistant';
  // Fall back: presence of `toolResults` / `suggestedCodeBlocks` → assistant.
  if (Array.isArray(bubble.toolResults) && bubble.toolResults.length) return 'assistant';
  if (Array.isArray(bubble.suggestedCodeBlocks) && bubble.suggestedCodeBlocks.length) return 'assistant';
  return 'user';
}

function bubbleText(bubble) {
  if (typeof bubble.text === 'string' && bubble.text) return bubble.text;
  if (typeof bubble.content === 'string' && bubble.content) return bubble.content;
  if (Array.isArray(bubble.content)) {
    return bubble.content
      .map((c) => (typeof c === 'string' ? c : (c && typeof c.text === 'string' ? c.text : '')))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof bubble.richText === 'string') return bubble.richText;
  return '';
}

function bubbleToolUses(bubble) {
  const out = [];
  if (Array.isArray(bubble.toolResults)) {
    for (let i = 0; i < bubble.toolResults.length; i++) {
      const tr = bubble.toolResults[i] || {};
      const rawName = tr.toolName || tr.name || tr.tool || 'Tool';
      out.push({
        toolUseId: tr.id || `${bubble.bubbleId}-tool-${i}`,
        name: normalizeToolName(rawName),
        input: tr.input || tr.args || {},
        rawResult: tr.result ?? tr.output ?? null,
        rawError: tr.error || null,
      });
    }
  }
  if (Array.isArray(bubble.suggestedCodeBlocks)) {
    for (let i = 0; i < bubble.suggestedCodeBlocks.length; i++) {
      const block = bubble.suggestedCodeBlocks[i] || {};
      const filePath = block.uri || block.relativeWorkspacePath || block.path || null;
      out.push({
        toolUseId: `${bubble.bubbleId}-edit-${i}`,
        name: block.isNewFile ? 'Write' : 'Edit',
        input: filePath ? { file_path: filePath } : {},
        rawResult: null,
        rawError: null,
      });
    }
  }
  return out;
}

function normalizeToolName(rawName) {
  const n = String(rawName || '').toLowerCase();
  if (/(^|\b)(read_file|read|view)\b/.test(n)) return 'Read';
  if (/(^|\b)(edit|edit_file|apply|search_replace)\b/.test(n)) return 'Edit';
  if (/(^|\b)(create_file|write|write_file)\b/.test(n)) return 'Write';
  if (/(^|\b)(terminal|bash|run|exec|shell)\b/.test(n)) return 'Bash';
  if (/(^|\b)(grep|grep_search|codebase_search)\b/.test(n)) return 'Grep';
  if (/(^|\b)(glob|file_search|list_dir|ls)\b/.test(n)) return 'Glob';
  return rawName || 'Tool';
}

function resolveDefault({ sessionId, filePath }) {
  if (filePath) {
    if (!fs.existsSync(filePath)) throw new Error(`cursor input not found: ${filePath}`);
    return { path: filePath, multipleRecent: false };
  }
  const db = defaultDb();
  if (!db) throw new Error('cursor state.vscdb not found; pass --transcript <db-or-json>');
  return { path: db, multipleRecent: false };
}

function load(filePath, opts = {}) {
  if (!fs.existsSync(filePath)) throw new Error(`transcript not found: ${filePath}`);

  let bubbles = [];
  let composerId = opts.sessionId || null;
  let composerCwd = opts.cwd || null;

  if (filePath.endsWith('.vscdb')) {
    const composer = pickComposer(filePath, opts.sessionId);
    composerId = composer.composerId;
    composerCwd = composer.data?.workspaceFolder || composer.data?.cwd || null;
    bubbles = loadBubbles(filePath, composerId);
    const headers = composer.data?.fullConversationHeadersOnly;
    if (Array.isArray(headers) && headers.length) {
      bubbles.sort((a, b) => bubbleOrder(a, headers) - bubbleOrder(b, headers));
    }
  } else {
    // JSON / JSONL fallback: accept either a single object with `bubbles`,
    // or a JSONL file where each line is one bubble.
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (raw.startsWith('{')) {
      try {
        const parsed = JSON.parse(raw);
        bubbles = Array.isArray(parsed.bubbles) ? parsed.bubbles : [];
        composerId = composerId || parsed.composerId || null;
        composerCwd = composerCwd || parsed.workspaceFolder || parsed.cwd || null;
      } catch (e) {
        throw new Error(`cannot parse cursor JSON: ${e.message}`);
      }
    } else {
      bubbles = shared.readJSONL(raw);
    }
  }

  const assistantTurns = [];
  const toolResults = new Map();
  let primaryIdx = 0;

  function newTurn(ts) {
    primaryIdx += 1;
    const turn = shared.newAssistantTurn({
      index: primaryIdx,
      uuid: `cursor-turn-${primaryIdx}`,
      parentUuid: null,
      isSidechain: false,
      timestamp: ts,
      model: null,
      usage: shared.emptyUsage(),
    });
    assistantTurns.push(turn);
    return turn;
  }

  let firstTs = null;
  let lastTs = null;
  for (const bubble of bubbles) {
    const ts = bubble.timestamp || bubble.createdAt || null;
    if (ts) {
      if (!firstTs) firstTs = ts;
      lastTs = ts;
    }
    if (classifyBubble(bubble) === 'user') continue;
    // Each assistant bubble represents one model invocation, so emit one
    // primary turn per bubble. Tool results are inlined in the same bubble.
    const turn = newTurn(ts);
    const text = bubbleText(bubble);
    if (text) turn.texts.push(text);
    for (const tu of bubbleToolUses(bubble)) {
      turn.toolUses.push({ toolUseId: tu.toolUseId, name: tu.name, input: tu.input });
      const resultText = tu.rawResult == null ? '' : (typeof tu.rawResult === 'string' ? tu.rawResult : JSON.stringify(tu.rawResult));
      toolResults.set(tu.toolUseId, shared.newToolResult({
        content: resultText,
        isError: !!tu.rawError,
        timestamp: ts,
      }));
    }
  }

  const primaryTurns = assistantTurns;
  const totals = shared.computeTotals(primaryTurns);

  return {
    tool: NAME,
    cwd: composerCwd,
    sessionId: composerId,
    records: bubbles,
    primaryTurns,
    sidechainTurns: [],
    sidechainBlocks: [],
    toolResults,
    totals,
    startTime: firstTs,
    endTime: lastTs,
    compactionFlag: false,
    multipleRecent: !!opts.multipleRecent,
    // Cursor doesn't surface per-turn token counts in the local store.
    usageUnavailable: true,
  };
}

module.exports = {
  NAME,
  defaultDb,
  defaultDbPaths,
  resolveDefault,
  detect,
  load,
  normalizeToolName,
};
