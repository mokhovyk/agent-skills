# Loaders — per-harness transcript handling

> `scripts/loaders/` translates each supported harness into the normalized session shape consumed by the detectors and grade formula. This document explains what each loader expects, what it preserves, and where coverage is approximate.

The normalized shape (see `scripts/loaders/index.js`) carries: `primaryTurns`, `sidechainTurns`, `sidechainBlocks`, `toolResults`, `totals` (`{input, cache_creation, cache_read, output, paid, cache_hit_rate}`), `compactionFlag`, `multipleRecent`, and the optional `usageUnavailable` flag.

## Auto-detection (no `--tool` flag)

The dispatcher in `scripts/loaders/index.js` chooses a loader in this order:

1. An explicit `--tool` argument wins.
2. An explicit transcript path is matched against each loader's `detect({ filePath })` first (path-shape) then `detect({ filePath, sampleRecords })` (content-shape, line-by-line JSONL plus a whole-file JSON fallback).
3. Without a path: `$CLAUDE_SESSION_ID` / `$CODEX_SESSION_ID` / `$CURSOR_COMPOSER_ID` are honored.
4. Failing all of the above: whichever harness has the most recently modified known transcript for the current cwd.

If none of these resolve, the dispatcher falls back to `claude` (the original supported target).

## Claude Code

- **Transcript source:** `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, where the cwd is encoded by replacing `/` with `-`.
- **Record format:** one JSON record per line with `type` ∈ `{assistant, user, system}`, `parentUuid`, `uuid`, optional `isSidechain`, `message.content` (text + tool_use + tool_result blocks), `message.usage` carrying `{input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens}`, and `toolUseResult` for non-text outputs.
- **Self-reference trimming:** the loader cuts at the assistant record immediately preceding the user's `/session-roast` invocation. It recognizes both the slash-command tag form (`<command-name>/session-roast</command-name>`) and a soft trigger ("roast my session" etc.) at the start of a short user message.
- **Compaction:** detected via dangling `parentUuid` entries or an explicit `system`/`summary` record. Surfaces as `⚠ PARTIAL — session looks compacted`.
- **Sidechains:** assistant records with `isSidechain: true` are grouped into contiguous blocks. D11 fires on blocks that consumed >15k tokens and returned <500 tokens of text.
- **Coverage:** full — all 13 detectors are exercised against Claude-shape transcripts.

## Codex CLI

- **Transcript source:** `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl`. The loader walks the date tree recursively and picks the newest file (or a specific id via `--session`).
- **Record format:** wrapped `{record_type, payload, timestamp}` envelopes with three relevant kinds:
  - `session_meta` → carries `{id, cwd, originator, cli_version}`.
  - `response_item` → the conversation. Inner types: `message` (role user/assistant/system, content array of text parts), `function_call` (`name`, `arguments`, `call_id`), `function_call_output` (`call_id`, `output`), `reasoning` (summary blocks).
  - `event_msg` → operational events. `type: "token_count"` records `total_token_usage: {input_tokens, cached_input_tokens, output_tokens}` (cumulative).
  - Legacy rollouts without `record_type` (older Codex versions) are tolerated by treating the top-level `type` as the kind.
- **Tool-name normalization:** Codex routes most actions through the `shell` function. The loader classifies each `shell` invocation:
  - `cat` / `less` / `more` / `bat` / `view` → `Read` (extracts `file_path`).
  - `head` / `tail` → `Read` with `limit: 1` so chunked progression doesn't trip D1.
  - `rg` / `grep` / `ag` / `ack` → `Grep` (extracts `pattern` and target path).
  - `find` / `fd` / `ls` → `Glob`.
  - Anything else → `Bash` (preserving the full command).
  - `apply_patch` envelopes are parsed; one `Edit` / `Write` / `Delete` tool use is emitted per `*** Update File:` / `*** Add File:` / `*** Delete File:` block. The tool-result is mapped to every synthesized `call_id#N` so detectors keyed on `toolUseId` still resolve.
  - `update_plan` → `Plan` (not graded). `view_image` / `read_image` → `Read`. `web_fetch` / `web_search` → `WebFetch`.
- **Turn boundaries:** one primary turn per model invocation. A new turn starts after a user message or a `function_call_output`; consecutive assistant items (message + function_call + reasoning) collapse into the same turn so the turn count reflects model invocations, not records.
- **Usage:** Codex reports cumulative token counts in `token_count` events. The loader takes the latest cumulative total and distributes `output` and `cache_read` proportionally across primary turns so per-turn detectors (D15) have something to work with. `cache_creation` is recorded as 0 because Codex does not surface a separate cache-creation cost. The denominator for `cache_hit_rate` is `input + cache_creation + cache_read`, matching Claude.
- **Compaction / sidechains:** Codex does not surface either in the local rollout. `compactionFlag` stays false; `sidechainBlocks` is empty, so D11 is effectively dormant on Codex sessions.
- **Coverage:** all detectors except D11 fire as expected. `codex-messy.jsonl` plants D1 / D4 / D5 / D6 / D7 / D12 / D13 / D15 signals.

## Cursor

- **Transcript source:** `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` (macOS), with platform fallbacks at `~/.config/Cursor/User/globalStorage/state.vscdb` (Linux) and `%APPDATA%\Cursor\User\globalStorage\state.vscdb` (Windows, best effort). A `.vscdb` path or a JSON export of the shape `{ composerId, workspaceFolder?, bubbles: [...] }` can also be passed directly.
- **Record format inside SQLite:** `cursorDiskKV` rows keyed by:
  - `composerData:<composerId>` → JSON containing `composerId`, `fullConversationHeadersOnly` (ordered bubble list), `lastUpdatedAt`, `workspaceFolder`, etc.
  - `bubbleId:<composerId>:<bubbleId>` → JSON message ("bubble") with `type` (1 = user, 2 = assistant), `text` / `richText` / `content`, `toolResults[]` (tool calls with `toolName`, `input`, `result`, optional `error`), and `suggestedCodeBlocks[]` (model-proposed file edits).
- **SQLite access:** the loader shells out to the system `sqlite3` CLI in `-readonly` mode. Cursor may hold a write lock; if the query fails, the loader surfaces the error and stops.
- **Composer selection:** without `--session`, the loader picks the composer with the highest `lastUpdatedAt` / `lastSubmittedAt` / `createdAt` (or, failing those, the most bubbles).
- **Tool-name normalization:** every `toolName` is mapped through `normalizeToolName()` in `loaders/cursor.js`:
  - `read_file` / `read` / `view` → `Read`
  - `edit_file` / `apply` / `search_replace` → `Edit`
  - `create_file` / `write_file` → `Write`
  - `terminal` / `bash` / `run` / `exec` → `Bash`
  - `grep_search` / `codebase_search` → `Grep`
  - `file_search` / `list_dir` → `Glob`
  - `suggestedCodeBlocks[]` items are synthesized as `Edit` (existing files) or `Write` (when `isNewFile` is set).
- **Turn boundaries:** one primary turn per assistant bubble. Cursor inlines tool results inside the same bubble, so no extra splitting is needed.
- **Usage:** Cursor does not record per-turn token usage in the local store. The loader sets `usageUnavailable: true` and leaves `totals.input` / `cache_read` / `output` at zero. The analyzer responds by emitting `⚠ Token usage not exposed by this harness` and `Grade: ungraded`; bucket markers become `·` (waste present) or `—` (clean). Detector lines still cite absolute token estimates derived from result sizes.
- **Coverage:** structural detectors (D1, D4, D5, D7, D8, D10, D12, D13, D14, D15) work. D6 (cache hit rate) and D17 (long session penalty) are dormant on Cursor because they require usage totals. D11 is dormant because Cursor doesn't surface sub-agent runs in the local store.

## Adding a new harness

The dispatcher and detectors operate purely on the normalized session shape. To add a new harness:

1. Create `scripts/loaders/<name>.js` exporting `NAME`, `resolveDefault({cwd, sessionId, filePath})`, `detect({filePath, sampleRecords})`, and `load(filePath, opts)` returning the normalized session.
2. Register it in `LOADERS` in `scripts/loaders/index.js` and add an env-var hook in `detectFromEnv()` if the harness exposes one.
3. Verify by running `node scripts/analyze.js <path-to-a-real-transcript>` for that harness and confirming the detectors fire where expected.
4. Document the harness in this file with the same headings as Claude / Codex / Cursor above.

## Out of scope

- **Per-turn token usage for Cursor.** The local store does not surface input / cache / output tokens per assistant bubble, so D6 / D17 stay dormant and the report runs in `ungraded` mode. A future version may shell out to the Cursor backend API when authentication is available.
- **Sidechain support for Codex / Cursor.** Neither harness exposes the "subagent block" notion the way Claude does. D11 effectively only fires on Claude.
- **Windows path encoding.** This skill targets macOS and Linux. The Cursor loader includes a best-effort `%APPDATA%\Cursor` fallback.
- **Auto-fire via a `Stop` hook.** Today the skill is user-invoked only.
- **Multi-session rollup / trend comparison.** Terminal-only output was chosen on purpose; rollups are out of scope for this skill.
- **Tone variants** (gentle / clinical).
- **Cost-in-dollars estimate.**
