---
name: autoresearch-finalize
description: Turn a finished autoresearch session into clean, independent, reviewable branches, one per logical change. Use when asked to "finalize autoresearch", "clean up experiments", or "prepare autoresearch for review".
---

# Finalize Autoresearch

Turn a noisy `autoresearch/…` branch into clean branches, one per logical change. Each starts from the merge-base, so they can be reviewed and merged independently, in any order.
Adapted from pi-autoresearch (https://github.com/davebcn87/pi-autoresearch), MIT.

If the autoresearch loop is still on, the user should run `/autoresearch off` first (`/autoresearch finalize` does this for you).

## Step 1: Analyze and propose groups

1. Read `.auto/log.jsonl`. Use only `"type":"run"` entries with `"status":"keep"` and a non-null `commit`. The first kept run is usually the baseline and has no code change.
2. Read `.auto/prompt.md` for context.
3. Find the trunk branch (`main`, or `master`, or whatever `git symbolic-ref refs/remotes/origin/HEAD` points to), then the merge-base: `git merge-base HEAD <trunk>`.
4. Expand every short commit hash to a full one: `git rev-parse <short>`.
5. For each kept commit, get its diff stat: `$BASE..<commit>` for the first, `<prev_kept>..<commit>` after that. Ignore `.auto/` files.
6. Group kept commits into logical changesets:
   - **Keep the order.** Group N's commits come before group N+1's.
   - **No two groups may touch the same file.** Each branch is applied to the merge-base on its own, so a shared file would conflict. If two groups share a file, merge them.
   - **Flag cross-file dependencies.** If group 2 calls something group 1 adds, say "group 2 depends on group 1, review together", or merge them if the link is tight.
   - **Small and focused.** One idea per group. No fixed count: 1 is fine, 15 is fine.

Show the user the proposal, for example:

```
Proposed branches (each from merge-base, independent):

1. Switch test runner to forks pool (commits abc1234, def5678)
   Files: vitest.config.ts, package.json
   Metric: 42.3s → 38.1s (-9.9%)

2. Tune worker count and timeouts (commits ghi9012)
   Files: test/setup.ts
   Metric: 38.1s → 31.7s (-16.8%)
```

**Wait for the user's approval before going on.**

## Step 2: Write groups.json and run the script

Write it to a temp file (e.g. `/tmp/autoresearch-groups.json`), not into the repo:

```json
{
  "base": "<full merge-base hash>",
  "trunk": "main",
  "final_tree": "<full hash of current HEAD>",
  "goal": "short-slug",
  "groups": [
    {
      "title": "Switch to forks pool",
      "body": "Why + what changed.\n\nExperiments: #3, #5\nMetric: total_time 42.3s → 38.1s (-9.9%)",
      "last_commit": "<full hash of the last kept commit in this group>",
      "slug": "forks-pool"
    }
  ]
}
```

- `last_commit` **must be a full hash**.
- `goal` must not equal the experiment branch's name after `autoresearch/`. Git can't hold both `autoresearch/speed` and `autoresearch/speed/01-…`. Use e.g. `speed-final`.
- Put the metric change in each `body`. The script warns when it's missing.

Then run it from the project root:

```bash
bash <SKILL_DIR>/finalize.sh /tmp/autoresearch-groups.json
```

The script creates `autoresearch/<goal>/01-<slug>`, `02-…` branches from the merge-base and checks that together they equal the original branch. It also checks that no `.auto/` files leaked in and that no commit is empty. Then it prints a summary with cleanup commands and the ideas backlog.

- If creating branches fails, it rolls back: deletes the new branches, returns to the original branch and restores any stash.
- If verification fails, it exits non-zero but leaves the branches so you can inspect them.

## Step 3: Report

Tell the user:
- the branches created and what each contains
- the overall result, baseline → best, from the log
- the cleanup commands from the script's summary. **Don't run them yourself.** They delete the experiment branch and `.auto/`, so the user decides.

## Edge cases

- **One kept experiment:** one branch is fine.
- **The script reports a file in multiple groups:** merge those groups and rerun.
- **Commits on the branch that aren't experiments:** skip them. Only kept runs from the log count.
- **A branch name already exists:** pick a different `goal` slug, or ask the user before deleting the old branch.
