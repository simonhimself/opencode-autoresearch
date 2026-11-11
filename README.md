# opencode-autoresearch

Let OpenCode optimize something on its own: try an idea, measure it, keep it if it helped, revert it if it didn't, and repeat until you stop it. Watch the results come in live in your browser, then turn the winners into clean branches to review.

A port of [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch) to OpenCode v2. It uses the same `.auto/` session files, so a session started in pi can be resumed here and the other way round.

## Try it

Add the plugin to `plugins` in `opencode.json` (globally, or in one project):

```jsonc
{
  "plugins": ["/Users/simonhimself/Documents/1-projects/dev-tools/opencode-autoresearch"]
}
```

Then, in a project with a **clean git tree**:

```
/autoresearch optimize unit test runtime, tests must still pass
/autoresearch dashboard      ← live results in your browser
/autoresearch finalize       ← when you're happy: stop and split the wins into branches
```

## Commands

| Command | What it does |
|---|---|
| `/autoresearch <goal>` | Starts a session (asks a few questions, writes `.auto/prompt.md` + `measure.sh`, runs a baseline, loops). If `.auto/prompt.md` exists, resumes instead. |
| `/autoresearch off` | Stops the loop. The log is kept. |
| `/autoresearch dashboard` | Opens the live dashboard in your browser (also: `export`). |
| `/autoresearch finalize` | Stops the loop and splits the kept experiments into independent branches, one per change. Asks you to approve the grouping first. |
| `/autoresearch help` | Lists these. |

## What's included

| Piece | What it does |
|---|---|
| `init_experiment` tool | Sets the session name, primary metric, unit and direction. |
| `run_experiment` tool | Runs `.auto/measure.sh`, times it, parses `METRIC name=value` lines, runs `.auto/checks.sh` if present. |
| `log_experiment` tool | Appends to `.auto/log.jsonl`. `keep` commits; anything else reverts. Reports a confidence score after 3+ runs. |
| `autoresearch-create` skill | The setup interview and the loop rules. |
| `autoresearch-finalize` skill | Groups kept experiments and runs `finalize.sh` to cut one branch per group from the merge-base, then verifies the branches add up to the original. |
| Live dashboard | A local page (127.0.0.1 only) with a chart, stats and every run's notes. It updates as experiments finish and shows when one is running. |
| Auto-continue | After each turn, re-prompts the session while the loop is on. Starts once the first experiment is logged, so it never talks over the setup questions. Stops on `/autoresearch off`, when you interrupt, at `maxIterations`, or after 3 turns with no new experiment. |
| Compaction summary | While the loop is on, long sessions are summarized from `.auto/` instead of by the model (see below). |

Not ported: the in-terminal widget and full-screen dashboard, `.auto/hooks/`, `workingDir`, keyboard shortcuts.

## Long runs and compaction

When a session gets close to the model's context limit, OpenCode *compacts* it: older conversation is replaced by a summary. A model-written summary can lose which ideas already failed or what the current best is, and the loop then re-tries dead ends.

While the loop is on, this plugin writes that summary itself from `.auto/`, so nothing important is lost and no model call is needed:

- goal, metric, baseline and best result
- `.auto/prompt.md` (the rules) and `.auto/ideas.md`
- the last 50 runs with their notes (`hypothesis`, `learned`, `next_focus`…)
- your own messages from the session, so steering like "don't touch the e2e folder" survives

OpenCode still keeps the most recent ~15k tokens of conversation next to the summary (`compaction.keep.tokens`). The plugin also pins a short "autoresearch mode is on" note into the session's instructions while the loop runs. Instructions aren't part of the conversation, so compaction never removes it.

If building the summary fails, OpenCode's normal summary is used. Not tested yet: providers set to `"compaction": { "type": "native" }` (OpenAI Responses), which compact on the provider's side.

## ⚠️ Discarding runs `git clean`

`discard`, `crash` and `checks_failed` run `git checkout -- .` and `git clean -fd`, excluding `.auto/`. Any untracked file that isn't gitignored gets deleted. The skill checks for a clean tree and creates an `autoresearch/…` branch first. Don't point it at a working copy with unsaved work.

These git commands run inside the plugin, so OpenCode's shell permission rules (e.g. `git checkout *: ask`) don't apply to them.

## Develop

```sh
bun install
bun run typecheck
bun test
```

Credits and license for the parts taken from pi-autoresearch: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
