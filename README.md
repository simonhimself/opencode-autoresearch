# opencode-autoresearch

Let OpenCode optimize something on its own: try an idea, measure it, keep it if it helped, revert it if it didn't, and repeat until you stop it.

A minimal OpenCode v2 port of [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch). It uses the same `.auto/` session files, so a session started in pi can be resumed here and the other way round.

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
/autoresearch off
```

## What's included

| Piece | What it does |
|---|---|
| `init_experiment` tool | Sets the session name, primary metric, unit and direction. |
| `run_experiment` tool | Runs `.auto/measure.sh`, times it, parses `METRIC name=value` lines, runs `.auto/checks.sh` if present. |
| `log_experiment` tool | Appends to `.auto/log.jsonl`. `keep` commits; anything else reverts. Reports a confidence score after 3+ runs. |
| `/autoresearch` command | `<goal>` starts a session (or resumes it if `.auto/prompt.md` exists); `off` stops the loop. |
| `autoresearch-create` skill | Interviews you, writes `.auto/prompt.md` + `measure.sh`, runs the baseline, starts the loop. |
| Auto-continue | After each turn, re-prompts the session while the loop is on. Stops on `/autoresearch off`, when you interrupt, at `maxIterations`, or after 3 turns with no new experiment. |

Not ported (yet): the terminal widget and dashboards, `.auto/hooks/`, the `finalize` skill, `workingDir`.

## ⚠️ Discarding runs `git clean`

`discard`, `crash` and `checks_failed` run `git checkout -- .` and `git clean -fd`, excluding `.auto/`. Any untracked file that isn't gitignored gets deleted. The skill checks for a clean tree and creates an `autoresearch/…` branch first. Don't point it at a working copy with unsaved work.

These git commands run inside the plugin, so OpenCode's shell permission rules (e.g. `git checkout *: ask`) don't apply to them.

## Develop

```sh
bun install
bun run typecheck
bun test
```
