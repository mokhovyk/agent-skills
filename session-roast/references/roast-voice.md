# Roast voice — rewrite guide

> Read this before rewriting the analyzer's Markdown. The grade, token counts, turn numbers, file references, and detector IDs come from `scripts/analyze.js` and must stay verbatim. Your job is only to rewrite the **prose lines** in the brutal-but-loving roast voice.

## What you may rewrite

- The headline line below `🔥 Session Roast` (date/duration is verbatim — the optional prefix prose is yours).
- The grade-line parenthetical (you may swap "worst bucket: X" for an equivalent jab; do not change the letter).
- The trailing prose comments on each "Efficiency buckets" row (right column).
- The explanation half of each "Top wastes" line — everything after the detector ID and turn citation. Leave the `[-Nk] DXX —` prefix and the `(turn N, ...)` cluster untouched.
- The "Did well" bullets — you may tighten or sharpen them; do not invent new positives.
- The "Next-session moves" body — you choose three concrete moves grounded in the worst buckets and detectors that fired. Keep them imperative, second-person, and aligned to the [efficiency framework](framework.md).

## What you must NOT rewrite

- The `Grade:` letter.
- The `Tokens` block numbers, cache-hit percentage, and labels.
- The bucket-grade letters (`A+`, `B−`, …) on every "Efficiency buckets" row.
- Detector IDs (`D1`, `D4`, …) and the `[-Nk]` cost numbers in the Top wastes list.
- Turn numbers — `(turn 7, 12, 19)` stays exactly as printed.
- File references — `AGENTS.md`, `path/abcdef.ts`, etc.
- The `🟥 🟢 💡` emoji headers.

## The voice in one paragraph

Brutal but loving. The roast is aimed at the **behavior**, not the person. Direct, declarative, second-person ("you re-read AGENTS.md three times" — not "the session re-read AGENTS.md"). Avoid first-person plural ("we"). Use imperatives in the next-session moves. One canonical framework phrase per report, minimum. No emojis other than the ones the analyzer already printed.

## Voice rules (hard)

1. **Second person.** "You let `find` dump 14k of paths." Not: "The session let `find` dump 14k of paths."
2. **No first-person plural.** "We" hides the lesson.
3. **No hedging.** Cut "perhaps", "might consider", "you may want to". The data is in front of you.
4. **Cite the data.** Every jab points at a turn number, a detector, a file basename, or a token figure.
5. **At least one framework phrase.** Pick from the canon list below. Repeat the same phrase across reports if it fits; do not invent new ones.
6. **Three next-session moves. Imperative. Concrete.** No "be mindful". Use verbs: "pipe", "start", "narrow", "stop", "rewind".

## The canonical phrases (use ≥1)

- "Default small. Retrieve on demand."
- "Treat context as an engineering resource."
- "Stop early. Rewind. Narrow the task before continuing."
- "Loops compound cost — every fix attempt carries history forward."
- "Useful work arrives after the bill grows."
- "Power tools are not free memory."
- "Token efficiency is mostly boring discipline."

## Tone calibration

| Too gentle | Right | Too cruel |
|---|---|---|
| "Consider re-reading AGENTS.md less often." | "You re-read AGENTS.md three times in twenty turns. Default small. Retrieve on demand." | "You can't even remember what's in AGENTS.md." |
| "The cache hit rate could be improved." | "Cache hit rate 42% — you blew up your own context every other turn." | "You're terrible at caching." |
| "It might help to bound output." | "`find . -name "*.ts"` returned 14k of paths at turn 11. Pipe to head next time." | "Only a fool runs unbounded `find`." |

The right column targets behavior with specifics; the cruel column attacks identity with generalities.

## Before / after rewrites

### Example 1 — D1 re-read

**Analyzer:** `1. [-18k] D1 — re-read AGENTS.md 3× (turns 4, 9, 15). Default small. Retrieve on demand.`

**Rewrite:** `1. [-18k] D1 — you re-read AGENTS.md three times (turns 4, 9, 15) without an Edit between them. Default small. Retrieve on demand.`

### Example 2 — D4 unbounded bash

**Analyzer:** `2. [-8k] D4 — \`find . -name "*.ts"\` returned 14k of output (turn 11). Filter or pipe to head.`

**Rewrite:** `2. [-8k] D4 — \`find . -name "*.ts"\` dumped 14k of paths into context at turn 11. Pipe to head; the raw list is one re-run away.`

### Example 3 — D13 duplicate tool call

**Analyzer:** `3. [-5k] D13 — duplicate Grep call 2× with identical input (turns 6, 14).`

**Rewrite:** `3. [-5k] D13 — same Grep query at turns 6 and 14. Power tools are not free memory; cache the answer in the conversation.`

### Example 4 — Bucket comment

**Analyzer:** `  Loop Control       D    23k wasted`

**Rewrite (the right column):** `  Loop Control       D    you fought the same failing command four times`

### Example 5 — Did-well

**Analyzer:** `• 6 Bash calls bounded with head/tail/wc/grep.`

**Rewrite:** `• Six Bash calls bounded with head/tail/wc/grep — you remembered the budget on those.`

### Example 6 — Next-session move

**Analyzer:** `1. Session Hygiene — when the task scope shifts, start a new session. Do not drag stale reads.`

**Rewrite:** `1. Session Hygiene — when the task scope shifts, open a new session. Dragging stale reads costs more than the restart.`

## Picking the three next-session moves

Default rule: the first move addresses the **worst bucket** (printed in the grade line); the second move addresses the next worst that has waste; the third move is a closing reminder that uses one of the canonical phrases verbatim.

If the run is clean (no waste): congratulate once, then list three framework habits to keep — do not invent fake critique.

## Quick checklist before printing

- [ ] At least one second-person pronoun.
- [ ] Zero first-person plural ("we", "our", "us") outside the canon phrases.
- [ ] At least one canonical framework phrase, verbatim.
- [ ] Every "Top wastes" line still has its `DXX` ID and turn cluster verbatim.
- [ ] Grade letter and token table untouched.
- [ ] Next-session moves are imperative and concrete.
