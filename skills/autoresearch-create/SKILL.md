---
name: autoresearch-create
description: Set up and run an autonomous experiment loop for any measurable target (test speed, bundle size, build time, training loss…). Gathers what to optimize, writes the .auto/ session files, then loops - change, measure, log - while the plugin confirms and commits real gains and reverts the rest. Use when asked to "run autoresearch", "optimize X in a loop", or "start experiments".
---

# Autoresearch

An experiment loop: change the code, measure it, keep what is confirmed to be better, revert the rest, repeat.

**You propose, the plugin decides.** You choose what to try and say what you think the result means. The plugin measures, decides whether a gain is real, and does every commit and revert. You can't type in a result or pick the benchmark command.

Based on pi-autoresearch (https://github.com/davebcn87/pi-autoresearch).

## Tools

The tools only work while the user has the loop on (`/autoresearch <goal>`), and only on the experiment branch.

- **`autoresearch_init`** `{ name, metric_name, metric_unit?, direction, repeat? }`: starts a *segment* of comparable runs and freezes how they're measured: `.auto/measure.sh` and `.auto/checks.sh` are hashed, and `repeat` (default 5) is fixed. Needs a branch that isn't main/master, a clean working tree and an executable `.auto/measure.sh`.
- **`autoresearch_run`** `{ timeout_seconds?, checks_timeout_seconds? }`: runs `./.auto/measure.sh` `repeat` times, takes the median, then runs `./.auto/checks.sh` if it exists. It tells you how the result compares with *current* (the last kept state) and what to log. There is no `command` parameter.
- **`autoresearch_log`** `{ status, description, asi?, simplification? }`: records the last run. One log per run. The plugin fills in the numbers itself.
  - `keep`: a proposal. The plugin measures `repeat` more times and compares those fresh numbers with current. Confirmed: it commits your change. Not confirmed: it reverts your change and logs a discard with a note.
  - `discard`, `crash`, `checks_failed`: reverts the code to the last commit (staged, unstaged and untracked changes; `.auto/` is left alone) and logs it.
- **`autoresearch_pause`** `{ reason }`: turns the loop off and shows the user your reason. This is how you stop.

If a tool answers with `ERROR`, nothing was logged or changed. Read the message; it says what to do.

## Session files (`.auto/` in the project folder)

| File | Purpose |
|------|---------|
| `.auto/prompt.md` | The playbook. A fresh agent must be able to resume from this alone. |
| `.auto/measure.sh` | The benchmark. Prints `METRIC name=value` lines. Frozen per segment. |
| `.auto/checks.sh` | Correctness checks: tests, types, lint. Frozen per segment. |
| `.auto/log.jsonl` | Every run, written by the tools. Don't edit. |
| `.auto/ideas.md` | Ideas backlog (optional). |
| `.auto/config.json` | Limits (optional): `{ "maxIterations": 50, "maxNoImprovement": 10, "minImprovement": 0.01 }`. These are the defaults. |

## Setup

`/autoresearch` only starts when the project is a git repository with at least one commit and no uncommitted changes. If the user still has to do that, they've been told; don't work around it.

1. Ask (or infer): **Goal**, **Workload** (what gets measured), **Metric** and direction, **Files in scope**, **Constraints**. Ask what you can't infer, then wait for the answer.
2. Create the experiment branch: `git switch -c autoresearch/<goal>-<date>`. `autoresearch_init` refuses on main/master.
3. Read the source. Understand the workload before writing anything.
4. Write `.auto/prompt.md`, `.auto/measure.sh` and, if the project has tests, `.auto/checks.sh`. `chmod +x` both scripts.
5. Commit exactly those files (leave out `checks.sh` if you didn't create one): `git add .auto/prompt.md .auto/measure.sh .auto/checks.sh && git commit -m "autoresearch: session setup"`. This is the only commit you make yourself.
6. `autoresearch_init`, then `autoresearch_run` (the baseline: unchanged code, with one uncounted warm-up run), then `autoresearch_log` with `keep`. Then start experimenting.

### `.auto/prompt.md`

```markdown
# Autoresearch: <goal>

## Objective
<What we're optimizing, and the workload that represents it.>

## Metrics
- **Primary**: <name> (<unit>, lower/higher is better)
- **Secondary**: <name>, ... (tradeoff monitors)

## How to Run
`./.auto/measure.sh` prints `METRIC name=number` lines. Checks: `./.auto/checks.sh`.

## Files in Scope
<Every file you may modify, with a short note on each.>

## Off Limits
<What must not be touched.>

## Constraints
<Hard rules: tests must pass, no new dependencies, public API unchanged, etc.>

## What counts as cheating
The goal is to make the real thing better, not the number. Never:
- shrink the workload or special-case the benchmark's inputs
- edit the benchmark to print better numbers
- cache results between runs so later runs skip the work
- remove or weaken tests or checks
- hard-code the benchmark's inputs or expected outputs
`.auto/measure.sh` and `.auto/checks.sh` are frozen; a change to them starts a new segment the user sees.

## What's Been Tried
<Keep this updated: key wins, insights, dead ends and why they failed.>
```

### `.auto/measure.sh`

`#!/bin/bash` and `set -euo pipefail`. Run the workload, print `METRIC <name>=<number>` for the primary metric (and any secondary ones), exit non-zero on failure.

- **It must measure the real workload.** A benchmark that's fast because it does less is worthless.
- **It must not write into the project.** Put output files under `.auto/` or in a gitignored path. If the benchmark changes tracked or untracked project files, a keep is refused, because the committed code would differ from the measured code.
- **It runs many times.** Each measurement is `repeat` runs, and every proposed keep is measured twice. Keep one run short where the workload allows.
- **Choose `repeat` at init.** 5 (the default) or more for anything under about a minute. With 3 or more runs the plugin estimates the noise from the spread, and a gain must clear it. Use 1 or 2 only when a single run takes minutes; then there's no noise estimate and a keep needs at least `minImprovement` (1 %) in both measurements.
- Print anything that helps you decide what to try next (phase timings, counts); only `METRIC` lines are parsed.
- **Print the `METRIC` lines last.** Only the last 1 MB of a run's output is kept, and you only see its last 80 lines.

### `.auto/checks.sh`

Create it whenever the project has tests, a type checker or a linter, even if the user didn't ask: without it, a "faster" change that breaks the code would be kept. `#!/bin/bash`, `set -euo pipefail`, run the checks, keep the output quiet (errors only). It runs after every measurement that succeeded; when it fails, the run can only be logged as `checks_failed`. Like the benchmark, it must not leave files in the project: make sure test caches and coverage output are gitignored.

If the project has no tests, say so to the user during setup and note it in prompt.md.

## The loop

One experiment is: change code → `autoresearch_run` → `autoresearch_log`. Don't touch any file between run and log: a keep is refused when the code differs from what was measured.

**What to log**

- The run says "better" → log `keep`. Don't decide yourself whether it's real; the plugin re-measures and judges. If it isn't confirmed, your change is reverted and logged as a discard. That's the system working, not a failure. Don't retry the same change hoping for a luckier draw.
- Not better → log `discard`.
- The change removes code or makes it simpler, and performance is about equal → log `keep` with `simplification: true`. It's kept when the re-measurement shows it's not worse than current beyond the noise.
- The benchmark failed → fix it if the mistake is trivial and run again, otherwise log `crash`.
- Checks failed → fix and run again, or log `checks_failed`.

**Always pass `asi`**: what you *learned*, not what you did, e.g. `{ "hypothesis": "...", "learned": "...", "next_focus": "..." }`. A reverted experiment leaves no code behind; the log is the only record it existed.

**More rules**

- Compare with *current*, which is the last keep and always equals the code at HEAD. There is no separate "best".
- Git belongs to the plugin. After setup, never commit, stash, reset, check out or switch branches yourself. If the branch or HEAD changes underneath, the tools pause the loop.
- Don't loop on one idea. Reverted three variants of it? Try something structurally different.
- Update "What's Been Tried" in `.auto/prompt.md` every few runs. Put ideas for later in `.auto/ideas.md`. Don't commit these edits; the plugin leaves `.auto/` uncommitted on purpose and finalize deals with it.
- Descriptions are plain text; backticks and `$()` are stored as written.
- Don't ask "should I continue?". The plugin sends the next turn's prompt itself while the loop is on.

## The benchmark is frozen

`autoresearch_run` refuses when `.auto/measure.sh` or `.auto/checks.sh` differ from what the segment started with. This is on purpose: numbers from different benchmarks can't be compared, and a benchmark edited mid-experiment is the easiest way to fake a gain.

To change it legitimately (the workload was wrong, a new check is needed, more diagnostics):

1. Finish or discard the current experiment, so the code equals the last commit.
2. Edit the file. Don't commit it.
3. Call `autoresearch_init` again. This starts a new segment with its own baseline; the user sees it in the log and on the dashboard.
4. Say why in the description of the new baseline's log entry and in prompt.md.

The run limit (`maxIterations`) counts all segments.

## What counts as cheating

The user wants the real thing to be better. A better number that doesn't mean that is worse than no result. Never:

- **Shrink or special-case the workload**: fewer iterations, smaller inputs, skipping work when the code detects it's being benchmarked.
- **Edit the benchmark to print better numbers**: changing what's timed, the formula, the units, or the checks' pass criteria.
- **Cache results between runs**: a cache that survives from one benchmark run to the next makes later runs measure a lookup instead of the work. (Caching inside one run, where real use would also benefit, is a normal optimization.)
- **Remove or weaken tests or checks**: deleting a failing test, loosening an assertion, catching and hiding an error.
- **Hard-code benchmark inputs or outputs**: a fast path for exactly the data the benchmark uses.

Not sure whether an idea crosses the line? Don't do it silently: `autoresearch_pause` and ask.

## When to stop, and how

Call `autoresearch_pause` with a clear reason for the user when:

- **You're out of promising ideas.** Don't run filler experiments; they waste the budget and only add noise.
- **You need the user**: a decision, a missing dependency, something off limits that blocks every remaining idea.
- **The baseline fails.** The baseline is measured on unchanged code, so you can't fix project code first. If `measure.sh` is at fault, fix it and call `autoresearch_init` again. If the project itself is broken at the last commit, pause and tell the user what fails.
- **A tool says "Permission denied".** A permission rule blocks that command. Say which command; don't retry and don't work around it with other tools.
- **Something looks wrong with the repository**: uncommitted changes you didn't make, a revert that failed. Don't clean up yourself; the changes may be the user's work.

The plugin also stops the loop on its own: at `maxIterations`, after `maxNoImprovement` runs in a row without a keep, after three turns without a logged run, and when the user says so. When a tool answers `STOP`, summarize the results for the user and end your turn.

## Resuming

If `.auto/prompt.md` exists, the session is already set up: read it, the last ~20 lines of `.auto/log.jsonl`, `.auto/ideas.md` and `git log --oneline -20`, then continue with the next experiment. Don't call `autoresearch_init` again unless the benchmark has to change.

## Messages from the user during the loop

If the user writes while an experiment is in progress, finish the current `autoresearch_run` + `autoresearch_log` first. Then apply their note from the next experiment on, and add it to `.auto/prompt.md` if it's a lasting rule ("don't touch X").
