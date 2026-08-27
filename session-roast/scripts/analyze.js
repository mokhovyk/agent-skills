#!/usr/bin/env node
// session-roast — deterministic transcript analyzer.
// Reads a session transcript from Claude Code, Codex CLI, or Cursor and emits
// a Markdown report (default) or a JSON sidecar (--json). Node stdlib only.

'use strict';

const path = require('node:path');
const loaders = require('./loaders');
const shared = require('./loaders/_shared');

const MIN_TURNS = 10;
const BUCKETS = {
  session_hygiene: 'Session Hygiene',
  clear_constraints: 'Clear Constraints',
  model_selection: 'Model Selection',
  default_path: 'Default Path',
  bound_output: 'Bound Output',
  loop_control: 'Loop Control',
  cross_cutting: 'Cross-cutting',
};
const INACTIVE_BUCKETS = new Set(['clear_constraints', 'model_selection']);
const BOUND_OUTPUT_TOOLS = /\b(head|tail|wc|grep|awk|sed)\b/;
const ABS_PATH_RE = /(?:^|[\s"`'(])(\/[A-Za-z0-9_.\-/]+)/g;

const { anonPath, basename, stableHash, tokensFromChars } = shared;

// ---------- arg parsing ----------

function parseArgs(argv) {
  const out = { json: false, anon: true, cutoff: null, sessionId: null, path: null, tool: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--no-anon') out.anon = false;
    else if (a === '--anon') out.anon = true;
    else if (a === '--cutoff') out.cutoff = argv[++i];
    else if (a === '--session') out.sessionId = argv[++i];
    else if (a === '--tool') out.tool = argv[++i];
    else if (!a.startsWith('--') && !out.path) out.path = a;
    else if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
    else { console.error(`unknown arg: ${a}`); process.exit(2); }
  }
  return out;
}

function printHelp() {
  process.stdout.write([
    'session-roast analyzer',
    '',
    'Usage: analyze.js [transcript-path] [--tool claude|codex|cursor]',
    '                  [--session <id>] [--json] [--no-anon] [--cutoff <uuid>]',
    '',
    'Without [transcript-path], the analyzer picks a transcript for the current',
    'cwd using the resolved tool:',
    '  claude → newest .jsonl in ~/.claude/projects/<encoded-cwd>/',
    '  codex  → newest .jsonl under ~/.codex/sessions/',
    '  cursor → most-recently-active composer in ~/Library/Application Support/',
    '           Cursor/User/globalStorage/state.vscdb (macOS) or the platform',
    '           equivalent. Pass a .vscdb file or exported JSON directly to override.',
    '',
    'Without --tool, the analyzer auto-detects by:',
    '  1. transcript path shape;',
    '  2. file content shape;',
    '  3. $CLAUDE_SESSION_ID / $CODEX_SESSION_ID / $CURSOR_COMPOSER_ID;',
    '  4. whichever known transcript was modified most recently.',
    '',
  ].join('\n'));
}

// ---------- detectors ----------

function tokensFromTool(call, session) {
  const r = session.toolResults.get(call.toolUseId);
  return r ? r.sizeTokens : 0;
}

function isPaginated(input) {
  return !!(input && (input.offset != null || input.limit != null || input.pages));
}

function readRangeKey(input) {
  if (!input) return '';
  return `${input.file_path || ''}|${input.offset || ''}|${input.limit || ''}|${input.pages || ''}`;
}

function detectD1(session) {
  const fires = [];
  const lastSeen = new Map();
  const editedSince = new Set();
  for (const t of session.primaryTurns) {
    for (const u of t.toolUses) {
      if (u.name === 'Edit' || u.name === 'Write') {
        if (u.input?.file_path) editedSince.add(u.input.file_path);
      } else if (u.name === 'Read') {
        const fp = u.input?.file_path;
        if (!fp) continue;
        if (isPaginated(u.input)) continue;
        const key = readRangeKey(u.input);
        if (editedSince.has(fp)) { lastSeen.delete(key); editedSince.delete(fp); }
        const prev = lastSeen.get(key);
        if (prev) {
          prev.count += 1;
          prev.turns.push(t.index);
          prev.wasted += tokensFromTool(u, session);
        } else {
          lastSeen.set(key, { fp, turns: [t.index], count: 1, wasted: 0 });
        }
      }
    }
  }
  for (const entry of lastSeen.values()) {
    if (entry.count >= 2) {
      fires.push({
        id: 'D1', bucket: 'session_hygiene',
        est_tokens_wasted: entry.wasted,
        turns: entry.turns,
        evidence: `re-read ${basename(entry.fp)} ${entry.count}×`,
        fix: 'Default small. Retrieve on demand.',
        files: [entry.fp],
      });
    }
  }
  return fires;
}

function detectD4(session) {
  const fires = [];
  for (const t of session.primaryTurns) {
    for (const u of t.toolUses) {
      if (u.name !== 'Bash') continue;
      const cmd = String(u.input?.command || '');
      const result = session.toolResults.get(u.toolUseId);
      if (!result) continue;
      if (result.sizeTokens <= 5000) continue;
      if (BOUND_OUTPUT_TOOLS.test(cmd)) continue;
      fires.push({
        id: 'D4', bucket: 'bound_output',
        est_tokens_wasted: result.sizeTokens - 5000,
        turns: [t.index],
        evidence: `\`${cmd.split('\n')[0].slice(0, 60)}\` returned ${k(result.sizeTokens)} of output`,
        fix: 'Filter or pipe to head/tail.',
        files: [],
      });
    }
  }
  return fires;
}

function detectD5(session) {
  const fires = [];
  const runs = [];
  for (const t of session.primaryTurns) {
    for (const u of t.toolUses) {
      if (u.name !== 'Bash') continue;
      const cmd = String(u.input?.command || '');
      const result = session.toolResults.get(u.toolUseId);
      const failed = !!(result && result.isError);
      runs.push({ cmd, turnIndex: t.index, failed });
    }
  }
  const buckets = new Map();
  for (const r of runs) {
    if (!r.failed) continue;
    const arr = buckets.get(r.cmd) || [];
    arr.push(r.turnIndex);
    buckets.set(r.cmd, arr);
  }
  for (const [cmd, turns] of buckets) {
    if (turns.length < 2) continue;
    fires.push({
      id: 'D5', bucket: 'loop_control',
      est_tokens_wasted: (turns.length - 1) * 600,
      turns,
      evidence: `\`${cmd.split('\n')[0].slice(0, 60)}\` failed ${turns.length}× without alteration`,
      fix: 'Stop early. Rewind. Narrow the task before continuing.',
      files: [],
    });
  }
  return fires;
}

function detectD6(session) {
  if (session.primaryTurns.length <= 50) return [];
  const rate = session.totals.cache_hit_rate;
  if (rate >= 0.60) return [];
  const wasted = Math.round((0.60 - rate) * session.totals.paid);
  return [{
    id: 'D6', bucket: 'cross_cutting',
    est_tokens_wasted: wasted,
    turns: [],
    evidence: `cache hit rate ${pct(rate)} across ${session.primaryTurns.length} turns`,
    fix: 'Keep context stable; avoid rapid scope shifts.',
    files: [],
  }];
}

function detectD7(session) {
  const fires = [];
  const recentAbsPaths = [];
  for (const t of session.primaryTurns) {
    const hay = t.texts.join(' ') + ' ' + JSON.stringify(t.toolUses);
    const found = [];
    hay.replace(ABS_PATH_RE, (_m, p) => { found.push(p); return ''; });
    recentAbsPaths.push(found);
    if (recentAbsPaths.length > 5) recentAbsPaths.shift();
    const namedPaths = recentAbsPaths.flat();
    for (const u of t.toolUses) {
      if (u.name !== 'Grep' && u.name !== 'Glob') continue;
      const targetPath = u.input?.path;
      const isUnbounded = !targetPath || targetPath === '.' || targetPath === '/';
      if (!isUnbounded) continue;
      if (namedPaths.length === 0) continue;
      const result = session.toolResults.get(u.toolUseId);
      const wasted = result ? result.sizeTokens : 600;
      fires.push({
        id: 'D7', bucket: 'loop_control',
        est_tokens_wasted: wasted,
        turns: [t.index],
        evidence: `${u.name} across the whole tree while ${basename(namedPaths[0])} was already named`,
        fix: 'Scope searches to the directory you already have.',
        files: [],
      });
    }
  }
  return fires;
}

function detectD8(session) {
  const fires = [];
  const recentEdits = new Map();
  for (const t of session.primaryTurns) {
    for (const u of t.toolUses) {
      if ((u.name === 'Edit' || u.name === 'Write') && u.input?.file_path) {
        recentEdits.set(u.input.file_path, t.index);
      } else if (u.name === 'Read' && u.input?.file_path) {
        const editTurn = recentEdits.get(u.input.file_path);
        if (editTurn != null && t.index - editTurn <= 1) {
          const wasted = tokensFromTool(u, session) || 200;
          fires.push({
            id: 'D8', bucket: 'session_hygiene',
            est_tokens_wasted: wasted,
            turns: [t.index],
            evidence: `Read ${basename(u.input.file_path)} right after editing it`,
            fix: 'Trust Edit; Read/Edit already errors if the file state diverged.',
            files: [u.input.file_path],
          });
          recentEdits.delete(u.input.file_path);
        }
      }
    }
    for (const [fp, ti] of [...recentEdits]) {
      if (t.index - ti > 1) recentEdits.delete(fp);
    }
  }
  return fires;
}

function detectD10(session) {
  const fires = [];
  for (const t of session.primaryTurns) {
    for (const u of t.toolUses) {
      if (u.name === 'Bash') continue;
      const r = session.toolResults.get(u.toolUseId);
      if (!r || r.sizeTokens <= 10000) continue;
      fires.push({
        id: 'D10', bucket: 'bound_output',
        est_tokens_wasted: r.sizeTokens - 10000,
        turns: [t.index],
        evidence: `${u.name} returned ${k(r.sizeTokens)} of content`,
        fix: 'Narrow the call or use a more targeted tool.',
        files: [],
      });
    }
  }
  return fires;
}

function detectD11(session) {
  const fires = [];
  let blockIdx = 0;
  for (const block of session.sidechainBlocks) {
    blockIdx += 1;
    const producedTokens = tokensFromChars(block.lastText.length);
    if (block.consumed > 15000 && producedTokens < 500) {
      fires.push({
        id: 'D11', bucket: 'default_path',
        est_tokens_wasted: block.consumed - producedTokens,
        turns: [],
        evidence: `subagent #${blockIdx} consumed ${k(block.consumed)} tokens and returned ${k(producedTokens)} of text`,
        fix: 'Tighten the subagent prompt or inline the work.',
        files: [],
      });
    }
  }
  return fires;
}

function detectD12(session) {
  const fires = [];
  for (let i = 0; i < session.primaryTurns.length; i++) {
    const t = session.primaryTurns[i];
    for (const u of t.toolUses) {
      if (u.name !== 'Grep' && u.name !== 'Glob') continue;
      const result = session.toolResults.get(u.toolUseId);
      if (!result) continue;
      const matchedFiles = new Set();
      for (const line of (result.content || '').split('\n')) {
        const m = line.match(/^[\/A-Za-z0-9_.\-]+/);
        if (m && m[0].includes('/')) matchedFiles.add(m[0]);
      }
      if (matchedFiles.size === 0) continue;
      let reads = 0;
      for (let j = i + 1; j < Math.min(session.primaryTurns.length, i + 6); j++) {
        for (const v of session.primaryTurns[j].toolUses) {
          if (v.name === 'Read' && v.input?.file_path && matchedFiles.has(v.input.file_path)) reads += 1;
        }
      }
      if (reads < 3) {
        fires.push({
          id: 'D12', bucket: 'bound_output',
          est_tokens_wasted: result.sizeTokens,
          turns: [t.index],
          evidence: `${u.name} returned ${matchedFiles.size} hits; only ${reads} got read`,
          fix: 'Tighten the search before running it.',
          files: [],
        });
      }
    }
  }
  return fires;
}

function detectD13(session) {
  const fires = [];
  const seen = new Map();
  for (const t of session.primaryTurns) {
    for (const u of t.toolUses) {
      const h = stableHash({ name: u.name, input: u.input });
      const prev = seen.get(h);
      if (prev) {
        prev.turns.push(t.index);
        prev.count += 1;
        prev.wasted += tokensFromTool(u, session);
      } else {
        seen.set(h, { name: u.name, turns: [t.index], count: 1, wasted: 0, input: u.input });
      }
    }
  }
  for (const entry of seen.values()) {
    if (entry.count < 2) continue;
    fires.push({
      id: 'D13', bucket: 'session_hygiene',
      est_tokens_wasted: entry.wasted,
      turns: entry.turns,
      evidence: `duplicate ${entry.name} call ${entry.count}× with identical input`,
      fix: 'Cache the answer in the conversation; do not re-ask.',
      files: [],
    });
  }
  return fires;
}

function detectD14(session) {
  const fires = [];
  for (const t of session.primaryTurns) {
    for (const u of t.toolUses) {
      if (u.name !== 'Bash') continue;
      const cmd = String(u.input?.command || '');
      if (!/^\s*cd\s+\//.test(cmd)) continue;
      fires.push({
        id: 'D14', bucket: 'default_path',
        est_tokens_wasted: 80,
        turns: [t.index],
        evidence: 'Bash command prefixed with `cd <abs>` instead of using absolute paths in flags',
        fix: 'Use absolute paths in the command; git already operates on the working tree.',
        files: [],
      });
    }
  }
  return fires;
}

function detectD15(session) {
  const fires = [];
  let run = null;
  function flush() {
    if (run && run.turns.length >= 3 && run.failures > 0) {
      fires.push({
        id: 'D15', bucket: 'loop_control',
        est_tokens_wasted: run.tokens,
        turns: run.turns,
        evidence: `${run.turns.length} consecutive turns on the same ${run.kind} with ${run.failures} tool failure${run.failures > 1 ? 's' : ''}`,
        fix: 'Loops compound cost — every fix attempt carries history forward. Rewind.',
        files: run.kind === 'file' ? [run.key] : [],
      });
    }
    run = null;
  }
  for (const t of session.primaryTurns) {
    let stuckOn = null;
    let stuckKind = null;
    let failures = 0;
    for (const u of t.toolUses) {
      const r = session.toolResults.get(u.toolUseId);
      if (r && r.isError) failures += 1;
      if ((u.name === 'Edit' || u.name === 'Write') && u.input?.file_path) {
        stuckOn = u.input.file_path; stuckKind = 'file';
      }
      if (u.name === 'Bash' && r && r.isError) {
        stuckOn = String(u.input?.command || ''); stuckKind = 'cmd';
      }
    }
    if (!stuckOn) { flush(); continue; }
    if (run && run.key === stuckOn) {
      run.turns.push(t.index);
      run.failures += failures;
      run.tokens += t.usage.input + t.usage.output + t.usage.cache_creation;
    } else {
      flush();
      run = { key: stuckOn, kind: stuckKind, turns: [t.index], failures, tokens: t.usage.input + t.usage.output + t.usage.cache_creation };
    }
  }
  flush();
  return fires;
}

function detectD17(session) {
  if (session.primaryTurns.length <= 80) return [];
  const overrun = session.primaryTurns.length - 80;
  const avgPaid = session.totals.paid / Math.max(1, session.primaryTurns.length);
  return [{
    id: 'D17', bucket: 'session_hygiene',
    est_tokens_wasted: Math.round(overrun * avgPaid * 0.6),
    turns: [],
    evidence: `${session.primaryTurns.length} assistant turns in a single session`,
    fix: 'Start a fresh session when the task scope shifts.',
    files: [],
  }];
}

const DETECTORS = [
  detectD1, detectD4, detectD5, detectD6, detectD7, detectD8,
  detectD10, detectD11, detectD12, detectD13, detectD14, detectD15, detectD17,
];

function runDetectors(session) {
  const fires = [];
  for (const fn of DETECTORS) {
    try {
      for (const f of fn(session)) {
        f.turns = (f.turns || []).filter((x) => x != null);
        if (f.est_tokens_wasted > 0 || f.id === 'D14') fires.push(f);
      }
    } catch (e) {
      process.stderr.write(`detector ${fn.name} failed: ${e.message}\n`);
    }
  }
  fires.sort((a, b) => (b.est_tokens_wasted - a.est_tokens_wasted) || a.id.localeCompare(b.id));
  return fires;
}

// ---------- highlights ("Did well") ----------

function buildHighlights(session) {
  const highlights = [];
  if (session.totals.cache_hit_rate >= 0.85 && session.totals.cache_read > 100000) {
    highlights.push(`Cache hit rate ${pct(session.totals.cache_hit_rate)} — recycled ${k(session.totals.cache_read)} of context cheaply.`);
  }
  let goodAgents = 0;
  for (const block of session.sidechainBlocks) {
    const produced = tokensFromChars(block.lastText.length);
    if (block.consumed <= 30000 && produced >= 500) goodAgents += 1;
  }
  if (goodAgents > 0) {
    highlights.push(`${goodAgents} subagent${goodAgents > 1 ? 's' : ''} returned a real result instead of just a transcript.`);
  }
  let boundedBash = 0;
  for (const t of session.primaryTurns) {
    for (const u of t.toolUses) {
      if (u.name !== 'Bash') continue;
      const cmd = String(u.input?.command || '');
      if (BOUND_OUTPUT_TOOLS.test(cmd)) boundedBash += 1;
    }
  }
  if (boundedBash >= 3) {
    highlights.push(`${boundedBash} Bash calls bounded with head/tail/wc/grep.`);
  }
  return highlights;
}

// ---------- grade ----------

function letter(ratio) {
  if (ratio < 0.02) return 'A+';
  if (ratio < 0.05) return 'A';
  if (ratio < 0.08) return 'A-';
  if (ratio < 0.10) return 'B+';
  if (ratio < 0.13) return 'B';
  if (ratio < 0.15) return 'B-';
  if (ratio < 0.25) return 'C';
  if (ratio < 0.40) return 'D';
  return 'F';
}

function computeGrade(session, fires) {
  const wasteByBucket = new Map();
  for (const f of fires) {
    wasteByBucket.set(f.bucket, (wasteByBucket.get(f.bucket) || 0) + f.est_tokens_wasted);
  }
  const wasteTotal = [...wasteByBucket.values()].reduce((a, b) => a + b, 0);

  // When the harness does not surface per-turn token usage, paid ≈ 0 and the
  // ratio explodes. In that case we still rank buckets by absolute waste but
  // suppress the letter grades — the warning banner explains why.
  const ungraded = !!session.usageUnavailable || session.totals.paid <= 0;
  const totalPaid = Math.max(1, session.totals.paid);
  const overallRatio = ungraded ? 0 : wasteTotal / totalPaid;
  const overall = ungraded ? null : letter(overallRatio);

  const bucketGrades = {};
  for (const key of Object.keys(BUCKETS)) {
    if (INACTIVE_BUCKETS.has(key)) { bucketGrades[key] = { grade: null, waste: 0, ratio: 0 }; continue; }
    const waste = wasteByBucket.get(key) || 0;
    const ratio = ungraded ? 0 : waste / totalPaid;
    bucketGrades[key] = { grade: ungraded ? null : letter(ratio), waste, ratio };
  }

  let worstKey = null, worstWaste = 0;
  for (const [key, info] of Object.entries(bucketGrades)) {
    if (INACTIVE_BUCKETS.has(key)) continue;
    if (info.waste > worstWaste) { worstWaste = info.waste; worstKey = key; }
  }
  return { overall, overallRatio, wasteTotal, bucketGrades, worstBucket: worstKey, ungraded };
}

// ---------- output ----------

function k(n) {
  if (n == null) return '0';
  const v = Math.round(n / 1000);
  if (n >= 1000) return `${v.toLocaleString('en-US')}k`;
  return String(n);
}

function pct(n) { return `${Math.round(n * 100)}%`; }

function fmtDuration(start, end) {
  if (!start || !end) return '? min';
  const dt = (new Date(end).getTime() - new Date(start).getTime()) / 60000;
  if (dt < 1) return '<1 min';
  return `${Math.round(dt)} min`;
}

function toolLabel(tool) {
  if (tool === 'claude') return 'Claude Code';
  if (tool === 'codex') return 'Codex';
  if (tool === 'cursor') return 'Cursor';
  return tool || 'unknown';
}

function emitTooShort(session, asJson) {
  const reason = `${session.primaryTurns.length} assistant turn(s); minimum to grade is ${MIN_TURNS}`;
  if (asJson) {
    const out = {
      too_short: true,
      reason,
      tool: session.tool,
      turns: session.primaryTurns.length,
      tokens: session.totals,
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }
  const lines = [
    `🔥 Session Roast — ${toolLabel(session.tool)} · ${fmtDuration(session.startTime, session.endTime)}, ${session.primaryTurns.length} turns`,
    '',
    'Too short to roast.',
    `  ${reason}.`,
    '',
    'Tokens',
    `  New input        :  ${k(session.totals.input).padStart(7)}`,
    `  Cache hits       :  ${k(session.totals.cache_read).padStart(7)}   ← hit rate ${pct(session.totals.cache_hit_rate)}`,
    `  Output           :  ${k(session.totals.output).padStart(7)}`,
    '',
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

function topWastes(fires, n = 5) {
  return fires.filter((f) => f.est_tokens_wasted > 0).slice(0, n);
}

function defaultNextMoves(grade /* , session */) {
  const out = [];
  const worst = grade.worstBucket;
  const tips = {
    session_hygiene: 'Session Hygiene — when the task scope shifts, start a new session. Do not drag stale reads.',
    default_path: 'Default Path — keep MCPs, skills, and Bash defaults thin and intentional.',
    bound_output: 'Bound Output — pipe big commands to head/tail/wc and keep raw logs one command away.',
    loop_control: 'Loop Control — if a fix does not land in two attempts, rewind and narrow the task.',
    cross_cutting: 'Treat context as an engineering resource — protect the cache by keeping scope stable.',
  };
  if (worst && tips[worst]) out.push(tips[worst]);
  if (!out.length) out.push(tips.session_hygiene);
  const second = ['bound_output', 'loop_control', 'session_hygiene'].find((b) => b !== worst);
  if (second && tips[second]) out.push(tips[second]);
  out.push('Default small. Retrieve on demand. Token efficiency is mostly boring discipline.');
  return out.slice(0, 3);
}

function emitMarkdown(session, fires, grade) {
  const lines = [];
  const dur = fmtDuration(session.startTime, session.endTime);
  lines.push('<!-- session-roast: analyzer output. Rewrite only the prose lines in the roast voice. Keep grades, token counts, turn numbers, and file references verbatim. -->');
  lines.push('');
  lines.push(`🔥 Session Roast — ${toolLabel(session.tool)} · ${dur}, ${session.primaryTurns.length} turns`);
  lines.push('');
  if (session.compactionFlag) {
    lines.push('⚠ PARTIAL — session looks compacted; some turns may be missing.');
    lines.push('');
  }
  if (session.multipleRecent) {
    lines.push('⚠ Two transcripts modified within 10 minutes; using the newest.');
    lines.push('');
  }
  if (session.usageUnavailable) {
    lines.push('⚠ Token usage not exposed by this harness; grades may be approximate.');
    lines.push('');
  }
  const worstName = grade.worstBucket ? BUCKETS[grade.worstBucket] : null;
  let gradeLine;
  if (grade.ungraded) {
    gradeLine = worstName ? `Grade: ungraded   (worst bucket: ${worstName})` : 'Grade: ungraded   (no waste detected)';
  } else {
    gradeLine = worstName ? `Grade: ${grade.overall}   (worst bucket: ${worstName})` : `Grade: ${grade.overall}   (no waste detected)`;
  }
  lines.push(gradeLine);
  lines.push('');
  lines.push('Tokens');
  lines.push(`  New input        :  ${k(session.totals.input).padStart(7)}`);
  lines.push(`  Cache hits       :  ${k(session.totals.cache_read).padStart(7)}   ← hit rate ${pct(session.totals.cache_hit_rate)}`);
  lines.push(`  Output           :  ${k(session.totals.output).padStart(7)}`);
  lines.push('');
  lines.push('Efficiency buckets');
  for (const [key, label] of Object.entries(BUCKETS)) {
    if (key === 'cross_cutting') continue;
    const info = grade.bucketGrades[key];
    let g;
    if (INACTIVE_BUCKETS.has(key)) g = '—';
    else if (grade.ungraded) g = info?.waste ? '·' : '—';
    else g = info?.grade ?? '—';
    const wasteStr = info?.waste ? `${k(info.waste)} wasted` : (INACTIVE_BUCKETS.has(key) ? '(no detector)' : 'clean');
    lines.push(`  ${label.padEnd(18)} ${String(g).padEnd(4)} ${wasteStr}`);
  }
  lines.push('');
  const top = topWastes(fires, 5);
  if (top.length) {
    const totalShown = top.reduce((a, b) => a + b.est_tokens_wasted, 0);
    lines.push(`🟥 Top wastes  ~${k(totalShown)} tokens`);
    let i = 0;
    for (const f of top) {
      i += 1;
      const cost = `[-${k(f.est_tokens_wasted)}]`;
      const turnRef = f.turns.length ? ` (turn${f.turns.length > 1 ? 's' : ''} ${f.turns.slice(0, 4).join(', ')})` : '';
      lines.push(`  ${i}. ${cost.padStart(8)} ${f.id} — ${f.evidence}${turnRef}. ${f.fix}`);
    }
  } else {
    lines.push('🟥 Top wastes  none — clean run.');
  }
  lines.push('');
  const wins = buildHighlights(session);
  if (wins.length) {
    lines.push('🟢 Did well');
    for (const w of wins) lines.push(`  • ${w}`);
  } else {
    lines.push('🟢 Did well');
    lines.push('  • (nothing strong enough to brag about)');
  }
  lines.push('');
  lines.push('💡 Next-session moves (framework-aligned)');
  const moves = defaultNextMoves(grade, session);
  let mi = 0;
  for (const m of moves) { mi += 1; lines.push(`  ${mi}. ${m}`); }
  lines.push('');
  process.stdout.write(lines.join('\n') + '\n');
}

function redactString(s) {
  if (typeof s !== 'string' || !s) return s;
  return s.replace(/(\/[A-Za-z0-9_.\-][A-Za-z0-9_.\-/]*)/g, (m) => anonPath(m));
}

function emitJSON(session, fires, grade, anon) {
  const detectors = fires.map((f) => ({
    id: f.id,
    bucket: f.bucket,
    est_tokens_wasted: f.est_tokens_wasted,
    turns: f.turns,
    evidence: anon ? redactString(f.evidence) : f.evidence,
    fix: anon ? redactString(f.fix) : f.fix,
    files: (f.files || []).map((p) => (anon ? anonPath(p) : p)),
  }));
  const out = {
    too_short: false,
    tool: session.tool,
    cwd: anon ? `path/${shared.sha1Short(session.cwd || '')}` : session.cwd,
    session_id: session.sessionId,
    start: session.startTime,
    end: session.endTime,
    duration_min: session.startTime && session.endTime
      ? Math.round(((new Date(session.endTime).getTime() - new Date(session.startTime).getTime()) / 60000) * 10) / 10
      : null,
    turns: session.primaryTurns.length,
    sidechain_blocks: session.sidechainBlocks.length,
    compaction: session.compactionFlag,
    multiple_recent: session.multipleRecent,
    usage_unavailable: !!session.usageUnavailable,
    tokens: session.totals,
    grade: {
      overall: grade.overall,
      overall_ratio: Number(grade.overallRatio.toFixed(4)),
      worst_bucket: grade.worstBucket,
      buckets: grade.bucketGrades,
    },
    detectors,
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

// ---------- main ----------

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  // Mirror the legacy default: if the user did not pass --session and a
  // CLAUDE_SESSION_ID is in the environment, honor it (Claude path only).
  const sessionId = args.sessionId || process.env.CLAUDE_SESSION_ID || process.env.CODEX_SESSION_ID || process.env.CURSOR_COMPOSER_ID || null;
  const { session } = loaders.resolveAndLoad({
    tool: args.tool,
    filePath: args.path,
    sessionId,
    cutoffUuid: args.cutoff,
    cwd,
  });
  if (session.primaryTurns.length < MIN_TURNS) {
    emitTooShort(session, args.json);
    process.exit(0);
  }
  const fires = runDetectors(session);
  const grade = computeGrade(session, fires);
  if (args.json) emitJSON(session, fires, grade, args.anon);
  else emitMarkdown(session, fires, grade);
}

if (require.main === module) {
  try { main(); }
  catch (e) {
    process.stderr.write(`session-roast: ${e.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  parseArgs,
  runDetectors,
  computeGrade,
  letter,
  DETECTORS,
  loaders,
};
