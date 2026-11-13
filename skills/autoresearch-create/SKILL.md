---
name: autoresearch-create
description: Set up and run an autonomous experiment loop for any optimization target (test speed, bundle size, build time, training loss…). Gathers what to optimize, writes .auto/ session files, then starts looping. Use when asked to "run autoresearch", "optimize X in a loop", or "start experiments".
---

# Autoresearch

Autonomous experiment loop: try an idea, measure it, keep what works, discard what doesn't, repeat.
Adapted from pi-autoresearch (https://github.com/davebcn87/pi-autoresearch).

## Tools

- **`autoresearch_init`**: configure the session (name, metric, unit, direction). Call again to start a new segment with a fresh baseline when the target changes.
- **`autoresearch_run`**: runs `./.auto/measure.sh` (or a given command), parses `METRIC name=value` lines, runs `.auto/checks.sh` if present. With `repeat` ≥ 3 it runs the benchmark that many times, uses the median and measures the noise, which the confidence score needs.
- **`autoresearch_log`**: records the result of the last `autoresearch_run`, exactly once. `keep` commits your code changes (never `.auto/`) and only works for a successful run with the measured metric value. `discard` / `crash` / `checks_failed` revert everything to the last commit (staged, unstaged and untracked changes), but `.auto/` is preserved. Always pass `asi`. If it returns an ERROR, nothing was logged: fix the cause and log again.

## Session files (`.auto/` at the project root)

| File | Purpose |
|------|---------|
| `.auto/prompt.md` | The session playbook. A fresh agent must be able to resume from this alone. |
| `.auto/measure.sh` | Benchmark script; prints `METRIC name=value` lines. |
| `.auto/log.jsonl` | Append-only result log (written by the tools, don't edit). |
| `.auto/ideas.md` | Ideas backlog (optional). |
| `.auto/checks.sh` | Correctness checks: tests, types, lint (optional). |
| `.auto/config.json` | `{ "maxIterations": 50 }` (optional): the most runs in total, across segments, baseline included. |

## Setup

1. Ask (or infer): **Goal**, **Command**, **Metric** (+ direction), **Files in scope**, **Constraints**.
2. Check `git status` is clean. If not, stop and ask the user: discarding experiments runs `git clean`, which would delete their untracked files.
3. `git checkout -b autoresearch/<goal>-<date>`. Never loop on the user's main branch.
4. Read the source files. Understand the workload deeply before writing anything.
5. `mkdir -p .auto`, write `.auto/prompt.md` and `.auto/measure.sh` (`chmod +x`). Commit both.
6. `autoresearch_init` → `autoresearch_run` (baseline) → `autoresearch_log` with `keep` → start looping immediately.

### `.auto/prompt.md`

```markdown
# Autoresearch: <goal>

## Objective
<What we're optimizing and the workload.>

## Metrics
- **Primary**: <name> (<unit>, lower/higher is better)
- **Secondary**: <name>, ... (tradeoff monitors)

## How to Run
`./.auto/measure.sh` prints `METRIC name=number` lines.

## Files in Scope
<Every file you may modify, with a short note on each.>

## Off Limits
<What must not be touched.>

## Constraints
<Hard rules: tests must pass, no new deps, etc.>

## What's Been Tried
<Keep this updated: key wins, insights, dead ends and why they failed.>
```

### `.auto/measure.sh`

`#!/bin/bash` + `set -euo pipefail`. Fail fast on obvious errors, run the workload, print `METRIC` lines. Keep it fast; it runs hundreds of times.

- For benchmarks under ~10 s, call `autoresearch_run` with `repeat: 5` (or 3–7). The plugin takes the median and measures the noise from the spread, which is what the confidence score is based on. Without repeats there's no noise measurement and no confidence score. Slow workloads (training runs, big builds) can use `repeat: 1`.
- Print whatever helps you decide what to try next: phase timings, error counts, cache hit rates, etc. You may extend the script mid-session.
- **If you change how the metric is measured** (more repetitions, a different workload, a new timer), earlier numbers are no longer comparable: call `autoresearch_init` again to start a new segment with a fresh baseline. Adding extra output lines is fine without that.

### `.auto/checks.sh` (optional)

Only create it when the user's constraints need correctness checks. It runs after every passing benchmark; if it fails you must log `checks_failed` (you can't `keep`). Keep its output quiet: only errors.

## Loop rules

**Loop until stopped.** Don't ask "should I continue?". The user expects autonomous work, and the plugin re-prompts you after each turn while the loop is on.

- **The primary metric decides.** Better → `keep`. Worse or equal → `discard`.
- **Annotate every run with `asi`**: what you *learned*, not what you did. Discarded runs are reverted; the log is the only record they existed.
- **Watch confidence.** With repeats, `autoresearch_log` reports how the best gain compares to the measured noise. Below 1.0× means it's within noise, so re-run before trusting it.
- **Simpler is better.** Removing code at equal performance = keep. Ugly complexity for a tiny gain = discard.
- **Don't thrash.** Reverting the same idea repeatedly? Try something structurally different.
- **Crashes:** fix if trivial, otherwise log `crash` and move on.
- **Update `.auto/prompt.md` → "What's Been Tried"** every few runs. After setup, don't commit `.auto/` changes yourself; the plugin leaves them uncommitted on purpose and finalize handles them.
- **Descriptions are plain text.** Backticks are fine; they're stored as written.
- **Ideas backlog:** append promising-but-later ideas to `.auto/ideas.md`.
- **Resuming:** if `.auto/prompt.md` exists, read it, the tail of `.auto/log.jsonl`, and `git log`, then continue.
- **If `autoresearch_run` says STOP** (maxIterations), summarize the results for the user and stop. The limit counts all runs; starting a new segment doesn't reset it.
- **Log the exact metric** `autoresearch_run` shows (it prints "To keep this result, log metric=…").

## Messages from the user during the loop

If the user writes while an experiment is in progress, finish the current `autoresearch_run` + `autoresearch_log` first. Then apply their note from the next experiment on, and add it to `.auto/prompt.md` if it's a lasting rule ("don't touch X"). Don't abandon a running experiment.
