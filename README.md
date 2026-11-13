# opencode-autoresearch

Let OpenCode improve something measurable in your code on its own, for hours, while you do something else. The agent tries an idea and measures it. The plugin then checks whether the gain is real, keeps it if so, and reverts it if not. This repeats until a limit is reached or you stop it. You watch results come in live in your browser, and at the end the improvements become clean branches you can review and merge.

It works for anything a script can measure: test runtime, build time, bundle size, a benchmark, a training loss.

An OpenCode v2 plugin. The idea and parts of the skills come from [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch).

## What makes the results trustworthy

Benchmarks give slightly different numbers on every run. An agent that keeps "whatever looked better" collects lucky runs and reports them as progress. So here **the agent proposes and the plugin decides**:

- **Every keep is re-measured.** When the agent proposes a keep, the plugin runs the benchmark again and compares those fresh numbers with the last kept state. A gain that doesn't clearly beat the noise is reverted and logged as "not confirmed".
- **The measured code is the committed code.** The plugin fingerprints the files when it measures. If anything changed before the keep, it refuses.
- **The benchmark is locked.** `.auto/measure.sh` and `.auto/checks.sh` are fingerprinted per *segment*. Changing them means starting a new segment with a new baseline, which shows in the log and the dashboard. The agent can't swap in another command or type in a number.
- **Final numbers are measured again.** At the end, each branch is measured on its own, next to your main branch, and those numbers go into the commit message.

## Install

You need OpenCode v2 (tested on 2.2.5 and 2.3.0) and [Bun](https://bun.sh).

```sh
git clone https://github.com/simonhimself/opencode-autoresearch
cd opencode-autoresearch
bun install
```

Then either copy the folder to `~/.config/opencode/plugins/opencode-autoresearch/` (loaded automatically), or add its path to `plugins` in an `opencode.json`:

```jsonc
{ "plugins": ["/absolute/path/to/opencode-autoresearch"] }
```

Run `/reload` in OpenCode for projects that were already open.

## How to use it

### 1. Start

Open OpenCode in the project. **Commit or stash your work first**: the plugin refuses to start with uncommitted changes. Then describe the goal:

```
/autoresearch make the unit tests faster, they must still pass
```

The agent asks what it can't work out itself (what to measure, which files it may change, constraints). Then it creates a branch `autoresearch/<goal>-<date>`, writes the session files into `.auto/`, measures a baseline and starts experimenting. Your main branch is never touched; the plugin refuses to run on `main` or `master`.

### 2. Let it run

Each experiment: change something → measure → propose keep or discard → the plugin confirms and commits, or reverts → notes what was learned. You don't need to reply.

It stops by itself, and tells you why, when:

- it reaches `maxIterations` (50 runs by default)
- `maxNoImprovement` runs in a row brought nothing (10 by default)
- the agent pauses it (out of ideas, needs your input, or a permission rule blocks it)
- 3 turns pass without an experiment
- someone switched branches or committed underneath it

You stop it with `/autoresearch off` (or `stop`, `pause`) or the stop button. If the model provider fails, it retries three times (after 30 s, 2 min, 5 min) before pausing.

To steer it mid-run, type a message ("try caching next", "don't touch the e2e folder"). It finishes the current experiment first.

### 3. Watch

```
/autoresearch dashboard
```

A local page (127.0.0.1 only) showing baseline → current, each run with its sample spread, which keeps were confirmed and by how much, which were not confirmed, and the agent's notes. It updates live. `/autoresearch dashboard off` closes it. `/autoresearch status` gives a text summary in the chat.

### 4. Finish

```
/autoresearch finalize
```

This stops the loop and sorts the kept experiments into groups, one per idea. It shows you the grouping and **waits for your OK**. Then it creates one branch per group from your main branch, checks that together they equal everything that was kept, and measures each branch on its own. A branch that only works together with another one is reported as such. It prints the cleanup commands but doesn't run them.

### Resuming

Run `/autoresearch` again in the project, in any session. Everything it needs is in `.auto/`. Raise `maxIterations` first if the limit was reached.

## Commands

| Command | What it does |
|---|---|
| `/autoresearch <goal>` | Start, or resume if `.auto/prompt.md` exists (the text is passed on as a note). |
| `/autoresearch status` | Loop on/off, runs, baseline → current, limits, why it last stopped. |
| `/autoresearch off` | Stop. During an experiment, the agent may log that one run first; a second `off` stops at once. |
| `/autoresearch dashboard` | Open the live page. `dashboard off` closes it. |
| `/autoresearch finalize` | Stop and turn the kept experiments into reviewable branches. |
| `/autoresearch help` | List the commands. |

## Session files (`.auto/` in the project folder)

| File | What it is |
|---|---|
| `prompt.md` | Goal, rules, files in scope, what's been tried. Kept up to date by the agent. |
| `measure.sh` | The benchmark. Prints `METRIC name=value`. Locked per segment. |
| `checks.sh` | Correctness checks (tests, lint). A run that fails them can't be kept. Locked per segment. |
| `log.jsonl` | Every run: samples, result, commit, notes. Written by the plugin. |
| `ideas.md` | Ideas saved for later (optional). |
| `config.json` | Settings (optional). |

Only the setup commit contains `.auto/` files. Later changes to them stay uncommitted on the experiment branch, and never reach the final branches.

## Settings (`.auto/config.json`)

| Key | Default | Meaning |
|---|---|---|
| `maxIterations` | 50 | Most logged runs in total, across segments. |
| `maxNoImprovement` | 10 | Pause after this many runs in a row without a confirmed gain. |
| `minImprovement` | 0.01 | Gain needed (1 %) when the benchmark runs fewer than 3 times per measurement. |

Invalid values are reported in `/autoresearch status` and the defaults apply.

How often the benchmark runs per measurement (`repeat`, default 5) is fixed when a segment starts. A confirmed keep therefore costs about `2 × repeat` benchmark runs. For slow workloads the agent can choose a lower `repeat`; below 3 there is no noise estimate, and a keep needs `minImprovement` in both measurements.

## Long sessions

When a session nears the model's context limit, OpenCode replaces older conversation with a summary. While the loop is on, the plugin writes that summary from `.auto/`: goal, baseline → current, the rules, the newest runs with their notes, your own messages, and any experiment in progress. The loop rules are also pinned into the session's instructions, which compaction never removes.

## Good to know

- **Discards delete uncommitted work in the project folder.** That's how a failed experiment is undone, and why the plugin insists on a clean tree and its own branch. Don't edit files there while the loop runs.
- **Experiment commits skip your git hooks and commit signing.** Hooks that prompt or run long would hang an unattended loop. They still apply when you merge the final branches.
- **Your permission rules apply.** The benchmark, the checks and the plugin's git commands are checked as `shell` actions. With allow-all the loop runs unattended; an `ask` rule on them pauses every experiment until you answer.
- **One loop per project.** Starting it in a second session turns it off in the first.
- **Command answers cost a short model reply.** OpenCode's plugin API has no way to show text only to you.
- **Known limits.**
  - A keep is compared with the previous keep's measurement, which may be hours old. If the machine's speed drifts in between, that isn't corrected.
  - The confirmation makes a false keep rare per experiment (about 1 % at typical noise), not impossible over a long session. The per-branch measurement at finalize is the final check.
  - No code can tell whether a benchmark represents real use. The setup skill lists what counts as cheating (shrinking the workload, special-casing its input, weakening tests), and benchmark changes are visible as new segments.
  - At finalize, branches are measured in a clean checkout. If the benchmark needs untracked files (installed dependencies, build output), the per-branch numbers read "could not be measured".

## Develop

```sh
bun install
bun run typecheck
bun test
```

`docs/design.md` is the specification: read it before changing behaviour. Code: `src/index.ts` (wiring, command, loop), `src/experiment.ts` (the four tools), `src/state.ts` (log, settings, the keep decision), `src/shell.ts` (processes and git), `src/compaction.ts`, `src/dashboard.ts` + `src/dashboard.html`. Skills are in `skills/`.

Credits and license for the parts adapted from pi-autoresearch: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
