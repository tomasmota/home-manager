---
name: model-benchmarks
description: Look up independent AI model benchmarks, pricing, speed and capabilities (Artificial Analysis, models.dev) and compare models. Use when asked which model is best, cheapest or fastest for a task, to compare models, to check a model's strengths and weaknesses, how a model ranks on coding, reasoning or agentic work, what a model costs, or whether a newer model is worth switching to.
license: MIT
---

# Model benchmarks

Gives agents measured data (quality indices, price, speed, capabilities) instead of recalled opinions about models.

## Data sources

| Need | Source |
| --- | --- |
| Quality indices, price, speed | `scripts/aa.mjs` (Artificial Analysis free API) |
| Context window, tool calling, modalities, knowledge cutoff, open weights | `curl -fsS https://models.dev/api.json` (no key; its benchmark fields are mostly empty, so use it for specs only) |
| Human-preference rankings (optional) | Hugging Face dataset `lmarena-ai/leaderboard-dataset`, configs such as `text`, `webdev`, `agent`. Use only when writing quality or chat feel matters |

If the user's harness can list the models actually available to them, check that list before recommending anything, so the answer is something they can use.

## API key

`aa.mjs` needs a free Artificial Analysis key (https://artificialanalysis.ai/data-api). It reads `AA_API_KEY`, `ARTIFICIAL_ANALYSIS_API_KEY`, or `~/.config/artificial-analysis/api-key` (mode 0600). Never print, echo or paste the key. If the script exits with code 2, tell the user how to add a key and stop; do not fall back to guessing scores from memory.

The free tier allows about 100 requests a day. The script caches the full model list for 12 hours, so later commands cost nothing. Use `refresh` only when freshness matters.

## Attribution and terms

Artificial Analysis free-tier data is for internal use with attribution. Credit "Artificial Analysis" when reporting its numbers, and do not republish or bulk-redistribute the data.

## Commands

Run from the skill directory (or use its absolute path):

```sh
node scripts/aa.mjs list --sort coding --limit 15
node scripts/aa.mjs list --creator anthropic --sort agentic
node scripts/aa.mjs get <slug-or-name-fragment>
node scripts/aa.mjs compare <model-a> <model-b> <model-c>
```

Sorts: `intelligence`, `coding`, `agentic`, `price`, `speed`, `ttft`, `cost` (cost to run the whole index). Add `--json` to `list`, or `--raw` to `get`, for all fields. Names are matched by fragment; an ambiguous `get` lists the candidates.

Output fields: Intelligence, Coding, Agentic and Math indices, input and output price per 1M tokens, median tokens per second, median time to first token, and the cost to run the Intelligence Index.

## Answering a model question

1. **Clarify the need.** Work out what matters for the task: raw quality, coding, agentic tool use, price, latency, or context size. If it's unclear, state the assumption you made.
2. **Pull data.** Use `list --sort <metric>` to find strong candidates, then `compare` the shortlist (include the model currently in use, if there is one). Add models.dev specs when context window, tool calling or modalities could rule a model out.
3. **Weigh metrics to match the use.** Typical choices:
   - Hard reasoning or review: Intelligence.
   - Writing or changing code: Coding, then Agentic.
   - Autonomous multi-step tool use: Agentic.
   - High-volume or cheap background work: price and speed, with Intelligence only as a minimum bar.
   - Interactive use: time to first token and speed matter alongside quality.
4. **Recommend.** Give a short table of the candidates with the numbers that drove the choice, a pick with the trade-offs, and a confidence note. If the current choice is already near the top, say to keep it.

## Rules for conclusions

- Benchmarks are independent but generic. Say when a recommendation extrapolates, for example using the Coding index for a repo-specific job. For a high-stakes decision, suggest a short trial on a real task.
- A gap of a couple of index points is noise; prefer the cheaper, faster or already trusted model.
- Don't compare scores across different Intelligence Index versions. The API reports `intelligence_index_version`.
- Artificial Analysis often has one entry per reasoning setting, and its names differ from provider model ids. Match carefully and say so if the mapping is uncertain.
- A `null` metric means it isn't in the free tier, not zero. Per-benchmark scores (for example Terminal-Bench) need the Pro tier.
- Keep answers short: one table plus a recommendation.
