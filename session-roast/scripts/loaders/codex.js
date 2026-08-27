'use strict';

// Codex CLI loader.
//
// Transcripts live at ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl.
// Each line is one rollout record:
//   { record_type: "session_meta", payload: { id, cwd, originator, ... } }
//   { record_type: "response_item", payload: { type: "message"|"function_call"|"function_call_output"|"reasoning", ... } }
//   { record_type: "event_msg", payload: { type: "token_count", info: { total_token_usage: {...}, last_token_usage: {...} } } }
// Older rollouts wrote `type` at the top level instead of `record_type` —
// this loader tolerates both shapes.
//
// Tool-name normalization: Codex routes most actions through the `shell`
// function, so the loader inspects the command string to classify it as
// Read / Grep / Glob / Bash. `apply_patch` invocations are split into
// per-file Edit/Write tool uses.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const shared = require('./_shared');

const NAME = 'codex';

const READ_BIN_RE = /^(?:cat|less|more|bat|view)\b/;
const HEAD_TAIL_RE = /^(?:head|tail)\b/;
const GREP_BIN_RE = /^(?:rg|grep|ag|ack)\b/;
const GLOB_BIN_RE = /^(?:find|fd|ls)\b/;

function defaultDir() {
  return path.join(os.homedir(), '.codex', 'sessions');
}

function walkJsonl(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_e) { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && full.endsWith('.jsonl')) out.push(full);
    }
  }
  return out;
}

function newestRollout(root) {
  const files = walkJsonl(root);
  if (!files.length) return null;
  const stamped = files.map((f) => ({ full: f, mtime: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return stamped[0];
}

function findBySessionId(root, sessionId) {
  const files = walkJsonl(root);
  return files.find((f) => path.basename(f).includes(sessionId)) || null;
}

function resolveDefault({ sessionId }) {
  const root = defaultDir();
  if (sessionId) {
    const p = findBySessionId(root, sessionId);
    if (!p) throw new Error(`session not found under ${root}: ${sessionId}`);
    return { path: p, multipleRecent: false };
  }
  const newest = newestRollout(root);
  if (!newest) throw new Error(`no .jsonl found under ${root}`);
  const all = walkJsonl(root).filter((f) => f !== newest.full);
  const multipleRecent = all.some((f) => Math.abs(fs.statSync(f).mtimeMs - newest.mtime) < 10 * 60 * 1000);
  return { path: newest.full, multipleRecent };
}

function detect({ filePath, sampleRecords }) {
  if (filePath && filePath.includes(`${path.sep}.codex${path.sep}sessions${path.sep}`)) return true;
  if (filePath && /rollout-/.test(path.basename(filePath || ''))) return true;
  if (Array.isArray(sampleRecords)) {
    for (const r of sampleRecords) {
      if (!r || typeof r !== 'object') continue;
      if (r.record_type === 'session_meta' || r.record_type === 'event_msg' || r.record_type === 'response_item') return true;
      if (r.type === 'function_call' || r.type === 'function_call_output' || r.type === 'session_meta') return true;
    }
  }
  return false;
}

// Unwrap a record into its semantic shape. Codex rollouts have evolved twice:
//   v1 (current): { record_type, payload }
//   v0 (legacy):  { type, ... } at the top level
function unwrapRecord(record) {
  if (!record || typeof record !== 'object') return null;
  if (typeof record.record_type === 'string') {
    return { kind: record.record_type, payload: record.payload || record, timestamp: record.timestamp || null };
  }
  if (typeof record.type === 'string') {
    if (record.type === 'session_meta') return { kind: 'session_meta', payload: record, timestamp: record.timestamp || null };
    if (record.type === 'event_msg') return { kind: 'event_msg', payload: record.payload || record, timestamp: record.timestamp || null };
    return { kind: 'response_item', payload: record, timestamp: record.timestamp || null };
  }
  return null;
}

function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (!c) return '';
        if (typeof c === 'string') return c;
        if (typeof c.text === 'string') return c.text;
        if (typeof c.value === 'string') return c.value;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function classifyShell(cmd) {
  const trimmed = String(cmd || '').trim();
  if (!trimmed) return { name: 'Bash', input: { command: trimmed } };
  // Codex shell call may arrive as a JSON array of argv tokens.
  if (trimmed.startsWith('[')) {
    try {
      const argv = JSON.parse(trimmed);
      if (Array.isArray(argv)) {
        return classifyShell(argv.join(' '));
      }
    } catch (_e) { /* fall through */ }
  }
  // Strip shell prefix wrappers `bash -lc '...'` / `bash -c "..."`.
  const wrapped = trimmed.match(/^(?:bash|sh|zsh)\s+-l?c\s+(['"])([\s\S]*)\1\s*$/);
  const inner = wrapped ? wrapped[2] : trimmed;

  // Take the first piped segment for classification purposes; we still
  // pass the whole command through as `input.command`.
  const firstSeg = inner.split(/[|;&]/, 1)[0].trim();

  if (READ_BIN_RE.test(firstSeg)) {
    const tokens = firstSeg.split(/\s+/).slice(1).filter((t) => !t.startsWith('-'));
    const filePath = tokens[0] || null;
    return { name: 'Read', input: { file_path: filePath, command: inner } };
  }
  if (HEAD_TAIL_RE.test(firstSeg)) {
    // head/tail are a bounded read of a file — treat as Read with bounds
    // (offset/limit unknown) which keeps D1 from flagging chunked progression.
    const tokens = firstSeg.split(/\s+/).slice(1).filter((t) => !t.startsWith('-'));
    const filePath = tokens[0] || null;
    return { name: 'Read', input: { file_path: filePath, limit: 1, command: inner } };
  }
  if (GREP_BIN_RE.test(firstSeg)) {
    const tokens = firstSeg.split(/\s+/).slice(1);
    const positional = tokens.filter((t) => !t.startsWith('-'));
    const pattern = positional[0] || null;
    const target = positional[1] || null;
    return { name: 'Grep', input: { pattern, path: target, command: inner } };
  }
  if (GLOB_BIN_RE.test(firstSeg)) {
    const tokens = firstSeg.split(/\s+/).slice(1).filter((t) => !t.startsWith('-'));
    return { name: 'Glob', input: { pattern: tokens.join(' ') || null, command: inner } };
  }
  return { name: 'Bash', input: { command: inner } };
}

// `apply_patch` arguments are envelope-formatted text:
//   *** Begin Patch
//   *** Update File: relative/path.ts
//   ...
//   *** End Patch
// Extract one tool use per file so D8/D15-style detectors can fire.
function splitApplyPatch(argsText) {
  const out = [];
  const re = /^\*\*\*\s+(Add File|Update File|Delete File):\s+(.+)$/gm;
  let m;
  while ((m = re.exec(argsText))) {
    const op = m[1];
    const file = m[2].trim();
    if (op === 'Add File') out.push({ name: 'Write', input: { file_path: file } });
    else if (op === 'Update File') out.push({ name: 'Edit', input: { file_path: file } });
    else if (op === 'Delete File') out.push({ name: 'Delete', input: { file_path: file } });
  }
  return out;
}

function normalizeFunctionCall(name, argsRaw) {
  let args = {};
  if (typeof argsRaw === 'string') {
    try { args = JSON.parse(argsRaw); }
    catch (_e) { args = { raw: argsRaw }; }
  } else if (argsRaw && typeof argsRaw === 'object') {
    args = argsRaw;
  }

  if (name === 'shell' || name === 'local_shell' || name === 'local_shell_exec') {
    const cmd = args.command ?? args.cmd ?? args.script ?? args.raw ?? '';
    return [classifyShell(typeof cmd === 'string' ? cmd : JSON.stringify(cmd))];
  }
  if (name === 'apply_patch' || name === 'patch') {
    const text = args.input ?? args.patch ?? args.raw ?? '';
    const splits = splitApplyPatch(typeof text === 'string' ? text : '');
    if (splits.length) return splits;
    return [{ name: 'Edit', input: { command: typeof text === 'string' ? text.slice(0, 80) : '' } }];
  }
  if (name === 'update_plan') return [{ name: 'Plan', input: args }];
  if (name === 'view_image' || name === 'read_image') return [{ name: 'Read', input: { file_path: args.path || args.url, command: 'view_image' } }];
  if (name === 'web_search' || name === 'web_fetch') return [{ name: 'WebFetch', input: args }];
  return [{ name: name || 'Tool', input: args }];
}

function load(filePath, opts = {}) {
  if (!fs.existsSync(filePath)) throw new Error(`transcript not found: ${filePath}`);
  const text = fs.readFileSync(filePath, 'utf8');
  const records = shared.readJSONL(text);

  let sessionId = opts.sessionId || null;
  let sessionCwd = opts.cwd || null;

  // First pass: collect every response_item, every token_count event, every
  // session_meta. Maintain assistant-turn boundaries (a new assistant turn
  // starts at the next assistant `message` or `function_call` after a user
  // message).
  const items = [];
  let lastTokenInfo = null;
  let firstTimestamp = null;
  let lastTimestamp = null;

  for (const raw of records) {
    const wrapped = unwrapRecord(raw);
    if (!wrapped) continue;
    if (wrapped.timestamp) {
      if (!firstTimestamp) firstTimestamp = wrapped.timestamp;
      lastTimestamp = wrapped.timestamp;
    }
    if (wrapped.kind === 'session_meta') {
      sessionId = sessionId || wrapped.payload?.id || wrapped.payload?.session_id || null;
      sessionCwd = sessionCwd || wrapped.payload?.cwd || null;
      continue;
    }
    if (wrapped.kind === 'event_msg') {
      const p = wrapped.payload || {};
      const evType = p.type || p.kind;
      if (evType === 'token_count') {
        const info = p.info || p.usage || {};
        lastTokenInfo = info.total_token_usage || info.last_token_usage || info;
      }
      continue;
    }
    if (wrapped.kind === 'response_item') {
      const p = wrapped.payload || {};
      items.push({ ...p, _ts: wrapped.timestamp || null });
    }
  }

  // Second pass: walk items in order, building turns. A new primary turn
  // starts whenever the model is invoked again — i.e., the previous item
  // was a user message or a function_call_output, or this is the first
  // assistant-side item. Successive assistant items (message + function_call
  // + reasoning) within the same model invocation merge into one turn.
  const assistantTurns = [];
  const toolResults = new Map();
  let primaryIdx = 0;
  let currentTurn = null;
  let lastBoundary = 'start';

  function startTurn(ts) {
    primaryIdx += 1;
    currentTurn = shared.newAssistantTurn({
      index: primaryIdx,
      uuid: `codex-turn-${primaryIdx}`,
      parentUuid: null,
      isSidechain: false,
      timestamp: ts,
      model: null,
      usage: shared.emptyUsage(),
    });
    assistantTurns.push(currentTurn);
  }

  function ensureTurnForAssistant(ts) {
    if (lastBoundary !== 'assistant' || !currentTurn) startTurn(ts);
    lastBoundary = 'assistant';
  }

  for (const item of items) {
    const t = item.type;
    if (t === 'message' && item.role === 'user') {
      currentTurn = null;
      lastBoundary = 'user';
      continue;
    }
    if (t === 'message' && item.role === 'assistant') {
      ensureTurnForAssistant(item._ts);
      currentTurn.texts.push(extractText(item.content));
      currentTurn.timestamp = currentTurn.timestamp || item._ts;
      if (item.model) currentTurn.model = item.model;
      continue;
    }
    if (t === 'reasoning') {
      ensureTurnForAssistant(item._ts);
      continue;
    }
    if (t === 'function_call' || t === 'local_shell_call') {
      ensureTurnForAssistant(item._ts);
      const name = item.name || (t === 'local_shell_call' ? 'shell' : 'Tool');
      const callId = item.call_id || item.id || `${name}-${currentTurn.toolUses.length}`;
      const synthesized = normalizeFunctionCall(name, item.arguments ?? item.args ?? item.action);
      for (let i = 0; i < synthesized.length; i++) {
        const s = synthesized[i];
        currentTurn.toolUses.push({
          toolUseId: synthesized.length === 1 ? callId : `${callId}#${i}`,
          name: s.name,
          input: s.input,
        });
      }
      continue;
    }
    if (t === 'function_call_output' || t === 'local_shell_call_output') {
      const callId = item.call_id || item.id;
      if (callId) {
        const rawOut = item.output ?? item.result ?? '';
        let outText = typeof rawOut === 'string' ? rawOut : extractText(rawOut);
        let isError = false;
        if (outText && outText.trim().startsWith('{')) {
          try {
            const parsed = JSON.parse(outText);
            if (parsed && typeof parsed === 'object') {
              if (typeof parsed.output === 'string') outText = parsed.output;
              if (parsed.metadata && typeof parsed.metadata.exit_code === 'number') {
                isError = parsed.metadata.exit_code !== 0;
              }
            }
          } catch (_e) { /* leave outText alone */ }
        }
        const result = shared.newToolResult({
          content: outText,
          isError: isError || !!item.is_error,
          timestamp: item._ts,
        });
        // Some function_call records expanded to multiple synthesized tool uses;
        // map the result to every #N variant so detectors that key on toolUseId
        // still find it.
        toolResults.set(callId, result);
        for (let i = 0; i < 10; i++) toolResults.set(`${callId}#${i}`, result);
      }
      lastBoundary = 'output';
      continue;
    }
  }

  // Distribute the final cumulative token usage across primary turns. Codex
  // exposes only cumulative counters in `token_count`, so we attribute the
  // total to the session-level totals and leave per-turn usage at zero — the
  // grade formula and most detectors operate on session totals anyway.
  const primaryTurns = assistantTurns.filter((t) => !t.isSidechain);
  const totals = shared.computeTotals(primaryTurns);
  if (lastTokenInfo) {
    const totalInput = lastTokenInfo.input_tokens || lastTokenInfo.input || 0;
    const cachedInput = lastTokenInfo.cached_input_tokens || lastTokenInfo.cached_input || lastTokenInfo.cache_read_input_tokens || 0;
    const output = lastTokenInfo.output_tokens || lastTokenInfo.output || 0;
    const cacheCreation = lastTokenInfo.cache_creation_input_tokens || 0;
    totals.input = Math.max(0, totalInput - cachedInput);
    totals.cache_read = cachedInput;
    totals.cache_creation = cacheCreation;
    totals.output = output;
    totals.paid = totals.output + totals.cache_creation;
    const denom = totals.input + totals.cache_creation + totals.cache_read;
    totals.cache_hit_rate = denom > 0 ? totals.cache_read / denom : 0;
    // Spread output proportionally onto the last turn so D17/D15 token math
    // has something non-zero to work with.
    if (primaryTurns.length > 0 && totals.output > 0) {
      const perTurn = Math.round(totals.output / primaryTurns.length);
      for (const t of primaryTurns) t.usage.output = perTurn;
      const perTurnCacheRead = Math.round(totals.cache_read / primaryTurns.length);
      for (const t of primaryTurns) t.usage.cache_read = perTurnCacheRead;
    }
  }

  return {
    tool: NAME,
    cwd: sessionCwd,
    sessionId,
    records: items,
    primaryTurns,
    sidechainTurns: [],
    sidechainBlocks: [],
    toolResults,
    totals,
    startTime: firstTimestamp,
    endTime: lastTimestamp,
    compactionFlag: false,
    multipleRecent: !!opts.multipleRecent,
  };
}

module.exports = {
  NAME,
  defaultDir,
  resolveDefault,
  detect,
  load,
  // exported for tests
  classifyShell,
  splitApplyPatch,
};
