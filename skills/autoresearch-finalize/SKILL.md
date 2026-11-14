---
name: autoresearch-finalize
description: Turn a finished autoresearch session into clean, independent, reviewable branches, one per logical change. Use when asked to "finalize autoresearch", "clean up experiments", or "prepare autoresearch for review".
---

# Finalize Autoresearch

Turn a noisy `autoresearch/…` branch into clean branches, one per logical change. Each starts from the merge-base, so they can be reviewed and merged independently, in any order.
The script also measures each branch on its own, against the merge-base, and writes the result into its commit message, so a reviewer sees what that branch alone is worth.
Adapted from pi-autoresearch (https://github.com/davebcn87/pi-autoresearch), MIT.

If the autoresearch loop is still on, the user should run `/autoresearch off` first (`/autoresearch finalize` does this for you).

## Step 1: Analyze and propose groups

The experiment branch usually has uncommitted `.auto/` changes (`.auto/log.jsonl` modified, `.auto/ideas.md` untracked, and so on). That's expected. Don't commit them and don't put them in any group. The script stashes them while it works and puts them back at the end.

1. Read `.auto/log.jsonl` (written by the `autoresearch_init`, `autoresearch_run` and `autoresearch_log` tools). Use only `"type":"run"` entries with `"status":"keep"` and a non-null `commit`.
   - The first kept run of a segment has `"baseline": true`. It's the starting measurement and has no code change.
   - A keep with `"neutral": true` is a simplification: less or simpler code with no measurable loss. It's a real change and belongs in a group, even though the metric didn't move. Its `gain` is noise, not a result: don't quote it.
   - A keep's `gain` is how much better it was than HEAD measured right alongside it (0.042 = 4.2 % better), and `p` is the chance that this was luck. `metric` and `vs` are absolute values from that moment; values from different runs aren't comparable.
   - A `discard` with a `note` such as "keep not confirmed: …" was a keep that didn't hold up when measured again. It was reverted. Ignore it like any other discard.
2. Read `.auto/prompt.md` for context.
3. Find the trunk branch (`main`, or `master`, or whatever `git symbolic-ref refs/remotes/origin/HEAD` points to), then the merge-base: `git merge-base HEAD <trunk>`.
4. Expand every short commit hash to a full one: `git rev-parse <short>`.
5. For each kept commit, get its diff stat: `$BASE..<commit>` for the first (or `<last setup commit>..<commit>` if you give setup its own group, see below), `<prev_kept>..<commit>` after that. Ignore `.auto/` files. Also check for leftovers after the last kept commit: `git diff --stat <last_kept> HEAD -- ':(top)' ':(top,exclude,glob)**/.auto/**'` should print nothing (this covers the whole repo, even when run from a package folder).
6. Group kept commits into logical changesets:
   - **Keep the order.** Group N's commits come before group N+1's.
   - **No two groups may touch the same file.** Each branch is applied to the merge-base on its own, so a shared file would conflict. If two groups share a file, merge them.
   - **Merge groups that depend on each other.** If group 2 calls something group 1 adds, group 2's branch can't work alone. Merge them when the link is tight. If you miss one, the script finds it: it measures every branch alone and reports the ones that fail (see "A branch doesn't work on its own").
   - **Small and focused.** One idea per group. No fixed count: 1 is fine, 15 is fine.
   - **Every commit lands in some group.** A group covers *all* commits from the previous group's `last_commit` (or the merge-base) up to its own `last_commit`, experiments or not. `.auto/` files are dropped, everything else is kept. The script then checks that the groups together equal the whole experiment branch.
   - **Give setup commits their own first group.** Commits that aren't experiments (typically the setup commit that adds `.auto/prompt.md`, `.auto/measure.sh` and maybe `.gitignore`) sit before the first kept run. If they change any non-`.auto` file, add a first group such as `"slug": "setup"` whose `last_commit` is the last setup commit. Otherwise those changes get mixed into the first experiment's branch. If they only touch `.auto/` files, no setup group is needed (the script would skip it as empty anyway).
   - **Nothing may be left after the last group.** Non-`.auto` changes in commits after the last group's `last_commit` (e.g. a discarded experiment that was committed, or a manual fix) make the union check fail. Extend the last group to HEAD or add a final group for them.

Show the user the proposal, for example:

```
Proposed branches (each from merge-base, independent):

1. Switch test runner to forks pool (commits abc1234, def5678)
   Files: vitest.config.ts, package.json
   In the session: 6.1 % and 4.0 % better (runs #3, #5)

2. Remove the unused retry wrapper (commit ghi9012)
   Files: test/setup.ts
   In the session: kept as a simplification, no measurable loss (run #7)
```

Take the session figures from each keep's `gain` in the log. Don't compute them from absolute values (`metric` of one run against another's): the machine's speed drifts, so those ratios are wrong. The gains were measured on top of all earlier keeps, so they only hint at what a branch is worth alone. The script measures that properly in Step 2.

**Wait for the user's approval before going on.**

## Step 2: Write groups.json and run the script

Write it to a temp file (e.g. `/tmp/autoresearch-groups.json`), not into the repo:

```json
{
  "base": "<full merge-base hash>",
  "trunk": "main",
  "goal": "short-slug",
  "groups": [
    {
      "title": "Switch to forks pool",
      "body": "Why + what changed.\n\nExperiments: #3, #5",
      "last_commit": "<full hash of the last kept commit in this group>",
      "slug": "forks-pool"
    }
  ]
}
```

- `last_commit` **must be a full hash**.
- `goal` must not equal the experiment branch's name after `autoresearch/`. Git can't hold both `autoresearch/speed` and `autoresearch/speed/01-…`. Use e.g. `speed-final`.
- `body` describes the change: what and why. **Don't type metric numbers for a branch into it.** The script measures each branch and appends the result itself. Numbers copied from the log would be wrong for a branch on its own.
- There is no `final_tree` field. The end state is always the experiment branch as it is now (its HEAD). If you pass one anyway and it isn't HEAD, the script warns and uses HEAD.

Then run it:

```bash
bash <SKILL_DIR>/finalize.sh /tmp/autoresearch-groups.json
```

Options:
- `--no-measure`: only create and check the branches, don't measure them.
- `--pairs <n>`: how many pairs of runs each branch gets (default 8, from 5 to 100). More pairs find smaller differences and take longer.
- `--timeout <seconds>`: limit for one run of `measure.sh` or `checks.sh` (default 600).

**Where to run it.** The script needs the session folder (the one holding `.auto/`). It takes the nearest `.auto/` at or above the current folder. If there is none, it searches the whole repo (not `.git` or `node_modules`): one `.auto/` is used, so in a monorepo you can run it from the repo root. If it finds several, it stops before changing anything and lists them: `cd` into the right one and run it again. If there is none at all, it still creates the branches, but prints no ideas and measures nothing. All git work happens from the repo root.

The script first checks that every branch name it will create is valid (no spaces, `..` and so on in `goal` or a `slug`) and fails before touching anything if not. It then creates `autoresearch/<goal>/01-<slug>`, `02-…` branches from the merge-base and checks that together they equal the original branch. Added, changed, deleted and renamed files are all carried over. It also checks that no session files leaked in and that no commit is empty. Then it measures the branches (next section) and prints a summary with the measured table, cleanup commands and the ideas backlog.

Session files are anything inside a `.auto/` folder, at any depth. Any other file, even one named like `lib/autoresearch.utils.js`, is treated as normal code.

Uncommitted changes (normally the `.auto/` session files) are stashed while the script runs, because checking out the merge-base would otherwise fail. In every outcome the script returns to the original branch and pops that stash, so `.auto/log.jsonl`, `.auto/ideas.md` and the rest are back afterwards. If it can't, it prints a warning: then run `git stash list` and `git stash pop` on the original branch.

- If creating branches fails, it rolls back: deletes the new branches, returns to the original branch and restores the stash.
- If verification fails, it exits non-zero but leaves the branches so you can inspect them. It still returns to the original branch and restores the stash.

### Each branch is measured on its own

After the branches pass the checks, the script measures every branch against the merge-base, each in a clean temporary worktree (the user's checkout isn't switched for this, and the worktrees are removed afterwards, also on Ctrl-C). It copies the session's current `.auto/measure.sh` and `.auto/checks.sh` into both worktrees.

The measuring is **pair-wise**, like the plugin's own keep decision. For each branch the script runs 8 pairs: one run of `measure.sh` on the merge-base and one on the branch, back to back, with the order alternating from pair to pair. A slow minute on the machine then hits both runs of a pair alike. Each pair gives one relative difference. The script takes the median of those and runs an exact test (one-sided Wilcoxon signed-rank) on them. Then it runs `checks.sh` on the branch, if there is one. The result is added under each branch's commit message, in one of three wordings:

```
Measured alone, 8 pairs against the main merge-base: total_ms 4.1 % better (p = 0.004)
Checks: passed
```

```
Measured alone: no measurable change against the main merge-base (8 pairs)
Checks: passed
```

```
Measured alone, 8 pairs against the main merge-base: total_ms 3.0 % worse (p = 0.008)
Checks: passed
```

How to read them:

- **"N % better (p = …)"**: the branch alone beat the merge-base. The percentage is the median difference of the pairs. `p` is the chance of seeing a result this clear if the branch changed nothing; a percentage is only written when `p` is 0.05 or less.
- **"no measurable change"**: the pairs didn't show a difference in either direction. No percentage is written, because it would be noise. **This is the normal result for a simplification branch** (dead code removed, a helper inlined): it was kept for being simpler, not for being faster. Say so to the user; it isn't a failure. A small real gain can also read like this: more pairs (`--pairs 16`) can find it.
- **"N % worse (p = …)"**: the branch alone is measurably slower than the merge-base. Report it as measured (see below).

About one unchanged branch in twelve still gets a percentage by chance (that is what a 0.05 limit in each direction means). So if a branch that can't affect the metric reads "1.3 % better (p = 0.04)", treat it as noise and tell the user that too. A result with a small `p` (0.01 or less) is solid.

The summary shows the same as a table. This takes about branches × (2 × pairs + 1) runs of the benchmark (17 per branch by default), so with a slow benchmark it takes a while. For a very slow benchmark use `--pairs 5` (the fewest that can show a difference at all) or `--no-measure`.

Measuring is skipped, with a notice, when there is no session folder, no `.auto/measure.sh`, or no config entry in the log, and with `--no-measure`.

**A branch doesn't work on its own.** The script still exits 0. This is a result, not an error. The message says `Measured alone: FAILED (exit 1) — this branch may depend on another one` (or `Checks: FAILED …`), and the summary shows the last output of the failed run. Almost always the branch uses something another branch adds. Read the output to see what's missing, then either:
- merge the groups that belong together into one and run again (ask the user before deleting the branches the script just made, and use a new `goal` or delete them first), or
- leave them and tell the user plainly which branches must be reviewed and merged as a stack, and in which order.

A branch that timed out may also just need a longer `--timeout`.

**Nothing could be measured.** If the merge-base itself fails in a clean checkout, every message says `Measured alone: could not be measured in a clean checkout (e.g. missing untracked dependencies)`. A fresh worktree has only committed files: no `node_modules`, no build output, no ignored data files. If `measure.sh` ran into the time limit on the merge-base, the message says `could not be measured (measure.sh timed out after … s on the main merge-base)` instead: run again with a longer `--timeout`. In both cases the branches themselves are fine. Tell the user the per-branch numbers are missing and why. Don't make numbers up. If `measure.sh` can install or build what it needs, that's the fix; otherwise report the session's overall result from the log only.

**A branch measures worse, or shows no measurable change, alone.** That's possible: some changes only pay off together with an earlier one, and simplifications aren't meant to change the metric. Report it as measured, in the script's words. Don't replace "no measurable change" by a figure from the log. The user decides whether to merge it.

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
- what each branch measured alone, in the wording of the script's table ("4.1 % better (p = 0.004)", "no measurable change"), including any that don't work on their own and what to do about them
- the overall result of the session: the compounded gain of the confirmed keeps (the figure `/autoresearch status` and the dashboard show as the improvement over the baseline). Never a ratio of the baseline's and the last run's absolute values: they were measured at different times and aren't comparable
- the cleanup commands from the script's summary, exactly as printed and in that order: `cd` to the session folder, remove `.auto`, switch to trunk, then delete the experiment branch. **Don't run them yourself.** They delete the experiment branch and the session log, so the user decides.

## Edge cases

- **One kept experiment:** one branch is fine.
- **The script reports a file in multiple groups:** merge those groups and rerun.
- **Commits on the branch that aren't experiments:** they can't be skipped, since each group takes everything in its commit range. Put non-`.auto` changes from setup commits in their own first group (see Step 1). Other ones go in the group whose range contains them, or in a separate group if they're unrelated.
- **The union check fails:** some non-`.auto` change isn't covered by any group, usually because it comes after the last group's `last_commit` (the check always compares with the branch's current HEAD). Delete the created branches (ask the user first), fix `groups.json` and rerun.
- **Several `.auto/` folders:** the script lists them and stops. `cd` into the session's folder and run it again.
- **Only neutral keeps (simplifications):** the branches will read "no measurable change against the … merge-base". That's the expected result; say so.
- **A branch name already exists:** pick a different `goal` slug, or ask the user before deleting the old branch.
- **The script says a branch name is invalid:** use lowercase words joined by `-` for `goal` and every `slug`.
- **Deleted or renamed files:** no special handling needed. A rename counts as the old path (removed) plus the new path (added), and both belong to the same group, so another group may not touch either name.
