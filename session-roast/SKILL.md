---
name: session-roast
description: "Roast and grade a coding-agent session for token efficiency. Supports Claude Code, Codex, and Cursor (Cursor: wastes only, no grade). Use when the user says /session-roast, roast my session, grade my session, how did I do, was that efficient, or token efficiency."
---

# Session Roast

Grade the active coding-agent session for token efficiency and print a brutal-but-loving roast: letter grade, per-bucket sub-grades, headline token stats, ranked wastes with turn citations, what went well, and three concrete next-session moves — in a single coach voice.

This skill is the observability layer for *how* a session was run. The deterministic analyzer scores; you (the model) rewrite the prose in roast voice. The analyzer ingests transcripts from **Claude Code**, **Codex CLI**, and **Cursor** (composer / agent mode), normalizing each into the same internal shape so detectors and grading logic are identical across harnesses.

The analyzer is plain Node.js using only built-in modules — no `npm install`, no external service, no network access. Everything runs locally against transcripts already on disk.

## When to invoke

- `/session-roast`
- "roast my session"
- "grade my session"
- "how did I do on token efficiency"
- "was that efficient"
- "token efficiency"

Optional arguments the user may pass: `--tool claude|codex|cursor`, `--session <id>`, `--json`, `--no-anon`, or a path to a transcript file.

## When NOT to invoke

- The user asks "what changed?" or "summarize this branch" — that is a content recap, not an efficiency grade.
- The session is fresh (under ~10 assistant turns) — the analyzer refuses with `Too short to roast.`; do not work around it.
- The user wants raw analyzer output for tooling — run the analyzer with `--json` and pass it through. No roast rewrite needed.
- The user asks for general performance advice — this skill grades token-efficiency *behavior*, not latency, model selection, or correctness.

## Hard rules

- **Never** write to files. Terminal output only.
- **Never** re-generate grades, token figures, bucket letters, detector IDs, or turn numbers — these come from the analyzer verbatim.
- **Never** synthesize a grade when the analyzer prints `Too short to roast.` Print it as-is and stop.
- **Never** strip or paraphrase the analyzer's warning lines (`⚠ PARTIAL — session looks compacted`, `⚠ Two transcripts modified within 10 minutes`, `⚠ Token usage not exposed by this harness …`). Preserve them verbatim.
- **Never** add a postface summary after the report. The report is the deliverable.

## Flow (do these steps in order)

### 1. Run the analyzer

Shell out to the deterministic analyzer, using the path where this skill is installed. Pass through whatever flags the user provided; otherwise run with defaults.

```bash
node <skill-dir>/scripts/analyze.js
```

The analyzer auto-resolves the transcript:

- If `--tool <claude|codex|cursor>` is set, it uses that loader.
- Otherwise it auto-detects by transcript path, file content, `$CLAUDE_SESSION_ID` / `$CODEX_SESSION_ID` / `$CURSOR_COMPOSER_ID`, or whichever known transcript was modified most recently.
- For **Claude Code**: newest `.jsonl` in `~/.claude/projects/<encoded-cwd>/` (or `--session <id>`).
- For **Codex CLI**: newest `.jsonl` under `~/.codex/sessions/`.
- For **Cursor**: the most-recently-active composer in `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` (macOS) or the platform equivalent. Pass a `.vscdb` path or a JSON export directly to override.

If the script exits non-zero, surface the error verbatim; do **not** try to grade anyway.

If the printed report starts with `Too short to roast.`, print it as-is and stop. Do not invent a grade.

### 2. Rewrite the prose lines

Read the Markdown output. Following [`references/roast-voice.md`](references/roast-voice.md):

- Keep grades, token figures, bucket letters, detector IDs, turn numbers, and file references **verbatim**.
- Rewrite only the explanation halves of "Top wastes" lines, the right-column bucket comments, the "Did well" bullets, and the three "Next-session moves".
- Weave in at least one canonical framework phrase (the list lives in [`references/roast-voice.md`](references/roast-voice.md)).
- Use second-person voice. No "we".

### 3. Print the rewritten report

Print the final report directly to the terminal. The report is the deliverable — prohibitions live in **Hard rules** above.

## Edge cases

- **Compaction (Claude only).** If the analyzer prints `⚠ PARTIAL — session looks compacted`, preserve that line and proceed; mention in the next-session moves that a fresh session is the cheapest fix.
- **Two recent transcripts.** If the analyzer prints `⚠ Two transcripts modified within 10 minutes`, preserve it and proceed — it is using the newest.
- **Token usage unavailable (Cursor).** Cursor's local store does not expose per-turn token counts. The analyzer prints `⚠ Token usage not exposed by this harness; grades may be approximate.` and shows `Grade: ungraded` while still ranking wastes in absolute terms. Preserve the warning verbatim.
- **`--json`.** When the user passes `--json`, run the analyzer with `--json` and pipe the JSON to stdout untouched. No roast-voice rewrite in that mode.
- **`--no-anon`.** Forwards directly to the analyzer; affects JSON output only (Markdown shows basenames either way).
- **Sessions under 10 assistant turns.** The analyzer prints stats only; respect that and do not synthesize a grade.

## Privacy — `--anon` mode (default ON)

JSON output is anonymized by default. The redaction rules:

- **File paths** → `path/<sha1(path)[0:6]><ext>` (extension preserved).
- **Bash commands** → keep only the binary name; arguments collapse to `<args>`.
- **Prompt text** → never included in JSON output; only token counts and stats.
- **User-supplied strings** in `evidence` fields → routed through the same path redactor.

Pass `--no-anon` to opt back into full content. Markdown output always uses basenames regardless of the flag.

## Reference

- [`references/detectors.md`](references/detectors.md) — per-detector specs, false-positive guards, est-tokens formulas.
- [`references/roast-voice.md`](references/roast-voice.md) — rewrite rules, canonical phrases, before/after examples.
- [`references/framework.md`](references/framework.md) — the 6-bucket efficiency framework and detector→bucket map.
- [`references/loaders.md`](references/loaders.md) — per-harness transcript locations, normalization rules, and known limitations.

## Scope

- macOS / Linux (Windows paths are not exercised, though the Cursor loader includes a best-effort `%APPDATA%` fallback).
- Terminal-only output. No file writes. No external services. Node built-ins only.
- Single session per invocation; no multi-session rollup.
- Codex and Cursor coverage is approximate where the harness does not expose per-turn token usage — see `references/loaders.md`.
