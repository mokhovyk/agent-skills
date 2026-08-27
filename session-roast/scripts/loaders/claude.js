'use strict';

// Claude Code loader.
//
// Transcripts live at ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl as
// JSONL, one record per line. Records carry a `type` of "assistant" | "user" |
// "system"; the assistant records expose `message.usage` with Anthropic's
// {input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
// output_tokens} shape, plus `isSidechain` for subagent runs.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const shared = require('./_shared');

const NAME = 'claude';

// Strict trigger — the slash-command tag form, which is how /session-roast
// actually lands in transcripts.
const SLASH_TRIGGER_RE = /<command-name>\/session-roast<\/command-name>/i;
// Soft trigger — accepted only when it appears at the very start of a short
// user message (i.e., looks like a deliberate invocation, not a thread).
const PLAIN_TRIGGER_RE = /^\s*(?:\/session-roast\b|roast my session|grade my session|how did i do|was that efficient)/i;
const PLAIN_TRIGGER_MAX_LEN = 120;

function encodeCwd(cwd) {
  return cwd.replace(/\//g, '-');
}

function defaultDir(cwd) {
  return path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwd));
}

function pathForSession(cwd, sessionId) {
  return path.join(defaultDir(cwd), `${sessionId}.jsonl`);
}

function newestJsonl(dir) {
  if (!fs.existsSync(dir)) return null;
  const candidates = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const full = path.join(dir, f);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0] || null;
}

function multipleRecentNear(dir, newest) {
  if (!fs.existsSync(dir) || !newest) return false;
  const all = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  return all.some((f) => {
    if (f === path.basename(newest.full)) return false;
    const m = fs.statSync(path.join(dir, f)).mtimeMs;
    return Math.abs(newest.mtime - m) < 10 * 60 * 1000;
  });
}

function resolveDefault({ cwd, sessionId }) {
  const dir = defaultDir(cwd);
  if (sessionId) {
    const p = pathForSession(cwd, sessionId);
    if (!fs.existsSync(p)) throw new Error(`session not found: ${p}`);
    return { path: p, multipleRecent: false };
  }
  const newest = newestJsonl(dir);
  if (!newest) throw new Error(`no .jsonl found in ${dir}`);
  return { path: newest.full, multipleRecent: multipleRecentNear(dir, newest) };
}

// Detect whether a transcript file (path or sample records) looks like a
// Claude Code session. Used by the multi-tool dispatcher to auto-classify.
function detect({ filePath, sampleRecords }) {
  if (filePath && filePath.includes(`${path.sep}.claude${path.sep}projects${path.sep}`)) return true;
  if (Array.isArray(sampleRecords)) {
    for (const r of sampleRecords) {
      if (!r || typeof r !== 'object') continue;
      if (r.type === 'assistant' && r.message && r.message.usage && 'cache_creation_input_tokens' in r.message.usage) return true;
      if (r.parentUuid !== undefined && r.uuid !== undefined && r.type) return true;
    }
  }
  return false;
}

function trimAtSelfReference(records, cutoffUuid) {
  const candidates = records.filter((r) => r && (r.type === 'assistant' || r.type === 'user' || r.type === 'system'));
  let cutIndex = candidates.length;
  if (cutoffUuid) {
    const idx = candidates.findIndex((r) => r.uuid === cutoffUuid);
    if (idx >= 0) cutIndex = idx;
  } else {
    for (let i = candidates.length - 1; i >= 0; i--) {
      const r = candidates[i];
      if (r.type !== 'user') continue;
      const content = r.message?.content;
      if (typeof content !== 'string') continue;
      if (r.isMeta) continue;
      if (SLASH_TRIGGER_RE.test(content)) { cutIndex = i; break; }
      if (content.length <= PLAIN_TRIGGER_MAX_LEN && PLAIN_TRIGGER_RE.test(content)) { cutIndex = i; break; }
    }
  }
  return { live: candidates.slice(0, cutIndex), allCandidates: candidates };
}

function detectCompaction(records) {
  // Compaction = a parent that points outside the file entirely, or an
  // explicit system summary record. Trimming the self-invocation never
  // looks like compaction because we evaluate against the FULL set of uuids.
  const allUuids = new Set();
  for (const r of records) if (r && r.uuid) allUuids.add(r.uuid);
  let danglingParents = 0;
  for (const r of records) {
    if (!r || !r.parentUuid) continue;
    if (!allUuids.has(r.parentUuid)) danglingParents += 1;
  }
  const hasSummaryRecord = records.some((r) => r && (r.type === 'summary' || r?.message?.role === 'summary'));
  return danglingParents > 1 || hasSummaryRecord;
}

function collectToolResults(live) {
  const toolResults = new Map();
  for (const r of live) {
    if (r.type !== 'user') continue;
    const content = r.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (!c || c.type !== 'tool_result') continue;
      const tur = r.toolUseResult;
      const rawText = shared.asString(c.content);
      let stdout = '';
      let stderr = '';
      if (tur && typeof tur === 'object') {
        if (typeof tur.stdout === 'string') stdout = tur.stdout;
        if (typeof tur.stderr === 'string') stderr = tur.stderr;
      }
      const result = shared.newToolResult({
        content: rawText || `${stdout}${stderr}`,
        stdout, stderr,
        isError: !!c.is_error,
        timestamp: r.timestamp,
      });
      // Preserve toolUseResult for any future inspection.
      result.toolUseResult = tur || null;
      toolResults.set(c.tool_use_id, result);
    }
  }
  return toolResults;
}

function buildAssistantTurns(live) {
  const assistantTurns = [];
  let primaryIdx = 0;
  for (const r of live) {
    if (r.type !== 'assistant') continue;
    const usage = r.message?.usage || {};
    const blocks = Array.isArray(r.message?.content) ? r.message.content : [];
    if (!r.isSidechain) primaryIdx += 1;
    const turn = shared.newAssistantTurn({
      index: primaryIdx,
      uuid: r.uuid,
      parentUuid: r.parentUuid,
      isSidechain: !!r.isSidechain,
      timestamp: r.timestamp,
      model: r.message?.model || null,
      usage: {
        input: usage.input_tokens || 0,
        cache_creation: usage.cache_creation_input_tokens || 0,
        cache_read: usage.cache_read_input_tokens || 0,
        output: usage.output_tokens || 0,
      },
    });
    turn.toolUses = blocks.filter((b) => b?.type === 'tool_use').map((b) => ({
      toolUseId: b.id,
      name: b.name,
      input: b.input || {},
    }));
    turn.texts = blocks.filter((b) => b?.type === 'text').map((b) => b.text || '');
    assistantTurns.push(turn);
  }
  return assistantTurns;
}

function load(filePath, opts = {}) {
  if (!fs.existsSync(filePath)) throw new Error(`transcript not found: ${filePath}`);
  const text = fs.readFileSync(filePath, 'utf8');
  const records = shared.readJSONL(text);

  const { live } = trimAtSelfReference(records, opts.cutoffUuid);
  const compactionFlag = detectCompaction(records);

  const toolResults = collectToolResults(live);
  const assistantTurns = buildAssistantTurns(live);
  const primaryTurns = assistantTurns.filter((t) => !t.isSidechain);
  const sidechainTurns = assistantTurns.filter((t) => t.isSidechain);
  const sidechainBlocks = shared.buildSidechainBlocks(assistantTurns);
  const totals = shared.computeTotals(primaryTurns);

  const timestamps = live.map((r) => r.timestamp).filter(Boolean).sort();
  return {
    tool: NAME,
    cwd: opts.cwd || null,
    sessionId: opts.sessionId || null,
    records: live,
    primaryTurns,
    sidechainTurns,
    sidechainBlocks,
    toolResults,
    totals,
    startTime: timestamps[0] || null,
    endTime: timestamps[timestamps.length - 1] || null,
    compactionFlag,
    multipleRecent: !!opts.multipleRecent,
  };
}

module.exports = {
  NAME,
  encodeCwd,
  defaultDir,
  pathForSession,
  resolveDefault,
  detect,
  load,
};
