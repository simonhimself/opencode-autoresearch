# Design: trustworthy results (v0.2)

This plugin is for OpenCode v2 only. There is no pi-autoresearch compatibility: remove any code,
option or text that exists only for pi (legacy flat `autoresearch.*` files, the `export` alias,
"portable sessions" claims, tolerance for pi's log entries). Keep the MIT credit for the parts
adapted from pi (THIRD_PARTY_NOTICES.md, the header of finalize.sh).

## Objective

Let an agent improve a measurable property of a codebase unattended for hours. The value rests on:

1. **Truth.** A keep is a real improvement, measured on exactly the code that was committed.
2. **Safety.** The user's repo and uncommitted work can't be damaged.
3. **Robustness.** The loop doesn't stall, spin, burn tokens or stop silently.
4. **Incentives.** The agent is steered toward real research, and can't game the metric unnoticed.

Rule of thumb for every decision: **the plugin decides, the agent proposes.** Anything that matters
is enforced in code; skill text only explains.

## Terms

- **Segment**: runs that are comparable. Started by `autoresearch_init`. Fixes the benchmark
  (hash of `.auto/measure.sh`, hash of `.auto/checks.sh` or null) and `repeat`.
- **Baseline**: the first run of a segment. Always a keep, measured on a clean tree (no diff to HEAD).
- **Current**: the last keep of the segment. It describes HEAD. Every candidate is compared with
  current, so HEAD is always the best known state. ("best" = current.)
- **Scope**: the session folder minus any `.auto` folder (`SCOPE` in shell.ts).

## Tools (namespace `autoresearch`)

All three experiment tools refuse unless the loop is on for this session (`active/<sid>` exists and
its directory is the session's). They also refuse when the current branch or HEAD differs from what
the loop state recorded (someone switched branches or committed underneath): the loop is paused
and the user told.

### `autoresearch_init { name, metric_name, metric_unit?, direction, repeat? }`

- Preflight (refuse with a clear message): repo has commits; current branch is not trunk
  (`main`, `master`, or `origin/HEAD`'s branch); the scope has tracked files; the tree is clean
  outside `.auto/`; `.auto/measure.sh` exists and is executable.
- `repeat`: integer 1–50, default 5. Fixed for the segment.
- Writes the config entry (below). Clears any pending run. Records branch + HEAD in loop state.

### `autoresearch_run { timeout_seconds?, checks_timeout_seconds? }`

- No `command` and no `repeat` parameter: the benchmark is always `./.auto/measure.sh`, run
  `repeat` times as fixed by the segment.
- Refuses if the hash of measure.sh / checks.sh differs from the segment's config ("the benchmark
  changed: call autoresearch_init to start a new segment"), and at the run limit.
- If the segment has no runs yet (baseline): refuse unless the scope has no diff to HEAD; do one
  warm-up benchmark run that isn't counted.
- Runs the benchmark `repeat` times (stops at the first failure), then `./.auto/checks.sh` if it
  exists and all runs passed. Permission assert as today. One run at a time per project (lock).
- Stores the pending run in plugin storage: samples, median, secondary metric medians, exit state,
  checks result, timeouts used, segment, and a **fingerprint**: HEAD sha, branch, tree hash of the
  scope (temporary index: `GIT_INDEX_FILE=<tmp> git add -A <scope>` + `git write-tree`), hashes of
  measure.sh and checks.sh.
- Output: samples, median, noise, checks result, how it compares with current, and what
  `autoresearch_log` will do. Captured output is capped (1 MB per run, tail kept; lines over 2000
  characters are cut).

### `autoresearch_log { status, description, asi?, simplification? }`

`status`: `keep | discard | crash | checks_failed`. No `metric`/`metrics` inputs: the plugin records
what it measured. One log per run; one log at a time per project (lock).

- Any status: needs a completed pending run of the current segment.
- `discard | crash | checks_failed`: revert the scope to HEAD, log.
- `keep`:
  1. Refuse (nothing logged) if the run failed, timed out, had no metric or failed checks, or if
     the fingerprint no longer matches ("files changed since the measurement; run again").
  2. Baseline (first run of the segment): commit nothing (clean tree), log as keep with
     `baseline: true`.
  3. Otherwise refuse if the scope has no diff to HEAD.
  4. **Confirmation**: run the benchmark `repeat` more times on the same tree. These fresh samples
     are the candidate's official result (the first measurement was selected for looking good, so
     it's biased). Compare with current's samples using `judge()` (below).
  5. Confirmed → commit the scope, log keep with the confirmation samples.
     Not confirmed → **revert and log as discard** with a note (first value, confirmed value,
     current). A keep can't be retried on the same tree.
  6. `simplification: true` (less or simpler code at equal performance): confirmed when the
     candidate is not worse than current beyond the noise. Logged as keep with `neutral: true`.
- Experiment commits use `git -c commit.gpgsign=false commit --no-verify`: hooks and signing
  prompts hang or fail unattended. The user's hooks still apply to what they merge later.

### `autoresearch_pause { reason }`

The agent's way to stop: out of ideas, needs the user, blocked by a permission. Turns the loop
off and shows the reason to the user. The skill tells the agent to use it instead of filler
experiments.

## `judge()` (state.ts, pure, unit-tested)

Inputs: current samples, candidate (confirmation) samples, direction, `minImprovement`, `neutral`.

- `gain` = improvement of the candidate median over the current median, positive = better.
- With ≥ 3 samples on both sides: `sigma = 1.4826 × median(MAD(current), MAD(candidate))`,
  `se = 1.2533 × sigma × sqrt(1/n_current + 1/n_candidate)`.
  - `se == 0` (deterministic metric): confirmed when `gain > 0` (neutral: `gain >= 0`);
    confidence is reported as "exact".
  - else `confidence = gain / se`; confirmed when `confidence >= 2` (neutral: `>= -2`).
- With fewer than 3 samples on a side (slow workloads, `repeat` 1–2): no noise estimate. Confirmed
  when the gain is at least `minImprovement` (relative, default 1 %) in BOTH the first
  measurement and the confirmation (neutral: not worse by more than `minImprovement`).
- Returns `{ confirmed, gain, relGain, se, confidence, reason }`. `reason` is a sentence the tool
  shows the agent.

Confidence is per keep (this keep vs the state before it), never cumulative.

## Log format (`.auto/log.jsonl`, one JSON object per line)

```
{ type: "config", segment, name, metric_name, metric_unit, direction, repeat,
  measure_hash, checks_hash, timestamp }
{ type: "run", segment, run, status, metric, metrics, samples, noise,
  description, asi, commit, confidence,
  baseline?: true, neutral?: true,
  first_metric?,   // median of the first (pre-confirmation) measurement, for keeps
  vs?,             // current's metric this run was compared with
  note?,           // e.g. "keep not confirmed: first 95, confirmed 101, current 100"
  timestamp }
```

`metric` is the median of `samples`. For keeps, `samples` are the confirmation samples (the
baseline's are its only measurement). `confidence` is null for non-keeps and for "exact"/unknown.

## Settings (`.auto/config.json`)

| Key | Default | Meaning |
|---|---|---|
| `maxIterations` | 50 | Most logged runs in total (all segments). |
| `maxNoImprovement` | 10 | Pause after this many runs in a row without a (non-baseline) keep. |
| `minImprovement` | 0.01 | Relative gain needed when there are fewer than 3 samples. |

Invalid values produce a visible warning and fall back to the default.

## Loop control

- `/autoresearch <goal>` (start or resume) preflight: refuse when the tree outside `.auto/` has
  uncommitted changes, and on resume also when on trunk. Say exactly what to do.
- Loop state (`active/<sid>`): directory, setup flag, branch, head (updated after every log),
  run counters, stalls, consecutive provider failures.
- Setup mode (no `.auto/prompt.md` at start) ends as soon as prompt.md and a config entry exist;
  until then no nudges (the agent may be waiting for answers).
- The create skill is attached on resume too, and the pinned instruction carries a short rules
  block, so the rules survive compaction.
- Turn failed (provider error): retry by sending the continue after 30 s, 2 min, 5 min; after the
  third failure in a row pause and notify. Timers are cleared on plugin unload.
- Plugin start: for each active loop this instance owns, send one continue (queued) after a short
  delay, so a restart doesn't end an overnight run.
- Stops: `off`, interrupt, `autoresearch_pause`, `maxIterations`, `maxNoImprovement`, 3 turns
  without a logged run, branch/HEAD mismatch. Every stop tells the user why.

## git handling

- Argument lists only; messages via stdin (unchanged).
- Timeout 120 s; SIGTERM first, SIGKILL 5 s later (SIGKILL leaves `index.lock` behind); the error
  says "timed out".

## Compaction summary

`buildCompactionSummary(cwd, userMessages, live?: { workingTree?: string; pendingRun?: string })`

- Newest runs first; when over the cap, the oldest are dropped, never the newest or "Next step".
- prompt.md: when too long keep the head and the tail (rules and "What's Been Tried" sit last).
- All short `asi` values are carried, not a fixed key list.
- Includes `live.workingTree` (`git status --short` of the scope) and `live.pendingRun`, so a
  compaction mid-experiment doesn't say "start the next experiment" over uncommitted edits.
- Earlier compaction summaries arriving as user messages are not treated as user notes.
- Restates the loop rules briefly (keep/discard is decided by the plugin, benchmark is frozen).

## Finalize

- Finds the session folder upward, then downward (exactly one `.auto` → use it; several → ask).
- `final_tree` is always the experiment branch's HEAD (the field in groups.json is ignored).
- Each created branch is measured on its own in a temporary worktree, next to the merge-base
  measured the same way at the same time, and the measured numbers are written into the branch's
  commit message. A branch that fails alone is reported as "doesn't work on its own" (likely
  depends on another branch), not as a script failure. `--no-measure` skips this.

## Dashboard

Shows baseline → current, per-keep confidence, neutral keeps, baseline marker, unconfirmed keeps
(discards with a note), samples per run, and why the loop stopped is in the chat, not the page.

## Known limits (documented in the README)

- Drift between a keep and experiments hours later isn't corrected (current isn't re-measured).
- The benchmark's own validity (overfitting to its input) can't be checked by code; the skill
  lists what counts as cheating, and benchmark edits are visible as new segments.

---

# v0.2.1: changes after the first live tests (these override the text above where they differ)

Two live testers confirmed the guarantees hold, and found that comparing a candidate with
current's LOGGED samples is wrong: machine speed drifts within minutes (10 %+ on a busy
machine), which rejected sound changes, and an unluckily slow logged reference let a no-op
through (~9 % per no-op in simulation). Logged numbers from different times are not comparable.

## Paired confirmation (replaces "Confirmation" in autoresearch_log → keep)

On a proposed keep, after the fingerprint check, the plugin measures HEAD and the candidate
back to back, bracketing the candidate so linear drift cancels:

1. swap the scope to HEAD → measure `ceil(repeat/2)` runs (at least 3 when repeat ≥ 3)
2. swap back to the candidate (verify the tree hash equals the fingerprint) → measure `repeat` runs
3. swap to HEAD → measure the other half → swap back to the candidate

`judge(current = HEAD samples from 1+3, candidate = samples from 2)`. The logged current samples
are never used for a decision. The first measurement only serves as a cheap filter (below).

- The swap must preserve ignored/untracked-ignored state (node_modules, build caches) and restore
  the candidate exactly (added, deleted, renamed files, modes). The candidate's tree object from
  the fingerprint can be the source of truth. A swap in progress is recorded in plugin storage;
  every tool call and loop start first restores an interrupted swap. If HEAD fails the benchmark
  during the swap, restore the candidate and return an error (nothing logged).
- Checks are not re-run on HEAD.
- Run entry: `samples` = candidate samples (2), `current_samples` = HEAD samples (1+3),
  `vs` = their median, `first_metric` as before. `metric` = median of `samples`.
  Unconfirmed keeps record the same fields plus `confidence` (for auditing) and the note.
- Pre-filter: a non-simplification keep is still refused when the first measurement wasn't
  better than the logged current (no re-measure, nothing logged; the agent logs discard).
- `simplification: true` is only accepted when the diff removes more lines than it adds
  (net deletion; `git diff --numstat` against HEAD including untracked files). Otherwise refuse.
  It is confirmed when the candidate is not worse than HEAD beyond the noise AND not worse by
  more than `minImprovement` relative.
- Baseline: unchanged (one measurement on a clean tree after a warm-up).
- Cost: a confirmed or rejected keep costs about 3 × `repeat` benchmark runs in total.

## Progress numbers

(Superseded by "Progress" in v0.2.2 below, which gives the final rule.) Because absolute numbers
from different times aren't comparable, "improvement" is the **combined result of the confirmed
keeps** in the segment, not `current / baseline`. Status, tool output, the
compaction summary and the dashboard all use it; the baseline and current absolute values are
shown as "measured at the time". "kept" counts never include the baseline.
`/autoresearch status` covers the whole session: one line per segment (name, runs, kept,
compounded gain) plus totals.

## Frozen benchmark inputs

The segment hash and the run fingerprint cover every file under `.auto/` except `log.jsonl`,
`ideas.md`, `config.json` and `prompt.md` (so helper files a benchmark reads are frozen too).
`autoresearch_init` refuses when `.auto/measure.sh` or `.auto/checks.sh` differ from HEAD
(uncommitted benchmark edits): the agent commits them first, so every segment's benchmark is in git.

## Other fixes

- Start-up continue: only for loops that were already active when the plugin instance started
  (snapshot at setup), and only if still active when the timer fires.
- Compaction input: `<skill_content …>…</skill_content>` blocks are removed from user messages
  before they're read; the plugin prefix and the user-context label are found anywhere in a message.
- Unknown tool arguments are rejected with an error naming them.
- `/autoresearch` on trunk when `autoresearch/*` branches exist: say which branch to switch to
  instead of starting a new setup.
- Every git call the plugin makes passes `-c core.hooksPath=/dev/null`.
- The pinned rule says "a permission error or rejection", not the literal words "Permission denied".
- After a stop whose notice couldn't start a turn (interrupt, provider failure), the reason is
  kept and shown by the next `/autoresearch` or `/autoresearch status`.
- The "without improvement" counter shown to the agent says it counts since the last start.
- judge(): keep the threshold at 2 standard errors unless a simulation of the paired design
  (no-op experiments, uniform ±2 % noise, repeat 5, keep proposed when the first measurement
  looks better) shows more than 3 % false keeps per no-op; then use 2.5. Record the simulated
  rate in a test.

---

# v0.2.2: pair-wise measurement and an exact test (overrides v0.2.1 and earlier where they differ)

Live results on v0.2.1 (two testers, several hundred experiments): no false keep among real
changes and the swap is safe, but (a) ~9 % of proposed no-op keeps were confirmed (the SE from
the MAD of 5–6 samples is too rough; nominal 2.5 SE was really ~6.4 %), (b) a change that was
7–10 % faster was rejected twice because a load burst hit one block of the HEAD–candidate–HEAD
blocks, (c) the first-look advice and pre-filter still used the stale logged number (13 % off
seventy seconds later), (d) simplification keeps put noise into the compounded gain.

## Principle

Every comparison is made on **adjacent pairs**: one HEAD run and one candidate run measured
back to back, with the order inside the pair alternating (HC, CH, HC, …). A pair's result is
the relative difference of its two runs. Bursts and drift hit both runs of a pair alike.
Decisions use an **exact paired test** (Wilcoxon signed-rank on the pair differences, exact
null distribution, one-sided), so the false-keep rate is bounded by construction whatever the
noise looks like. No logged number from an earlier time is used for any decision or advice.

## Modes (fixed per segment by `repeat` at init)

- **Standard** (`repeat` ≥ 3, default 5): for workloads where many runs are affordable.
- **Slow** (`repeat` 1–2): for workloads where a run takes minutes. No statistical guarantee;
  say so in tool output and status.

## autoresearch_run (the first look)

- Baseline (segment has no keep yet): as before, `repeat` runs of the clean tree after one
  warm-up. These numbers are for display only.
- Otherwise: `LOOK_PAIRS` pairs (standard: 3; slow: 1) HEAD/candidate, then checks on the
  candidate tree. Output: the paired estimate (median relative difference, per-pair values) and
  advice ("looks better / about equal / looks worse; propose keep or discard"), worded as a
  rough look. The pending run stores the pairs.
- A HEAD failure during the look restores the candidate and returns an error.

## autoresearch_log → keep (the decision)

1. Fingerprint check, no-diff check as before. Pre-filter: refuse (nothing logged) when the
   first look's median pair difference isn't better than HEAD. (Fresh numbers, so this filter
   is unbiased; it exists to save benchmark time, not for truth.)
2. Stage 1: `CONFIRM_PAIRS` fresh pairs (standard: 8). Exact one-sided signed-rank p-value.
   - p ≤ `ALPHA_STAGE` → confirmed.
   - p > `EXTEND_BELOW` → not confirmed.
   - otherwise Stage 2: `CONFIRM_PAIRS` more pairs, test all pairs together; confirmed when
     p ≤ `ALPHA_STAGE`, else not confirmed.
   Choose `ALPHA_STAGE` and `EXTEND_BELOW` so that the total false-keep probability of a
   proposed no-op is ≤ 1 % by exact calculation (e.g. 0.005 per stage), and prove it in a test
   by enumerating/simulating the null. Report the power for true gains of 1 %, 3 %, 5 % at
   ±2 % uniform noise and under bursty noise (20 % of runs slowed by 10–40 %).
3. The look pairs are never pooled into the decision (they were selected on).
4. Slow mode: `repeat` fresh pairs; confirmed when every pair is better and the median
   difference is at least `minImprovement`.
5. `simplification: true` (net deletion required, as before): confirmed unless the candidate is
   significantly worse (same test in the other direction, p ≤ 0.05) or the median pair
   difference is worse than `minImprovement`. The pre-filter doesn't apply.
6. Not confirmed → revert, log as discard with a note, as before. Confirmed → commit.

## Log fields (run entries)

`pairs`: array of `[head, candidate]` values in measurement order (decision pairs only);
`look_pairs`: the first look's pairs; `gain`: median relative pair difference, positive = better
(for keeps and unconfirmed keeps); `p`: the one-sided p-value (null in slow mode);
`metric` = median of the candidate values in `pairs` (baseline: median of `samples`);
`vs` = median of the HEAD values in `pairs`. Keep writing `samples` (candidate values) and
`current_samples` (HEAD values) for older readers. `confidence` is no longer written.
`mode: "slow"` on config entries when `repeat` < 3.

## Progress

Each confirmed **non-simplification** keep has a ratio r = candidate / HEAD from its pairs
(lower is better: r = 1 − gain; higher is better: r = 1 + gain). The level is the product of
the ratios (baseline = 1). Report "N % lower than the baseline" with N = (1 − level) × 100 for
lower-is-better, "N % higher than the baseline" with N = (level − 1) × 100 for higher-is-better,
with "(worse)" when the level is on the wrong side. Example: two 10 % reductions, 100 → 90 → 81,
read "19.0 % lower", not 21 %. A simplification keep counts as no change. Tool output gives the
agent the exact sentence to quote, and the skill tells it never to quote a ratio of absolute
numbers measured at different times. Status, tool output, compaction summary and dashboard use
the same rule.

## Other fixes

- Tool schemas use `additionalProperties: true` so unknown arguments reach the plugin's own
  check and are rejected by name (OpenCode strips undeclared keys otherwise).
- After an interrupted-swap recovery, `/autoresearch` may start with uncommitted changes when
  they are exactly the pending run's fingerprinted tree, and the pending run is kept.
- Compaction: a user's goal/notes are capped at 1500 characters each (was 600).
- Finalize measures each branch against the merge-base in alternating pairs (worktree A, worktree
  B, …) and reports the paired median difference; a difference that isn't significant by the
  same test is written as "no measurable change", not as a percentage.
- README: provider errors are first retried by OpenCode itself (a usage-limit pause resumed by
  itself after 4 h in the live test); the plugin's own three retries apply to turns that
  finally fail.
- Dashboard and compaction show `gain` and "confirmed (p = …)" per keep; old entries with
  `confidence` still render.

## Benchmark check (v0.2.3)

The baseline's runs are identical code back to back, so they show the benchmark's own quality at
no extra cost. `benchmarkCheck()` (stats.ts) warns, never blocks, when: the typical deviation
from the median exceeds 5 %; the metric is a small integer (coarse steps); or the uncounted
warm-up run was more than 20 % worse than the median (a cold-start cost, like a build, inside the
timed part). The warnings appear in the baseline's tool output with an instruction to tell the
user and fix `measure.sh` before experimenting. The setup skill gives a measure.sh template
(prepare untimed → time the workload → print) and asks the agent to tell the user what is timed.
