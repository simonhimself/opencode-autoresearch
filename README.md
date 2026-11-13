# opencode-autoresearch

Let OpenCode optimize something on its own while you do something else. It tries an idea, measures it, keeps it if it helped, reverts it if it didn't, and repeats until you stop it or a run limit is reached. You watch the results come in live in your browser. At the end, the improvements are turned into clean branches you can review and merge.

It works for anything you can measure with a script: test runtime, build time, bundle size, a benchmark, a training loss, a Lighthouse score.

A port of [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch) to OpenCode v2. It uses the same `.auto/` session files, so a session started in pi can be resumed here and the other way round. The tools are named `autoresearch_init`, `autoresearch_run` and `autoresearch_log` here (pi calls them `init_experiment`, `run_experiment`, `log_experiment`).

## Install

You need OpenCode v2 (tested on 2.2.5 and 2.3.0) and [Bun](https://bun.sh).

```sh
git clone https://github.com/simonhimself/opencode-autoresearch
cd opencode-autoresearch
bun install
```

Then add the folder to `plugins` in your `opencode.json`. Put it in `~/.config/opencode/opencode.json` to have it in every project, or in one project's `opencode.json` to try it there first:

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-autoresearch"]
}
```

OpenCode picks up config changes by itself; there's nothing to restart.

## How to use it

### 1. Start a session

Open OpenCode in the project you want to improve. **Commit or stash your work first**; the loop needs a clean git tree. Then describe the goal:

```
/autoresearch make the unit tests faster, they must still pass
```

The agent asks a few questions, or works out the answers from your project:
- what to measure, and whether lower or higher is better
- which command runs the workload
- which files it may change, and what's off limits

Then it:
1. creates a branch `autoresearch/<goal>-<date>`, so your main branch is never touched
2. writes `.auto/prompt.md` (goal and rules) and `.auto/measure.sh` (the benchmark), and commits them
3. measures a baseline and starts experimenting

### 2. Let it run

Each experiment follows the same steps: change something → run the benchmark → **keep** (commit the code change) if it's better, **discard** (revert to the last commit) if not → write down what it learned. Then the next one. You don't need to reply; the plugin re-prompts the agent after every turn.

It stops when:
- you run `/autoresearch off` (or `stop` / `pause`), or press stop in OpenCode
- it reaches `maxIterations` (see [Settings](#settings))
- 3 turns pass with no new experiment (then it pauses rather than spinning)

To steer it mid-run, just type a message ("try caching next", "don't touch the e2e folder"). It finishes the current experiment and takes your note into the next one.

### 3. Watch it live

```
/autoresearch dashboard
```

This opens a page in your browser with:
- the baseline, the best result and the improvement so far
- a confidence score: is the gain real, or just measurement noise? It's based on noise measured by running the benchmark several times on the same code, so it only appears when the agent uses repeats (the setup skill tells it to for fast benchmarks).
- a chart of every experiment
- a table of every run with the agent's notes

It updates as results come in and shows when an experiment is running. The page is served from your own machine only (127.0.0.1).

### 4. Finish up

```
/autoresearch finalize
```

This stops the loop and sorts the kept experiments into groups, one per idea. It shows you the grouping and **waits for your OK**. Then it creates one branch per group, `autoresearch/<goal>/01-…`, `02-…`. Each branch starts from your main branch, so you can review and merge them separately, in any order. It checks that together they add up to everything that was kept, and prints the cleanup commands for the experiment branch and `.auto/`. It doesn't run those for you.

### Resuming

Run `/autoresearch` again in a project that has `.auto/prompt.md` and it picks up where it left off, in a new session or after a restart. Everything it needs is in the `.auto/` files.

## Commands

| Command | What it does |
|---|---|
| `/autoresearch <goal>` | Start a session, or resume one if `.auto/prompt.md` exists. On resume, the text is passed on as extra instructions. |
| `/autoresearch status` | Is the loop on? Runs so far, baseline → best, dashboard link. |
| `/autoresearch off` | Stop the loop. The log and files are kept. `stop` and `pause` work too. |
| `/autoresearch dashboard` | Open the live dashboard (also `export`). `dashboard off` closes its local web server. |
| `/autoresearch finalize` | Stop the loop and turn the kept experiments into reviewable branches. |
| `/autoresearch help` | List these commands. |

## Session files

Everything lives in `.auto/` at the project root:

| File | What it is |
|---|---|
| `prompt.md` | The goal, the rules, the files in scope, and what's been tried so far. The agent keeps it up to date. |
| `measure.sh` | The benchmark. It prints lines like `METRIC total_ms=1234`. |
| `log.jsonl` | Every experiment: result, kept or not, commit, notes. Written by the plugin. |
| `ideas.md` | Ideas saved for later (optional). |
| `checks.sh` | Correctness checks such as tests or lint (optional). If they fail, the experiment can't be kept. |
| `config.json` | Settings (optional), see below. |

## Settings

`.auto/config.json`:

```json
{ "maxIterations": 50 }
```

`maxIterations` is the most runs in total, counting baselines (so `6` = 6 logged runs). Starting a new segment (when the goal or the way of measuring changes) doesn't reset it. Set it to limit time and token use: the loop stops by itself when it's reached, and `/autoresearch` won't restart when the limit is already used up. Raise the number to continue. A broken `config.json` or an invalid value is reported (`/autoresearch status`) instead of silently meaning "no limit".

## Long runs and compaction

When a session gets close to the model's context limit, OpenCode *compacts* it: older conversation is replaced by a summary. A model-written summary can lose which ideas already failed or what the current best is, and the loop then re-tries dead ends.

While the loop is on, this plugin writes that summary itself from `.auto/`, so nothing important is lost and no model call is needed:
- goal, metric, baseline and best result
- `prompt.md` (the rules) and `ideas.md`
- the last 50 runs with their notes
- your own messages from the session, so steering like "don't touch the e2e folder" survives

OpenCode still keeps the most recent ~15k tokens of conversation next to it. The plugin also pins a short "autoresearch mode is on" note into the session's instructions while the loop runs. Instructions aren't part of the conversation, so compaction never removes it. This also works with providers that compact on their own side (OpenAI's "native" compaction); the plugin's summary is used instead. If building the summary fails, OpenCode's normal one is used.

## Good to know

- **Discarding deletes untracked files.** Discarded and crashed runs are reverted with `git checkout -- .` and `git clean -fd`; only `.auto/` is spared. That's why it insists on a clean tree and its own branch. Don't point it at a working copy with unsaved work.
- **Your permission rules apply.** Before running the benchmark or changing git, the plugin checks OpenCode's permission system as a `shell` action with the commands it's about to run (e.g. `./.auto/measure.sh`, `git clean -fd -- .`). With the default allow-all nothing changes and the loop runs unattended. A `deny` rule blocks it, and an `ask` rule pauses the loop until you answer, so only set `ask` for these if you want to approve each experiment.
- **Other plugins' shell hooks don't apply** to the plugin's own commands (the plugin API has no way to run them through OpenCode's shell).
- **Keep commits leave `.auto/` out.** The session files change on every run, so they stay uncommitted on the experiment branch (`git status` shows them). That's expected; finalize handles them.
- **One loop per project.** Starting `/autoresearch` in a second session turns the loop off in the first one.
- **Approving the first branch.** If your permission rules ask before `git checkout *`, the agent stops once at setup to create the `autoresearch/…` branch. Allow `git checkout -b autoresearch/*` to skip that.
- **Errors pause the loop.** If the model provider fails mid-turn, the plugin posts a notice and doesn't retry by itself. Send any message to continue.
- **Several projects at once are fine.** Each project's loop is handled only by its own copy of the plugin.

## Not included (compared with pi-autoresearch)

The in-terminal results widget and full-screen view, `.auto/hooks/` scripts, the `workingDir` setting, and keyboard shortcuts.

## Develop

```sh
bun install
bun run typecheck
bun test
```

The plugin is `src/index.ts`. The loop's state helpers are in `src/state.ts`, the compaction summary in `src/compaction.ts`, the dashboard server and page in `src/dashboard.ts` / `src/dashboard.html`. The skills are in `skills/`.

Credits and license for the parts taken from pi-autoresearch: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
