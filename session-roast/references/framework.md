# The token-efficiency framework — six buckets

> This skill operationalizes a six-bucket model of token efficiency into per-session, deterministic diagnostics. This doc defines the buckets, maps them to detectors, and lists the voice canon.

## The framework in one paragraph

Token efficiency is mostly boring discipline: keep context clean, route work deliberately, and measure before changing defaults. The boring answer is to **shrink the default path** — load only the history, files, tool schemas, and logs the task actually needs; retrieve everything else on demand. Treat context as an engineering resource.

## The six buckets

| # | Bucket | Guidance |
|---|--------|----------|
| 1 | **Session Hygiene** | Start fresh when task scope or relevant files change. Reset context to avoid noise. Avoid long sessions / huge context windows. |
| 2 | **Clear Constraints** | Give context, constraints, and a definition of done (DoD) in every prompt. |
| 3 | **Model Selection** | Pick the right model, effort, and window size for the uncertainty you have. Scale as needed. |
| 4 | **Default Path** | Mind MCPs, skills, rules, and tool schemas. Keep the default path thin and intentional. Remove unused skills. Keep agent instruction files lean (<200 lines). |
| 5 | **Bound Output** | Bound CLI/script output; keep raw logs one command away. Don't flood the context. Prefer narrow tools. |
| 6 | **Loop Control** | Cap loops: checkpoint, rewind, or change tactic early. Loops compound cost because every fix attempt carries history forward. |

## Detector → bucket map

| Bucket | Detectors |
|--------|-----------|
| Session Hygiene | D1, D8, D13, D17 |
| Clear Constraints | — (no deterministic detector; needs LLM judgment) |
| Model Selection | — (no detector; transcripts don't reliably expose per-turn model) |
| Default Path | D14, D11 |
| Bound Output | D4, D10, D12 |
| Loop Control | D5, D7, D15 |
| Cross-cutting | D6 (cache hit rate) |

See [`detectors.md`](detectors.md) for per-detector specs.

## Known coverage gaps

- **Clear Constraints** has no deterministic detector — assessing prompt quality requires LLM judgment.
- **Model Selection** has no detector — transcripts don't reliably expose the user-selected model per turn.
- **Agent instruction file > 200 lines** is an environment check, not a session check.
- **Unused loaded skills** needs harness data on which skill descriptors were loaded — not available from transcripts.

## Voice canon

The model rendering the roast is instructed (via [`roast-voice.md`](roast-voice.md)) to weave at least one of these phrases into the report:

- "Default small. Retrieve on demand."
- "Treat context as an engineering resource."
- "Stop early. Rewind. Narrow the task before continuing."
- "Loops compound cost — every fix attempt carries history forward."
- "Useful work arrives after the bill grows."
- "Power tools are not free memory."
- "Token efficiency is mostly boring discipline."

## Positioning

`session-roast` is a **skill-form, per-session, roast-toned, harness-agnostic** diagnostic — invokable mid-session in Claude Code, Codex, or Cursor. It runs entirely locally on Node built-ins: no external service, no install step, no multi-session rollup. See [`loaders.md`](loaders.md) for per-harness transcript sources and coverage notes.
