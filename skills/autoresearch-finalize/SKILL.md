---
name: autoresearch-finalize
description: Turn a finished autoresearch session into clean, independent, reviewable branches, one per logical change. Use when asked to "finalize autoresearch", "clean up experiments", or "prepare autoresearch for review".
---

# Finalize Autoresearch

Turn a noisy `autoresearch/…` branch into clean branches, one per logical change. Each starts from the merge-base, so they can be reviewed and merged independently, in any order.
Adapted from pi-autoresearch (https://github.com/davebcn87/pi-autoresearch), MIT.

If the autoresearch loop is still on, the user should run `/autoresearch off` first (`/autoresearch finalize` does this for you).

## Step 1: Analyze and propose groups

The experiment branch usually has uncommitted `.auto/` changes (`.auto/log.jsonl` modified, `.auto/ideas.md` untracked, and so on). That's expected. Don't commit them and don't put them in any group. The script stashes them while it works and puts them back at the end.

1. Read `.auto/log.jsonl`. Use only `"type":"run"` entries with `"status":"keep"` and a non-null `commit`. The first kept run is usually the baseline and has no code change.
2. Read `.auto/prompt.md` for context.
3. Find the trunk branch (`main`, or `master`, or whatever `git symbolic-ref refs/remotes/origin/HEAD` points to), then the merge-base: `git merge-base HEAD <trunk>`.
4. Expand every short commit hash to a full one: `git rev-parse <short>`.
5. For each kept commit, get its diff stat: `$BASE..<commit>` for the first (or `<last setup commit>..<commit>` if you give setup its own group, see below), `<prev_kept>..<commit>` after that. Ignore `.auto/` files. Also check for leftovers after the last kept commit: `git diff --stat <last_kept> HEAD -- ':(top)' ':(top,exclude,glob)**/.auto/**'` should print nothing (this covers the whole repo, even when run from a package folder).
6. Group kept commits into logical changesets:
   - **Keep the order.** Group N's commits come before group N+1's.
   - **No two groups may touch the same file.** Each branch is applied to the merge-base on its own, so a shared file would conflict. If two groups share a file, merge them.
   - **Flag cross-file dependencies.** If group 2 calls something group 1 adds, say "group 2 depends on group 1, review together", or merge them if the link is tight.
   - **Small and focused.** One idea per group. No fixed count: 1 is fine, 15 is fine.
   - **Every commit lands in some group.** A group covers *all* commits from the previous group's `last_commit` (or the merge-base) up to its own `last_commit`, experiments or not. `.auto/` files are dropped, everything else is kept. The script then checks that the groups together equal the whole experiment branch.
   - **Give setup commits their own first group.** Commits that aren't experiments (typically the setup commit that adds `.auto/prompt.md`, `.auto/measure.sh` and maybe `.gitignore`) sit before the first kept run. If they change any non-`.auto` file, add a first group such as `"slug": "setup"` whose `last_commit` is the last setup commit. Otherwise those changes get mixed into the first experiment's branch. If they only touch `.auto/` files, no setup group is needed (the script would skip it as empty anyway). The setup group has no metric, so the "no metric data" warning for it is expected.
   - **Nothing may be left after the last group.** Non-`.auto` changes in commits after the last group's `last_commit` (e.g. a discarded experiment that was committed, or a manual fix) make the union check fail. Extend the last group to HEAD or add a final group for them.

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

Then run it from the session folder (the one holding `.auto/`) or any folder below it. In a monorepo that is the package folder where the session ran, not the repo root: the script looks for the nearest `.auto/` at or above the current folder (for the ideas backlog and the cleanup commands) and does its git work from the repo root.

```bash
bash <SKILL_DIR>/finalize.sh /tmp/autoresearch-groups.json
```

The script first checks that every branch name it will create is valid (no spaces, `..` and so on in `goal` or a `slug`) and fails before touching anything if not. It then creates `autoresearch/<goal>/01-<slug>`, `02-…` branches from the merge-base and checks that together they equal the original branch. Added, changed, deleted and renamed files are all carried over. It also checks that no session files leaked in and that no commit is empty. Then it prints a summary with cleanup commands and the ideas backlog.

Session files are anything inside a `.auto/` folder, plus the older flat files (`autoresearch.jsonl`, `autoresearch.sh`, `autoresearch.md`, `autoresearch.ideas.md`, `autoresearch.checks.sh`, `autoresearch.config.json`) directly in the session folder. Any other file, even one named like `lib/autoresearch.utils.js`, is treated as normal code.

Uncommitted changes (normally the `.auto/` session files) are stashed while the script runs, because checking out the merge-base would otherwise fail. In every outcome the script returns to the original branch and pops that stash, so `.auto/log.jsonl`, `.auto/ideas.md` and the rest are back afterwards. If it can't, it prints a warning: then run `git stash list` and `git stash pop` on the original branch.

- If creating branches fails, it rolls back: deletes the new branches, returns to the original branch and restores the stash.
- If verification fails, it exits non-zero but leaves the branches so you can inspect them. It still returns to the original branch and restores the stash.

### Testing a branch without leaving the checkout

To run the tests on a created branch, check it out in a separate worktree, so the user's checkout and its `.auto/` files stay untouched:

```bash
git worktree add /private/tmp/ar-01-forks-pool autoresearch/<goal>/01-forks-pool
# run the project's tests inside /private/tmp/ar-01-forks-pool
git worktree remove /private/tmp/ar-01-forks-pool
```

Use `git worktree remove`, not `rm -rf`. If it refuses because the tests left untracked files (build output, caches), use `git worktree remove --force /private/tmp/ar-01-forks-pool`.

## Step 3: Report

Tell the user:
- the branches created and what each contains
- the overall result, baseline → best, from the log
- the cleanup commands from the script's summary, exactly as printed and in that order: `cd` to the session folder, remove `.auto` (and any older flat session files), switch to trunk, then delete the experiment branch. **Don't run them yourself.** They delete the experiment branch and the session log, so the user decides.

## Edge cases

- **One kept experiment:** one branch is fine.
- **The script reports a file in multiple groups:** merge those groups and rerun.
- **Commits on the branch that aren't experiments:** they can't be skipped, since each group takes everything in its commit range. Put non-`.auto` changes from setup commits in their own first group (see Step 1). Other ones go in the group whose range contains them, or in a separate group if they're unrelated.
- **The union check fails:** some non-`.auto` change isn't covered by any group, usually because it comes after the last group's `last_commit`. Delete the created branches (ask the user first), fix `groups.json` and rerun.
- **A branch name already exists:** pick a different `goal` slug, or ask the user before deleting the old branch.
- **The script says a branch name is invalid:** use lowercase words joined by `-` for `goal` and every `slug`.
- **Deleted or renamed files:** no special handling needed. A rename counts as the old path (removed) plus the new path (added), and both belong to the same group, so another group may not touch either name.
