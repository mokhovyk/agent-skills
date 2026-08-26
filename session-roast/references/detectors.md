# Detectors

Twelve deterministic detectors organized by the [6-bucket efficiency framework](framework.md). Each one is implemented in [`scripts/analyze.js`](../scripts/analyze.js) and runs against the normalized session shape produced by the per-harness loaders ([`loaders.md`](loaders.md)). Each detector emits the shape:

```ts
{ id, bucket, severity?, est_tokens_wasted, turns: int[], evidence: string, fix: string, files?: string[] }
```

- `turns` are **primary-thread assistant turn indices**, 1-based. Sidechain (subagent) records do not get a turn number.
- `est_tokens_wasted` is the analyzer's best estimate; it feeds the grade formula directly.
- `evidence` is the prose summary shown in the Markdown report. In `--anon` JSON output, evidence and file paths are passed through `redactString()` / `anonPath()`.
- Detector applicability varies by harness. D6, D11, D17 require per-turn or sidechain data and are dormant on harnesses that don't surface it — see `loaders.md` for the matrix.

Token estimates assume 4 chars/token unless noted.

---

## Bucket 1 — Session Hygiene

### D1 — Same Read on the same file & byte range ≥2×

**Pattern.** Two or more `Read` tool uses targeting the same `file_path` with the same `offset` / `limit` / `pages` combination, with no intervening `Edit` / `Write` on that same path.

**Skipped.** Paginated reads (`offset` or `limit` set, or `pages` for PDFs) are excluded — chunked re-reads are intentional progression, not waste.

**Token estimate.** `Σ tokens(result)` for every duplicate read after the first.

**Evidence.** `re-read AGENTS.md 3×`

**Fix copy.** "Default small. Retrieve on demand."

**False-positive guards.** Edit/Write on the file resets the de-dup key. Paginated reads are skipped outright.

### D8 — Read on a file within one turn of an Edit/Write on it

**Pattern.** `Read` whose `file_path` was the target of an `Edit` or `Write` in the same turn or the immediately preceding turn.

**Token estimate.** Result tokens (or 200 if the result is missing).

**Evidence.** `Read AGENTS.md right after editing it`

**Fix copy.** "Trust Edit; Read/Edit already errors if the file state diverged."

**False-positive guards.** Only fires within a 1-turn window; older edits expire so legitimate later re-reads do not count.

### D13 — Same `{tool, input}` JSON hash repeated across turns

**Pattern.** Two or more tool uses whose `(name, input)` canonicalize to the same SHA-1. Canonicalization sorts object keys recursively so semantically-identical inputs hash the same.

**Token estimate.** `Σ tokens(result)` for every duplicate after the first.

**Evidence.** `duplicate Grep call 3× with identical input`

**Fix copy.** "Cache the answer in the conversation; do not re-ask."

**False-positive guards.** Whitespace/order-only differences in input are normalized by canonicalization.

### D17 — Long session (>80 primary assistant turns)

**Pattern.** More than 80 non-sidechain assistant records in the trimmed transcript.

**Token estimate.** `(turns − 80) × avg_paid_per_turn × 0.6`. The `0.6` factor reflects the guidance that long sessions waste a portion of every late-session turn on stale context, not the whole turn.

**Evidence.** `124 assistant turns in a single session`

**Fix copy.** "Start a fresh session when the task scope shifts."

---

## Bucket 4 — Default Path

### D11 — Subagent with heavy spend and thin output

**Pattern.** A contiguous run of `isSidechain: true` records (one subagent invocation) where summed input + cache-creation + output exceeds 15k tokens but the final assistant text block returned to the parent is under 500 tokens.

**Token estimate.** `consumed − produced_tokens`.

**Evidence.** `subagent #2 consumed 22k tokens and returned 0k of text`

**Fix copy.** "Tighten the subagent prompt or inline the work."

**False-positive guards.** Empty-text subagents that produce a structured tool-result back to the parent are still counted as thin because the framework treats "returned a short text summary" as the contract.

### D14 — Bash command prefixed with `cd <abs>`

**Pattern.** Bash command whose `command` field begins with `cd /...`.

**Token estimate.** Fixed `80` tokens. This detector is hygiene-flavored; it punishes the bucket grade but does not bloat the top-wastes list.

**Evidence.** `Bash command prefixed with \`cd <abs>\` instead of using absolute paths in flags`

**Fix copy.** "Use absolute paths in the command; git already operates on the working tree."

---

## Bucket 5 — Bound Output

### D4 — Unbounded Bash result over 5k tokens

**Pattern.** `Bash` tool use whose `toolUseResult.stdout + stderr` exceeds 5k tokens AND whose `command` does not include any of `head`, `tail`, `wc`, `grep`, `awk`, `sed`.

**Token estimate.** `tokens(result) − 5000`. Anything past the budget counts as waste.

**Evidence.** `\`find . -name "*.ts"\` returned 14k of output`

**Fix copy.** "Filter or pipe to head/tail."

**False-positive guards.** The bounding-tool regex matches the command string anywhere — `cat huge.log | head -100` passes; `cat huge.log` does not.

### D10 — Any non-Bash tool result over 10k tokens

**Pattern.** Any tool result whose total character size exceeds 10k tokens, excluding Bash (already handled by D4).

**Token estimate.** `tokens(result) − 10000`.

**Evidence.** `Grep returned 12k of content`

**Fix copy.** "Narrow the call or use a more targeted tool."

### D12 — Grep/Glob whose hits were mostly ignored

**Pattern.** A `Grep` or `Glob` whose result text references at least one path-shaped match, where fewer than three of those hits get `Read` within the next five primary turns.

**Token estimate.** Full grep/glob result tokens — the search bought nothing.

**Evidence.** `Grep returned 11 hits; only 1 got read`

**Fix copy.** "Tighten the search before running it."

---

## Bucket 6 — Loop Control

### D5 — Same Bash command failed ≥2× with no alteration

**Pattern.** Group Bash calls by exact `command` string; if a command failed (`is_error: true`) more than once, the loop is detected.

**Token estimate.** `(failures − 1) × 600` tokens, a flat per-retry cost.

**Evidence.** `\`npm test\` failed 3× without alteration`

**Fix copy.** "Stop early. Rewind. Narrow the task before continuing."

### D7 — Unbounded Grep/Glob right after a path was named

**Pattern.** A `Grep` or `Glob` with no `path` argument (or `path === '.'` / `path === '/'`) while at least one absolute path appeared in the assistant's text or tool inputs in the last 5 turns.

**Token estimate.** Full result tokens, or 600 if no result is available.

**Evidence.** `Glob across the whole tree while package.json was already named`

**Fix copy.** "Scope searches to the directory you already have."

### D15 — Stuck loop on the same file or failing command

**Pattern.** At least 3 consecutive primary turns where each turn acts on the same file (Edit/Write) or re-runs the same failing Bash command, AND at least one tool failure exists across the run.

**Token estimate.** Sum of `input + output + cache_creation` tokens across the stuck turns.

**Evidence.** `4 consecutive turns on the same file with 2 tool failures`

**Fix copy.** "Loops compound cost — every fix attempt carries history forward. Rewind."

**False-positive guards.** Smooth, error-free sequential edits to the same file are productive and explicitly skipped (no failure → no fire).

---

## Cross-cutting

### D6 — Cache hit rate below 60% for sessions over 50 turns

**Pattern.** `cache_read / (input + cache_creation + cache_read) < 0.60` on the primary thread, with strictly more than 50 primary turns.

**Token estimate.** `(0.60 − hit_rate) × total_paid`. This approximates the cache-creation cost we would have avoided at the target hit rate.

**Evidence.** `cache hit rate 42% across 73 turns`

**Fix copy.** "Keep context stable; avoid rapid scope shifts."

**Why a turn-count gate.** Short sessions naturally start cold; flagging them on hit-rate alone would punish the first 10 turns of every fresh chat.

---

## Grade formula

```
total_paid    = Σ (output_tokens + cache_creation_input_tokens)   # paid productive work
waste_total   = Σ est_tokens_wasted across fired detectors
waste_ratio   = waste_total / total_paid

<0.02 → A+   <0.05 → A   <0.08 → A−
<0.10 → B+   <0.13 → B   <0.15 → B−
<0.25 → C    <0.40 → D   else  → F
```

The denominator excludes `cache_read_input_tokens` — recycled context is not earned productivity. There is no cache-hit adjustment in the formula itself; D6 captures that signal as a detector.

**Bucket sub-scores.** Each bucket gets a sub-grade computed as `waste_in_bucket / total_paid`, with the same letter mapping. The roast highlights the user's worst bucket explicitly (e.g., *"You scored well on Bound Output and Default Path; you blew it on Session Hygiene."*).

**Ungraded mode.** When the loader marks `usageUnavailable: true` (Cursor today), the formula cannot produce a meaningful ratio. The analyzer suppresses the letter (printing `Grade: ungraded`) and bucket markers (`·` for non-empty buckets, `—` for clean) while still ranking wastes in absolute terms.

---

## What is intentionally **not** a detector

| Pattern | Why dropped |
|---|---|
| Over-deliberation (thinking tokens) | `output_tokens` includes thinking; not separable from useful output. |
| `cat`/`head`/`tail` on small files | Too many false positives. |
| Sequential same-tool calls | Latency tax, not a token tax. |
| Skill-abandonment | Unreliable to detect from transcript alone. |
| AGENTS.md > 200 lines | Environment check, not session check. |
| Unused loaded skills | Needs harness data, not transcript data. |
| Clear Constraints / Model Selection signals | Need LLM judgment or harness data not present in the transcript. |

## Tuning

Thresholds live as named constants near the top of `analyze.js` (e.g. `CHARS_PER_TOKEN`, `MIN_TURNS`). The bucket grade formula uses the letter ladder in `letter(ratio)`. Detector wiring lives in the `DETECTORS` array — adding a new detector requires only appending a function and updating this document.
