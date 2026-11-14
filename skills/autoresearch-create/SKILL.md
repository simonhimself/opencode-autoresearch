---
name: autoresearch-create
description: Set up and run an autonomous experiment loop for any measurable target (test speed, bundle size, build time, training loss…). Gathers what to optimize, writes the .auto/ session files, then loops - change, look, propose - while the plugin measures each change against the last commit in back-to-back pairs, commits what an exact test confirms and reverts the rest. Use when asked to "run autoresearch", "optimize X in a loop", or "start experiments".
---

# Autoresearch

An experiment loop: change the code, take a first look, propose what looks better; the plugin keeps what it can confirm and reverts the rest. Repeat.

**You propose, the plugin decides.** You choose what to try and which changes to propose. The plugin measures, decides whether a gain is real, and does every commit and revert. You can't type in a result or pick the benchmark command. The tools reject arguments they don't have (`command`, `repeat`, `metric`…) with an error.

Based on pi-autoresearch (https://github.com/davebcn87/pi-autoresearch).

## Tools

The tools only work while the user has the loop on (`/autoresearch <goal>`), and only on the experiment branch.

- **`autoresearch_init`** `{ name, metric_name, metric_unit?, direction, repeat? }`: starts a *segment* of comparable runs and freezes how they're measured: `.auto/measure.sh`, `.auto/checks.sh` and every helper file under `.auto/` are hashed, and `repeat` (default 5) fixes the mode: 3 or more is standard mode, 1–2 is slow mode (see "Modes"). Needs a branch that isn't main/master, a clean working tree, and an executable `.auto/measure.sh` that is committed (so is `checks.sh`, if there is one).
- **`autoresearch_run`** `{ timeout_seconds?, checks_timeout_seconds? }`: the **first look** at your change. It measures 3 back-to-back *pairs* (one benchmark run of the last commit, one of your change), then runs `./.auto/checks.sh` if it exists, and tells you whether the change looks better, about equal or worse, and what to log. The first run of a segment measures the baseline instead: the unchanged code, `repeat` times. Without a code change it refuses: there is nothing to compare. There is no `command` parameter.
- **`autoresearch_log`** `{ status, description, asi?, simplification? }`: records the last run. One log per run. The plugin fills in the numbers itself.
  - `keep`: a proposal. The plugin measures 8 fresh pairs (8 more when those are promising but not conclusive) and applies an exact statistical test to them. Confirmed: it commits your change. Not confirmed: it reverts your change and logs a discard with a note.
  - `discard`, `crash`, `checks_failed`: reverts the code to the last commit (staged, unstaged and untracked changes; `.auto/` is left alone) and logs it.
- **`autoresearch_pause`** `{ reason }`: turns the loop off and shows the user your reason. This is how you stop.

If a tool answers with `ERROR`, nothing was logged or changed. Read the message; it says what to do.

## Session files (`.auto/` in the project folder)

| File | Purpose |
|------|---------|
| `.auto/prompt.md` | The playbook. A fresh agent must be able to resume from this alone. |
| `.auto/measure.sh` | The benchmark. Prints `METRIC name=value` lines. Frozen per segment, committed. |
| `.auto/checks.sh` | Correctness checks: tests, types, lint. Frozen per segment, committed. |
| anything else under `.auto/` | Helper files of the benchmark (a workload size, input data, a script it sources). Frozen per segment like the benchmark itself. |
| `.auto/log.jsonl` | Every run, written by the tools. Don't edit. |
| `.auto/ideas.md` | Ideas backlog (optional). |
| `.auto/config.json` | Limits (optional): `{ "maxIterations": 50, "maxNoImprovement": 10, "minImprovement": 0.01 }`. These are the defaults. `minImprovement` is the most a simplification may cost, and the gain a keep needs in slow mode. |

Only `prompt.md`, `ideas.md` and `config.json` may change during a segment (and `log.jsonl`, by the tools). Every other file under `.auto/` is benchmark input: if one is added, edited or removed, `autoresearch_run` refuses.

## Setup

`/autoresearch` only starts when the project is a git repository with at least one commit and no uncommitted changes. If the user still has to do that, they've been told; don't work around it. On the main branch, when an `autoresearch/*` branch already holds a session for this folder, it doesn't start a second setup: it names the branch to switch to.

1. Ask (or infer): **Goal**, **Workload** (what gets measured), **Metric** and direction, **Files in scope**, **Constraints**. Ask what you can't infer, then wait for the answer.
2. Create the experiment branch: `git switch -c autoresearch/<goal>-<date>`. `autoresearch_init` refuses on main/master.
3. Read the source. Understand the workload before writing anything.
4. Write `.auto/prompt.md`, `.auto/measure.sh` and, if the project has tests, `.auto/checks.sh`. `chmod +x` both scripts. Helper files the benchmark reads go under `.auto/` too.
5. Commit exactly those files (leave out `checks.sh` if you didn't create one, add your helper files): `git add .auto/prompt.md .auto/measure.sh .auto/checks.sh && git commit -m "autoresearch: session setup"`. `autoresearch_init` refuses while `measure.sh` or `checks.sh` have uncommitted changes, so the benchmark of every segment is in git for the user to review. Besides a later benchmark change (see "The benchmark is frozen"), this is the only commit you make yourself.
6. `autoresearch_init`, then `autoresearch_run` (the baseline: unchanged code, with one uncounted warm-up run), then `autoresearch_log` with `keep`. Then start experimenting. The baseline's numbers are for orientation; no later decision uses them.

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
`.auto/measure.sh`, `.auto/checks.sh` and the benchmark's helper files under `.auto/` are frozen; a change to them starts a new segment the user sees.

## What's Been Tried
<Keep this updated: key wins, insights, dead ends and why they failed.>
```

### `.auto/measure.sh`

`#!/bin/bash` and `set -euo pipefail`. Run the workload, print `METRIC <name>=<number>` for the primary metric (and any secondary ones), exit non-zero on failure.

- **It must measure the real workload.** A benchmark that's fast because it does less is worthless.
- **It must not write into the project, and not under `.auto/`.** Put output files in a gitignored path or outside the project (`"$TMPDIR"`). If the benchmark changes tracked or untracked project files, a keep is refused, because the committed code would differ from the measured code. If it writes under `.auto/`, it changes its own frozen inputs: the run says so, and neither a keep nor the next run is accepted.
- **Anything it reads must be frozen or committed.** Workload sizes, input data and scripts it sources belong in the project (tracked) or under `.auto/`. Don't make it read gitignored files you could edit: that's the same cheat as editing the benchmark.
- **Time only the workload.** If the script builds or compiles, do that first and start the clock afterwards. Between the two runs of every pair the plugin swaps the changed files (they get new timestamps, as after `git checkout`), so the run right after a swap would pay for the rebuild. A rebuild inside the timed part can't produce a false keep, but it hides every gain smaller than itself; `autoresearch_log` tells you when the pairs show that pattern.
- **It runs many times, on the last commit too.** A first look is 6 benchmark runs and a proposed keep 16 to 32, half of them on the last commit. Keep one run short where the workload allows. Build outputs belong in gitignored folders, which the swap leaves alone.
- **Choose `repeat` at init** (see "Modes"): leave the default 5 unless one run takes minutes.
- Print anything that helps you decide what to try next (phase timings, counts); only `METRIC` lines are parsed.
- **Print the `METRIC` lines last.** Only the last 1 MB of a run's output is kept, and you only see its last 80 lines.

### `.auto/checks.sh`

Create it whenever the project has tests, a type checker or a linter, even if the user didn't ask: without it, a "faster" change that breaks the code would be kept. `#!/bin/bash`, `set -euo pipefail`, run the checks, keep the output quiet (errors only). It runs after every measurement that succeeded; when it fails, the run can only be logged as `checks_failed`. Like the benchmark, it must not leave files in the project: make sure test caches and coverage output are gitignored.

If the project has no tests, say so to the user during setup and note it in prompt.md.

## The loop

One experiment is: change code → `autoresearch_run` → `autoresearch_log`. Don't touch any file between run and log, or while either tool runs: a keep is refused when the code differs from what was measured.

### Why everything is measured in pairs

The same code measures differently minutes apart (10 % and more on a busy machine), so a number from the log, or from the baseline, says nothing about a number from now. The plugin therefore never compares across time. Every comparison is a **pair**: one benchmark run of the last commit and one of your change, back to back, with the order inside the pairs alternating (last commit first, then your change first, and so on). A load burst or a drift hits both runs of a pair alike. A pair's result is the relative difference of its two runs.

To measure a pair the plugin swaps the project's files to the last commit and back (only the files your change touches; gitignored files and `.auto/` never). It checks the files after every swap and puts your change back whatever happens. If a measurement is cut off (a crash, a restart), the next tool call or `/autoresearch` puts your change back first and tells you. A file you edit while a tool runs is never overwritten, but the measurement fails and the loop pauses until the edit is out of the way.

### The first look (`autoresearch_run`)

3 pairs = 6 benchmark runs, then the checks. You get each pair's two numbers and the median difference, with one of three verdicts:

- **Looks better** → propose it: log `keep`.
- **Looks about equal** or **looks worse** → log `discard`. (A `keep` is refused when the look doesn't say better.)

It is a rough look, not a result: the median of 3 pairs is often off by a few percent, in either direction.

### The decision (`autoresearch_log` with `keep`)

The plugin measures **8 fresh pairs** (16 benchmark runs) and applies an exact paired test (Wilcoxon signed-rank, one-sided) to their differences. The look's pairs are never reused: you proposed because of them, so they are biased.

- Clearly better (p ≤ 0.005; with 8 pairs that means better in all 8) → confirmed, committed.
- Clearly not (p > 0.25) → not confirmed: reverted and logged as a discard with a note.
- In between → **8 more pairs** (16 more runs); all 16 are tested together and must reach p ≤ 0.005.

A change that does nothing is kept at most 1 % of the time, whatever the noise looks like. The price is that small gains on a noisy benchmark are often not confirmed: with ±2 % noise per run a 3 % gain is practically always confirmed, a 1 % gain about one time in three. On a machine with heavy load bursts even larger gains can fail. That is the system working, not a failure. Don't retry the same change hoping for a luckier draw; if you believe in an idea, make the gain bigger.

**When to propose.** Propose a `keep` whenever the look says better. Proposing costs benchmark time, never truth: the plugin decides on fresh numbers, and a proposal that isn't confirmed is logged as one discarded run, exactly like a discard you log yourself. So there is nothing to gain from being cautious on your own judgment, and nothing from proposing what the look calls equal or worse (it is refused). The one reason to hold back is time: when a single benchmark run is long and the look's gain is tiny with one pair pointing the other way, `discard` and move on.

**What to log otherwise**

- The change **removes more lines than it adds**, and the look says about equal → log `keep` with `simplification: true`. The plugin checks the diff: without a net deletion the flag is refused. It measures 8 pairs and keeps the change unless it is measurably worse than the last commit (the same test in the other direction, p ≤ 0.05) or its median is worse by more than `minImprovement` (1 %). A simplification is kept for being simpler; it counts as a kept experiment but adds nothing to the progress number. It isn't a way to keep a performance change whose look didn't say better; log that as `discard`.
- The benchmark failed → fix it if the mistake is trivial and run again, otherwise log `crash`.
- Checks failed → fix and run again, or log `checks_failed`.
- The benchmark failed **on the last commit** (the tool says so; your change is put back and nothing is logged) → call the same tool again if the benchmark is flaky. If it really fails without your change, log `discard` and `autoresearch_pause`.

### What it costs, in benchmark runs

| | Standard mode | Slow mode (`repeat` 1–2) |
|---|---|---|
| Baseline (once per segment) | 1 warm-up + `repeat` | 1 warm-up + `repeat` |
| First look | 6 (3 pairs) | 2 (1 pair) |
| Proposed keep | 16 (8 pairs), or 32 when extended | 2 × `repeat` |

Half of these runs are on the last commit. The checks run once per look, on your change.

### Modes

- **Standard** (`repeat` 3 or more; the default is 5): everything above. Use it whenever one benchmark run takes less than about a minute.
- **Slow** (`repeat` 1 or 2): only for benchmarks where one run takes minutes. A look is 1 pair; a proposed keep is decided on `repeat` fresh pairs and needs **every** pair better and a median gain of at least `minImprovement` (1 %). There is **no statistical check** in this mode: with so few runs a lucky draw can be kept. The tools and `/autoresearch status` say so. Tell the user when you choose it, and say it again when you report results.

### Reporting progress

After every log the tool gives you the sentence to use, for example:

> 12.4% lower than the baseline, the compounded result of 3 confirmed keeps (not a ratio of raw numbers)

(For a higher-is-better metric it says "higher". If the keeps net out worse, it says so: "… higher than the baseline (worse)".)

Use that sentence, in those words, whenever you state how far the session has come (to the user, in prompt.md, in a summary). It is built from the kept experiments, each measured against HEAD in its own pairs: every keep multiplies the level by its candidate ÷ HEAD ratio, so two 10 % reductions read "19.0% lower", not 20 % or 21 %. **Never quote a ratio or a difference of absolute numbers measured at different times**, such as "baseline 4.2 s, now 3.6 s, so 14 % faster": the baseline was measured hours ago on a machine in a different state, and that calculation is wrong. The tools show the baseline and current values only for orientation, labelled as not comparable. "Kept" never counts the baseline, and simplifications don't add to the gain.

**Always pass `asi`**: what you *learned*, not what you did, e.g. `{ "hypothesis": "...", "learned": "...", "next_focus": "..." }`. A reverted experiment leaves no code behind; the log is the only record it existed.

**More rules**

- Every candidate is compared with *current*: the last keep, which always equals the code at the last commit, measured fresh next to it. There is no separate "best".
- Git belongs to the plugin. After setup, never commit, stash, reset, check out or switch branches yourself (one exception: committing a benchmark change right before `autoresearch_init`, below). If the branch or HEAD changes underneath, the tools pause the loop.
- Don't loop on one idea. Reverted three variants of it? Try something structurally different.
- Update "What's Been Tried" in `.auto/prompt.md` every few runs. Put ideas for later in `.auto/ideas.md`. Don't commit these edits; the plugin leaves `.auto/` uncommitted on purpose and finalize deals with it.
- Descriptions are plain text; backticks and `$()` are stored as written.
- Don't ask "should I continue?". The plugin sends the next turn's prompt itself while the loop is on.

## The benchmark is frozen

`autoresearch_run` refuses when `.auto/measure.sh`, `.auto/checks.sh` or any helper file under `.auto/` (everything except `log.jsonl`, `ideas.md`, `config.json` and `prompt.md`) differs from what the segment started with. This is on purpose: numbers from different benchmarks can't be compared, and a benchmark edited mid-experiment, or a workload file made smaller, is the easiest way to fake a gain.

To change it legitimately (the workload was wrong, a new check is needed, more diagnostics):

1. Finish or discard the current experiment, so the code equals the last commit.
2. Edit the file.
3. Commit that edit, and only it: `git add .auto/measure.sh && git commit -m "autoresearch: benchmark: <why>"`. `autoresearch_init` refuses uncommitted changes to `measure.sh` or `checks.sh`.
4. Call `autoresearch_init` again. This starts a new segment with its own baseline; the user sees it in the log and on the dashboard.
5. Say why in the description of the new baseline's log entry and in prompt.md.

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
- **A tool call ends in a permission error or rejection** (whatever its wording: "Permission denied", or the user's own message when they reject a prompt). A permission rule or the user blocks that command. Say which command; don't retry and don't work around it with other tools.
- **Something looks wrong with the repository**: uncommitted changes you didn't make, a revert that failed. Don't clean up yourself; the changes may be the user's work.

The plugin also stops the loop on its own: at `maxIterations`, after `maxNoImprovement` runs in a row without a keep (counted since the loop was last started, so the number restarts at 0 after every `/autoresearch`), after three turns without a logged run, and when the user says so. When a tool answers `STOP`, summarize the results for the user and end your turn.

## Resuming

If `.auto/prompt.md` exists, the session is already set up: read it, the last ~20 lines of `.auto/log.jsonl`, `.auto/ideas.md` and `git log --oneline -20`, then continue with the next experiment. Don't call `autoresearch_init` again unless the benchmark has to change.

## Messages from the user during the loop

If the user writes while an experiment is in progress, finish the current `autoresearch_run` + `autoresearch_log` first. Then apply their note from the next experiment on, and add it to `.auto/prompt.md` if it's a lasting rule ("don't touch X").
