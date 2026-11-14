#!/usr/bin/env bash
set -euo pipefail

# Adapted from pi-autoresearch (MIT, (c) 2026 Tobi Lutke, David Cortés):
# https://github.com/davebcn87/pi-autoresearch/blob/main/skills/autoresearch-finalize/finalize.sh
# Changes from the original:
#   - empty-array loops are guarded, so `set -u` doesn't abort rollback on macOS's bash 3.2
#   - preflight rejects a goal slug that clashes with an existing `autoresearch/<goal>` branch
#   - rollback switches back to the original branch before deleting, and also removes a
#     branch whose commit failed (previously both were left behind)
#   - groups.json and temp paths reach node as arguments, not pasted into its source
#   - after a successful run or a verification failure, the script returns to the original
#     branch and pops its own stash (previously the session files under .auto/ stayed hidden
#     in the stash until the user ran `git stash pop`); restore is guarded so the stash is
#     never popped onto the wrong branch
#   - the ideas backlog is captured before stashing, so the summary always shows it
#   - deleted and renamed files are handled: group files are listed with --no-renames, and a
#     file missing from a group's last commit is `git rm`ed instead of checked out
#   - OpenCode only: session files are paths with a `.auto` component (any depth), nothing
#     else, so user files such as `lib/autoresearch.utils.js` are kept; pi's flat
#     `autoresearch.*` files are not supported
#   - works from any folder inside the repo: the session dir is the nearest `.auto/` at or
#     above the cwd; if there is none, the repo is searched downward (one `.auto` is used,
#     several are an error, none means branches only); all git work runs from the toplevel
#   - every branch name is validated with `git check-ref-format` in preflight
#   - the printed cleanup commands run in a working order (remove session files, switch to
#     trunk, then delete the experiment branch)
#   - the end state is always the experiment branch's HEAD; a `final_tree` in groups.json is
#     only compared with it (a stale hash used to let later commits slip past the union check)
#   - each created branch is measured on its own in a temporary worktree, against the
#     merge-base in a second worktree, in alternating pairs (one merge-base run and one
#     branch run back to back). The median pair difference goes into the branch's commit
#     message, and only when an exact one-sided Wilcoxon signed-rank test finds it
#     significant; otherwise the message says "no measurable change". (Measuring the
#     merge-base once and then the branches one after another reported machine drift as a
#     result: "-2.2%" for a branch that only removed dead code.)

# autoresearch-finalize: creates independent branches from an autoresearch session
#
# Usage: finalize.sh [--no-measure] [--pairs <n>] [--timeout <seconds>] <groups.json>
#
#   --no-measure        don't measure the branches (only create and verify them)
#   --pairs <n>         pairs of (merge-base run, branch run) per branch (default 8, 5 to 100)
#   --timeout <seconds> limit for one run of measure.sh or checks.sh (default 600)
#
# groups.json format:
# {
#   "base": "<full merge-base commit hash>",
#   "trunk": "main",
#   "goal": "short-slug",
#   "groups": [
#     {
#       "title": "Switch to forks pool",
#       "body": "Use forks instead of threads, because...\n\nExperiments: #3, #5",
#       "last_commit": "<full commit hash>",
#       "slug": "forks-pool"
#     }
#   ]
# }
#
# Don't put measured numbers in "body": the script measures each branch alone and appends
# the result itself.

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

DATA_DIR=""
ORIG_BRANCH=""
TRUNK=""
BASE=""
FINAL_TREE=""
GOAL=""
GROUP_COUNT=""
STASHED=false
CREATED_BRANCHES=()
declare -a GROUP_BRANCH
# Session dir (absolute; "" when the repo has no `.auto/`) and its path relative to the
# repo toplevel ("" or "pkg/app/").
SESSION_DIR=""
SESSION_PREFIX=""
SESSION_FOUND_BY=""
REPO_ROOT=""
GIVEN_FINAL_TREE=""
# Measuring each branch alone.
MEASURE=true
MEASURE_SKIP_REASON=""
MEASURED=false
MEASURE_TIMEOUT=600
# Pairs of (merge-base run, branch run) per branch. Below 5 the exact test can't reach
# p <= 0.05 at all (4 pairs: 1/16 at best), so every branch would read "no measurable change".
PAIRS=8
MIN_PAIRS=5
MAX_PAIRS=100
# One-sided p-value at or below which a difference is reported as better / worse.
SIGNIFICANT=0.05
METRIC_NAME=""
DIRECTION="lower"
HAS_CHECKS=0
WT_ROOT=""

quote_arg() { printf '%q' "$1"; }
warn() { echo -e "${YELLOW}⚠ $1${NC}"; }
info() { echo -e "${GREEN}$1${NC}"; }
cleanup_data() { if [ -d "${DATA_DIR:-}" ]; then rm -rf "$DATA_DIR"; fi; }
fail() { cleanup_worktrees; cleanup_data; echo -e "${RED}ERROR: $1${NC}" >&2; exit 1; }

# Remove every temporary worktree and the temp dir that holds them. Runs on every
# exit path (traps, fail), so each command is guarded. Only `git worktree remove`
# deletes files; the holder dir is removed with rmdir, which can't take anything
# else with it.
cleanup_worktrees() {
  [ -n "${WT_ROOT:-}" ] || return 0
  local wt
  if [ -d "$WT_ROOT" ]; then
    for wt in "$WT_ROOT"/wt-*; do
      [ -d "$wt" ] || continue
      git -C "$REPO_ROOT" worktree remove --force "$wt" >/dev/null 2>&1 || true
    done
    rmdir "$WT_ROOT" 2>/dev/null || true
  fi
  if [ -d "$WT_ROOT" ]; then
    echo -e "${YELLOW}⚠ Could not remove the temporary folder $WT_ROOT. Check it and delete it by hand.${NC}"
  fi
  WT_ROOT=""
}

# Takes a repo-root-relative path. Session files are anything under a `.auto`
# path component (any depth, so a session in a monorepo package is covered).
# Nothing else: a user file like `lib/autoresearch.utils.js` is real code.
is_session_file() {
  case "/$1/" in
    */.auto/*) return 0;;
  esac
  return 1
}

# Bring one repo-root-relative path to its state in <commit>: check it out if it
# exists there, otherwise remove it (the group deleted or renamed it away).
# :(literal) stops git from treating names with * or ? as globs.
apply_file() {
  local commit="$1" path="$2"
  if git cat-file -e "${commit}:${path}" 2>/dev/null; then
    git checkout "$commit" -- ":(literal)$path"
  else
    git rm -q --ignore-unmatch -- ":(literal)$path"
  fi
}

# Find the session dir (the folder that holds `.auto/`):
#   1. the nearest one from the cwd up to the repo toplevel;
#   2. otherwise search the repo downward (not into .git or node_modules):
#      one `.auto` is used, several are listed and rejected in preflight,
#      none leaves SESSION_DIR empty (branches still work; no ideas, no measuring).
locate_session() {
  REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || fail "Not inside a git repository."
  REPO_ROOT=$(cd "$REPO_ROOT" && pwd -P)
  local dir
  dir=$(pwd -P)
  while :; do
    if [ -d "$dir/.auto" ]; then
      SESSION_DIR="$dir"
      SESSION_FOUND_BY="up"
      break
    fi
    [ "$dir" = "$REPO_ROOT" ] && break
    case "$dir" in "$REPO_ROOT"/*) ;; *) break;; esac
    dir=$(dirname "$dir")
  done

  if [ -z "$SESSION_DIR" ]; then
    find "$REPO_ROOT" \( -name .git -o -name node_modules \) -prune -o -type d -name .auto -print -prune \
      2>/dev/null | LC_ALL=C sort > "$DATA_DIR/session_candidates" || true
    local found
    found=$(grep -c . "$DATA_DIR/session_candidates" || true)
    if [ "$found" = "1" ]; then
      SESSION_DIR=$(dirname "$(head -n 1 "$DATA_DIR/session_candidates")")
      SESSION_FOUND_BY="down"
    elif [ "$found" != "0" ]; then
      SESSION_FOUND_BY="several"
    fi
  fi

  if [ -n "$SESSION_DIR" ]; then
    SESSION_PREFIX=$(cd "$SESSION_DIR" && git rev-parse --show-prefix)
  fi
}

# ---------------------------------------------------------------------------
# Parse
# ---------------------------------------------------------------------------

parse_groups() {
  local groups_file="$1"
  [ -f "$groups_file" ] || fail "$groups_file not found"

  # Serialize JSON fields into flat files so bash can consume them without jq.
  # Node is already a dependency (used by the extension), so no new dep required.
  DATA_DIR=$(mktemp -d)
  node -e "
const fs = require('fs');
const config = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8'));
const outDir = process.argv[2];
fs.writeFileSync(outDir + '/base', config.base);
fs.writeFileSync(outDir + '/trunk', config.trunk || 'main');
fs.writeFileSync(outDir + '/final_tree', config.final_tree || '');
fs.writeFileSync(outDir + '/goal', config.goal);
fs.writeFileSync(outDir + '/count', String(config.groups.length));
config.groups.forEach((group, idx) => {
  fs.writeFileSync(outDir + '/' + idx + '.title', group.title);
  fs.writeFileSync(outDir + '/' + idx + '.body', group.body);
  fs.writeFileSync(outDir + '/' + idx + '.last_commit', group.last_commit);
  fs.writeFileSync(outDir + '/' + idx + '.slug', group.slug);
});
" "$groups_file" "$DATA_DIR" || fail "Failed to parse $groups_file — check JSON syntax."

  BASE=$(cat "$DATA_DIR/base")
  TRUNK=$(cat "$DATA_DIR/trunk")
  GIVEN_FINAL_TREE=$(cat "$DATA_DIR/final_tree")
  GOAL=$(cat "$DATA_DIR/goal")
  GROUP_COUNT=$(cat "$DATA_DIR/count")
  [ "$GROUP_COUNT" -gt 0 ] || fail "$groups_file has no groups."
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

assert_on_feature_branch() {
  ORIG_BRANCH=$(git branch --show-current 2>/dev/null || echo "")
  [ -n "$ORIG_BRANCH" ] || fail "Detached HEAD — switch to the autoresearch branch first."
  [ "$ORIG_BRANCH" != "$TRUNK" ] || fail "On trunk ($TRUNK) — switch to the autoresearch branch first."
}

assert_commits_exist() {
  git rev-parse --verify --quiet "${BASE}^{commit}" >/dev/null 2>&1 || fail "Base commit $BASE not found."
}

# The end state the groups must add up to is always the experiment branch as it
# is now. A hash typed into groups.json can be stale: commits made after it
# would be left out while the union check still passed.
resolve_final_tree() {
  FINAL_TREE=$(git rev-parse --verify HEAD 2>/dev/null) || fail "The branch has no commits."
  [ -n "$GIVEN_FINAL_TREE" ] || return 0
  local given
  given=$(git rev-parse --verify --quiet "${GIVEN_FINAL_TREE}^{commit}" 2>/dev/null || true)
  if [ "$given" != "$FINAL_TREE" ]; then
    warn "groups.json has final_tree ${GIVEN_FINAL_TREE:0:12}, but '$ORIG_BRANCH' is at ${FINAL_TREE:0:12}. Using the branch's HEAD (final_tree is not needed)."
  fi
}

assert_one_session() {
  [ "$SESSION_FOUND_BY" = "several" ] || return 0
  echo -e "${RED}Found more than one .auto session folder in this repo:${NC}" >&2
  local candidate
  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    echo "  $(dirname "$candidate")" >&2
  done < "$DATA_DIR/session_candidates"
  fail "cd into the folder of the session you want to finalize and run the script again."
}

# Decide whether the branches get measured, and say why not.
plan_measuring() {
  if [ "$MEASURE" != true ]; then
    MEASURE_SKIP_REASON="--no-measure was given"
  elif [ -z "$SESSION_DIR" ]; then
    MEASURE=false; MEASURE_SKIP_REASON="no .auto session folder was found"
  elif [ ! -f "$DATA_DIR/measure.sh" ]; then
    MEASURE=false; MEASURE_SKIP_REASON="${SESSION_PREFIX}.auto/measure.sh doesn't exist"
  elif [ -z "$METRIC_NAME" ]; then
    MEASURE=false; MEASURE_SKIP_REASON="${SESSION_PREFIX}.auto/log.jsonl has no usable config entry (metric_name)"
  fi
}

collect_group_files() {
  local group_index="$1" prev_commit="$2"
  local last_commit

  last_commit=$(cat "$DATA_DIR/$group_index.last_commit")
  # rev-parse accepts any hex string; cat-file verifies the object exists.
  git cat-file -t "$last_commit" 2>/dev/null | grep -q "commit" \
    || fail "Group $((group_index+1)) last_commit $last_commit not found. Use full hashes (git rev-parse <short>)."

  # NUL-delimited (-z) via process substitution to handle spaces/globs in filenames.
  local changed_file
  : > "$DATA_DIR/$group_index.files"
  while IFS= read -r -d '' changed_file; do
    [ -n "$changed_file" ] || continue
    is_session_file "$changed_file" || echo "$changed_file" >> "$DATA_DIR/$group_index.files"
  # --no-renames: a rename must list the old path too, so it gets removed.
  done < <(git diff --name-only --no-renames -z "$prev_commit" "$last_commit")
}

assert_no_overlapping_files() {
  local new_files_path="$1" seen_files_path="$2"
  [ -s "$new_files_path" ] || return 0
  [ -s "$seen_files_path" ] || return 0
  local candidate
  while IFS= read -r candidate; do
    if grep -qxF "$candidate" "$seen_files_path"; then
      fail "File '$candidate' appears in multiple groups. Merge the overlapping groups and retry."
    fi
  done < "$new_files_path"
}

assert_valid_branch_name() {
  git check-ref-format --branch "$1" >/dev/null 2>&1 \
    || fail "'$1' is not a valid branch name. Use a goal and slugs without spaces, '..', '~', '^', ':' and the like."
}

assert_branch_available() {
  local branch_name="$1"
  if git rev-parse --verify "$branch_name" >/dev/null 2>&1; then
    fail "Branch '$branch_name' already exists. Delete it first or use a different goal slug."
  fi
}

preflight() {
  echo ""
  info "═══ Preflight ═══"
  echo ""

  assert_one_session
  assert_on_feature_branch
  assert_commits_exist
  resolve_final_tree
  plan_measuring

  # Validate every name we'll create before touching anything (nothing stashed yet).
  local j
  for j in $(seq 0 $((GROUP_COUNT - 1))); do
    assert_valid_branch_name "autoresearch/${GOAL}/$(printf "%02d" $((j + 1)))-$(cat "$DATA_DIR/$j.slug")"
  done
  assert_valid_branch_name "autoresearch/${GOAL}/verify-tmp"

  local prev_commit="$BASE"
  local all_seen_path="$DATA_DIR/all_seen_files"
  : > "$all_seen_path"

  for i in $(seq 0 $((GROUP_COUNT - 1))); do
    collect_group_files "$i" "$prev_commit"
    assert_no_overlapping_files "$DATA_DIR/$i.files" "$all_seen_path"
    cat "$DATA_DIR/$i.files" >> "$all_seen_path"

    local group_number branch_name
    group_number=$(printf "%02d" $((i + 1)))
    branch_name="autoresearch/${GOAL}/${group_number}-$(cat "$DATA_DIR/$i.slug")"
    assert_branch_available "$branch_name"
    GROUP_BRANCH[$i]=""

    prev_commit=$(cat "$DATA_DIR/$i.last_commit")
  done

  assert_branch_available "autoresearch/${GOAL}/verify-tmp"

  # Git can't have both a branch `autoresearch/<goal>` and branches under
  # `autoresearch/<goal>/…`. Catch it here, before anything is created.
  if git show-ref --verify --quiet "refs/heads/autoresearch/${GOAL}"; then
    fail "A branch named 'autoresearch/${GOAL}' exists, so 'autoresearch/${GOAL}/…' branches can't be created. Use a different goal slug."
  fi

  info "Preflight passed."
  echo "  Branch:     $ORIG_BRANCH"
  echo "  Head:       ${FINAL_TREE:0:12}"
  echo "  Base:       ${BASE:0:12}"
  echo "  Groups:     $GROUP_COUNT"
  if [ -z "$SESSION_DIR" ]; then
    echo "  Session:    none (no .auto folder in this repo)"
  elif [ "$SESSION_FOUND_BY" = "down" ]; then
    echo "  Session:    $SESSION_DIR (found by searching the repo)"
  else
    echo "  Session:    $SESSION_DIR"
  fi
  if [ "$MEASURE" = true ]; then
    echo "  Measuring:  each branch alone, $PAIRS pairs of (merge-base run, branch run) of ${SESSION_PREFIX}.auto/measure.sh, ${MEASURE_TIMEOUT}s limit per run"
  else
    echo "  Measuring:  skipped ($MEASURE_SKIP_REASON)"
  fi
}

# ---------------------------------------------------------------------------
# Create branches
# ---------------------------------------------------------------------------

rollback_on_failure() {
  local exit_code=$?
  if [ $exit_code -eq 0 ]; then return; fi

  echo ""
  echo -e "${RED}FAILED: rolling back...${NC}"
  cleanup_worktrees
  # Leave the half-built branch first (git won't delete the branch you're on).
  # -f is safe here: the user's own uncommitted work was stashed before we
  # started, so the only changes in the tree are files this script copied in.
  git reset --quiet HEAD -- . 2>/dev/null || true
  restore_workspace -f
  for branch in ${CREATED_BRANCHES[@]+"${CREATED_BRANCHES[@]}"}; do
    git branch -D "$branch" 2>/dev/null || true
  done
  cleanup_data
  echo -e "${RED}Rolled back to '$ORIG_BRANCH'. No branches left behind.${NC}"
}

# Go back to the original branch and pop our stash. Safe to call more than once.
# Every command is guarded: this also runs from an EXIT trap under `set -e`.
# The stash is only popped once we're confirmed back on the original branch,
# otherwise the session files would land on a group branch.
restore_workspace() {
  local force="${1:-}"
  [ -n "${ORIG_BRANCH:-}" ] || return 0
  if [ "$(git branch --show-current 2>/dev/null || true)" != "$ORIG_BRANCH" ]; then
    if [ "$force" = "-f" ]; then
      git checkout -f "$ORIG_BRANCH" --quiet 2>/dev/null || true
    else
      git checkout "$ORIG_BRANCH" --quiet 2>/dev/null || true
    fi
  fi
  if [ "$(git branch --show-current 2>/dev/null || true)" != "$ORIG_BRANCH" ]; then
    if [ "$STASHED" = true ]; then
      echo -e "${YELLOW}⚠ Could not switch back to '$ORIG_BRANCH', so your uncommitted changes (including .auto/ session files) are still stashed. Run 'git checkout $ORIG_BRANCH && git stash pop' to restore them.${NC}"
      STASHED=false
    else
      echo -e "${YELLOW}⚠ Could not switch back to '$ORIG_BRANCH'. Run 'git checkout $ORIG_BRANCH'.${NC}"
    fi
    return 0
  fi
  if [ "$STASHED" = true ]; then
    STASHED=false
    if git stash pop --quiet >/dev/null 2>&1; then
      echo -e "${GREEN}Restored your uncommitted changes (including .auto/ session files).${NC}"
    else
      echo -e "${YELLOW}⚠ Could not restore stashed changes automatically. They are still in the stash: run 'git stash list' and 'git stash pop' to recover them.${NC}"
    fi
  fi
}

on_exit_restore() {
  cleanup_worktrees
  restore_workspace || true
  cleanup_data
}

on_early_exit() {
  cleanup_worktrees
  cleanup_data
}

# Copy what we need from the session now, before stashing hides it: the ideas
# backlog (for the summary), the current measure.sh and checks.sh (every branch
# is measured with the same, current benchmark) and the last config entry.
capture_session() {
  [ -n "$SESSION_DIR" ] || return 0
  local auto="$SESSION_DIR/.auto"
  if [ -f "$auto/ideas.md" ]; then
    cp "$auto/ideas.md" "$DATA_DIR/ideas" 2>/dev/null || true
  fi
  if [ -f "$auto/measure.sh" ]; then
    cp -p "$auto/measure.sh" "$DATA_DIR/measure.sh" 2>/dev/null || true
  fi
  if [ -f "$auto/checks.sh" ]; then
    if cp -p "$auto/checks.sh" "$DATA_DIR/checks.sh" 2>/dev/null; then HAS_CHECKS=1; fi
  fi
  [ -f "$auto/log.jsonl" ] || return 0

  cat > "$DATA_DIR/config.js" <<'CONFIG_JS'
// Reads the last {"type":"config"} line of .auto/log.jsonl.
const fs = require('fs');
const [logFile, outDir] = process.argv.slice(2);
let config = null;
for (const line of fs.readFileSync(logFile, 'utf-8').split('\n')) {
  if (!line.trim()) continue;
  try {
    const entry = JSON.parse(line);
    if (entry && entry.type === 'config') config = entry;
  } catch (e) { /* a damaged line is not a reason to stop */ }
}
if (config && typeof config.metric_name === 'string' && /^[\w.\-]+$/.test(config.metric_name)) {
  fs.writeFileSync(outDir + '/metric_name', config.metric_name);
  fs.writeFileSync(outDir + '/direction', config.direction === 'higher' ? 'higher' : 'lower');
}
CONFIG_JS
  node "$DATA_DIR/config.js" "$auto/log.jsonl" "$DATA_DIR" 2>/dev/null || true
  if [ -s "$DATA_DIR/metric_name" ]; then
    METRIC_NAME=$(cat "$DATA_DIR/metric_name")
    DIRECTION=$(cat "$DATA_DIR/direction")
  fi
}

# Uncommitted changes are normal here (.auto/log.jsonl modified, .auto/ideas.md
# untracked). They must be stashed, or checking out the merge-base fails on
# modified tracked .auto/ files. restore_workspace puts them back afterwards.
stash_if_dirty() {
  if ! git diff --quiet 2>/dev/null \
    || ! git diff --cached --quiet 2>/dev/null \
    || [ -n "$(git ls-files --others --exclude-standard 2>/dev/null)" ]; then
    warn "Stashing uncommitted changes (restored automatically at the end)..."
    local before after
    before=$(git rev-parse -q --verify refs/stash 2>/dev/null || true)
    git stash push -u --quiet -m "autoresearch-finalize: uncommitted changes"
    after=$(git rev-parse -q --verify refs/stash 2>/dev/null || true)
    if [ -n "$after" ] && [ "$after" != "$before" ]; then
      STASHED=true
    fi
  fi
}

create_group_branch() {
  local i="$1"
  local title body last_commit slug files group_number branch_name

  title=$(cat "$DATA_DIR/$i.title")
  body=$(cat "$DATA_DIR/$i.body")
  last_commit=$(cat "$DATA_DIR/$i.last_commit")
  slug=$(cat "$DATA_DIR/$i.slug")
  local files_path="$DATA_DIR/$i.files"

  group_number=$(printf "%02d" $((i + 1)))
  branch_name="autoresearch/${GOAL}/${group_number}-${slug}"

  info "[$group_number/$GROUP_COUNT] $title"

  if [ ! -s "$files_path" ]; then
    warn "No files changed — skipping this group"
    GROUP_BRANCH[$i]="skipped"
    return
  fi

  # Start from merge-base (not the previous group) so each branch is
  # independently mergeable — reviewers can land them in any order.
  git checkout "$BASE" --quiet --detach 2>/dev/null || git checkout "$BASE" --quiet
  git checkout -b "$branch_name"
  # Record it now, not after the commit, so rollback also removes a half-built branch.
  CREATED_BRANCHES+=("$branch_name")

  while IFS= read -r changed_file; do
    [ -n "$changed_file" ] || continue
    apply_file "$last_commit" "$changed_file"
  done < "$files_path"
  git commit -m "$title" -m "$body"

  GROUP_BRANCH[$i]="$branch_name"
  echo "  Branch: $branch_name"
  echo "  Files: $(tr '\n' ' ' < "$files_path")"
  echo ""
}

create_branches() {
  echo ""
  info "═══ Creating branches ═══"
  echo ""

  trap rollback_on_failure EXIT
  stash_if_dirty

  for i in $(seq 0 $((GROUP_COUNT - 1))); do
    create_group_branch "$i"
  done

  info "Created ${#CREATED_BRANCHES[@]} branches (all from merge-base, independent):"
  for branch in ${CREATED_BRANCHES[@]+"${CREATED_BRANCHES[@]}"}; do echo "  $branch"; done

  # Swap rollback for restore — creation succeeded. Verify failures intentionally
  # leave branches intact so the user can inspect and fix manually, but any exit
  # from here on still returns to the original branch and pops the stash.
  trap on_exit_restore EXIT
}

# ---------------------------------------------------------------------------
# Verify
# ---------------------------------------------------------------------------

verify_union_matches_original() {
  local verify_branch="autoresearch/${GOAL}/verify-tmp"

  git checkout "$BASE" --quiet --detach 2>/dev/null || git checkout "$BASE" --quiet
  git checkout -b "$verify_branch"

  for i in $(seq 0 $((GROUP_COUNT - 1))); do
    local last_commit
    last_commit=$(cat "$DATA_DIR/$i.last_commit")
    while IFS= read -r changed_file; do
      [ -n "$changed_file" ] || continue
      apply_file "$last_commit" "$changed_file"
    done < "$DATA_DIR/$i.files"
  done
  # --allow-empty: when all groups cover all files, the checkout leaves
  # nothing staged — the diff against FINAL_TREE is what matters, not this commit.
  git commit --allow-empty -m "verify: union of all groups" --quiet

  local non_session_diff="" changed_file
  while IFS= read -r -d '' changed_file; do
    [ -n "$changed_file" ] || continue
    is_session_file "$changed_file" || non_session_diff="$non_session_diff $changed_file"
  done < <(git diff --name-only --no-renames -z HEAD "$FINAL_TREE" 2>/dev/null)

  git checkout "$ORIG_BRANCH" --quiet 2>/dev/null || true
  git branch -D "$verify_branch" 2>/dev/null || true

  if [ -n "$non_session_diff" ]; then
    echo -e "${RED}✗ Union of groups differs from autoresearch branch!${NC}"
    echo "  Files:$non_session_diff"
    return 1
  fi

  echo -e "${GREEN}✓ Union of all groups matches original autoresearch branch.${NC}"
  return 0
}

verify_no_session_artifacts() {
  local clean=true
  for branch in ${CREATED_BRANCHES[@]+"${CREATED_BRANCHES[@]}"}; do
    local changed_file
    while IFS= read -r -d '' changed_file; do
      [ -n "$changed_file" ] || continue
      if is_session_file "$changed_file"; then
        echo -e "${RED}✗ Session artifact '$changed_file' in branch $branch!${NC}"
        clean=false
      fi
    done < <(git diff-tree --no-commit-id --name-only --no-renames -z -r "$(git rev-parse "$branch")" 2>/dev/null)
  done

  if [ "$clean" = true ]; then
    echo -e "${GREEN}✓ No session artifacts in any branch.${NC}"
    return 0
  fi
  return 1
}

verify_no_empty_commits() {
  local errors=0
  for branch in ${CREATED_BRANCHES[@]+"${CREATED_BRANCHES[@]}"}; do
    local commit diff
    commit=$(git rev-parse "$branch" 2>/dev/null)
    diff=$(git diff-tree --no-commit-id --name-only -r "$commit" 2>/dev/null || echo "")
    if [ -z "$diff" ]; then
      echo -e "${RED}✗ Empty commit in $branch${NC}"
      errors=$((errors + 1))
    fi
  done
  return $errors
}

verify_branches() {
  echo ""
  info "═══ Verifying ═══"
  echo ""

  local errors=0

  verify_union_matches_original || errors=$((errors + 1))
  verify_no_session_artifacts || errors=$((errors + 1))
  verify_no_empty_commits || errors=$((errors + $?))

  echo ""
  if [ $errors -gt 0 ]; then
    restore_workspace || true
    echo -e "${RED}Verification failed with $errors error(s).${NC}"
    echo -e "${RED}Branches are intact: inspect and fix manually, or delete and retry.${NC}"
    echo "  Branches: ${CREATED_BRANCHES[*]:-}"
    echo "  You are on: $(git branch --show-current 2>/dev/null || echo 'detached')"
    cleanup_data
    exit 1
  fi
  info "✓ All checks passed."
}

# ---------------------------------------------------------------------------
# Measure each branch on its own
# ---------------------------------------------------------------------------

# The runner. Two modes:
#
#   probe <base>            one run of .auto/measure.sh in the merge-base worktree (does it
#                           work in a clean checkout at all? also its warm-up), then
#                           .auto/checks.sh there.
#   pairs <base> <branch>   one warm-up run in the branch worktree (not counted; a branch
#                           that fails alone is found here), then N pairs of one
#                           merge-base run and one branch run back to back, the order
#                           alternating inside the pairs (base-branch, branch-base, ...),
#                           so drift and load bursts hit both sides alike. Then checks.sh
#                           in the branch worktree.
#
# A pair's result is the relative difference of its two runs, positive = the branch is
# better. Reported: the median of those, and an exact one-sided Wilcoxon signed-rank
# p-value in each direction (same idea as the plugin's keep decision; implemented here
# because this script runs on its own).
#
# `METRIC <name>=<number>` is parsed as the plugin does. Each run is its own process
# group, so a timeout (or Ctrl-C) kills the script and everything it started. macOS has
# no `timeout` command. Stops at the first failed run: a hanging measure.sh costs one
# timeout, not one per pair.
write_measure_runner() {
  cat > "$DATA_DIR/measure.js" <<'MEASURE_JS'
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const [mode, baseDir, branchDir, metric, pairsArg, timeoutArg, outDir, hasChecks, direction, alphaArg] = process.argv.slice(2);
const pairCount = Number(pairsArg);
const timeoutMs = Number(timeoutArg) * 1000;
const alpha = Number(alphaArg);
const put = (name, value) => fs.writeFileSync(path.join(outDir, name), String(value));

let group = null; // pid of the running script = id of its process group
const killGroup = (signal) => {
  if (!group) return;
  try { process.kill(-group, signal); } catch (e) { /* already gone */ }
};
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => { killGroup('SIGKILL'); process.exit(130); });
}

// Last 1 MB of a run's output.
function readTail(file) {
  try {
    const size = fs.statSync(file).size;
    const length = Math.min(size, 1024 * 1024);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, buffer, 0, length, size - length);
    fs.closeSync(fd);
    return buffer.toString('utf-8');
  } catch (e) { return ''; }
}

// Output goes straight to a file, and we wait for the script's exit, not for
// its pipes to close: a background process it leaves behind can't hang us.
function run(cwd, script) {
  return new Promise((resolve) => {
    const logFile = path.join(outDir, 'output.log');
    const relative = './.auto/' + script;
    let command = relative, args = [];
    try { fs.accessSync(path.join(cwd, relative), fs.constants.X_OK); } catch (e) { command = 'bash'; args = [relative]; }
    const fd = fs.openSync(logFile, 'w');
    let timedOut = false, done = false, timer = null, killer = null;
    const finish = (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(killer);
      killGroup('SIGKILL'); // leftovers would keep files open in the worktree
      group = null;
      try { fs.closeSync(fd); } catch (e) { /* ignore */ }
      resolve({ timedOut, code, signal, output: readTail(logFile) });
    };
    let child;
    try {
      child = spawn(command, args, { cwd, detached: true, stdio: ['ignore', fd, fd] });
    } catch (e) {
      fs.appendFileSync(logFile, String(e && e.message) + '\n');
      return finish(127, null);
    }
    child.on('error', (e) => { fs.appendFileSync(logFile, String(e && e.message) + '\n'); finish(127, null); });
    child.on('exit', finish);
    group = child.pid || null;
    timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      killer = setTimeout(() => killGroup('SIGKILL'), 5000);
    }, timeoutMs);
  });
}

// Same rules as parseMetrics() and median() in src/state.ts.
function parseMetrics(output) {
  const metrics = {};
  const re = /^METRIC\s+([\w.\-]+)=(\S+)\s*$/gm;
  let m;
  while ((m = re.exec(output)) !== null) {
    const value = Number(m[2]);
    if (Number.isFinite(value)) metrics[m[1]] = value;
  }
  return metrics;
}
function median(values) {
  const s = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function format(x) {
  if (Number.isInteger(x)) return String(x);
  if (Math.abs(x) >= 1000) return String(Number(x.toFixed(1)));
  return String(Number(x.toPrecision(4)));
}
const lastLines = (text) => text.split('\n').filter((l) => l.trim()).slice(-12).join('\n');
const why = (r) => (r.signal ? 'killed by ' + r.signal : 'exit ' + r.code);

// One run of measure.sh: { value } or { status, detail, tail }.
async function measure(cwd) {
  const r = await run(cwd, 'measure.sh');
  let status = null;
  if (r.timedOut) status = 'timeout';
  else if (r.code !== 0) status = 'failed';
  else if (parseMetrics(r.output)[metric] === undefined) status = 'no_metric';
  if (status) return { status, detail: why(r), tail: lastLines(r.output) };
  return { value: parseMetrics(r.output)[metric] };
}
function putFailure(f, status) {
  put('detail', f.detail);
  put('tail', f.tail);
  put('status', status || f.status);
}
async function checks(cwd) {
  if (hasChecks !== '1') return;
  const r = await run(cwd, 'checks.sh');
  put('checks', r.timedOut ? 'timeout' : r.code === 0 ? 'passed' : 'failed');
  put('checks_detail', why(r));
  if (r.timedOut || r.code !== 0) put('checks_tail', lastLines(r.output));
}

// How much better the branch run is than the merge-base run next to it, as a
// fraction of the merge-base run. A merge-base value of 0 has no relative
// difference: equal = 0, otherwise only the direction is known (±Infinity, which
// still ranks; the median then has no percentage).
function pairDifference(base, branch) {
  const better = direction === 'higher' ? branch - base : base - branch;
  if (better === 0) return 0;
  if (base === 0) return better > 0 ? Infinity : -Infinity;
  return better / Math.abs(base);
}

// Exact one-sided Wilcoxon signed-rank test on the pair differences.
// Returns P(a result at least this favourable | no real difference) for
// "positive" (the branch is better) when sign = +1, for "negative" when -1.
//
// Conservative with ties and zeros: all pairs are ranked by |difference| with
// midranks for ties, a zero difference keeps its (lowest) ranks and counts
// AGAINST the direction tested, and the null distribution is computed for
// exactly these ranks (each rank falls on either side with probability 1/2).
// So a zero can only raise the p-value, and ties don't make it too small.
function signedRankP(differences, sign) {
  const n = differences.length;
  if (!n) return 1;
  const order = differences.map((d, i) => ({ a: Math.abs(d), i })).sort((x, y) => x.a - y.a);
  const rank2 = new Array(n); // doubled midranks, so they are integers
  for (let start = 0; start < n; ) {
    let end = start;
    while (end + 1 < n && order[end + 1].a === order[start].a) end++;
    for (let k = start; k <= end; k++) rank2[order[k].i] = start + end + 2; // 2 × mean of ranks start+1 … end+1
    start = end + 1;
  }
  let observed = 0, total = 0;
  for (let i = 0; i < n; i++) {
    total += rank2[i];
    if (differences[i] * sign > 0) observed += rank2[i];
  }
  // Distribution of the sum of the ranks on the tested side.
  let dist = new Float64Array(total + 1);
  dist[0] = 1;
  for (let i = 0; i < n; i++) {
    const next = new Float64Array(total + 1);
    for (let w = 0; w <= total; w++) {
      if (!dist[w]) continue;
      next[w] += dist[w] / 2;
      next[w + rank2[i]] += dist[w] / 2;
    }
    dist = next;
  }
  let p = 0;
  for (let w = observed; w <= total; w++) p += dist[w];
  return Math.min(1, p);
}
const pText = (p) => (p < 0.001 ? 'p < 0.001' : 'p = ' + (p >= 0.1 ? p.toFixed(2) : p.toFixed(3)));
function percent(fraction) {
  const pct = Math.abs(fraction) * 100;
  return (pct >= 0.1 ? pct.toFixed(1) : String(Number(pct.toPrecision(2)))) + ' %';
}

async function probe() {
  const m = await measure(baseDir);
  if (m.status) return putFailure(m);
  put('median', format(m.value));
  await checks(baseDir);
  put('status', 'ok');
}

async function pairs() {
  // Warm-up of the branch worktree; the merge-base had its own in the probe.
  const warm = await measure(branchDir);
  if (warm.status) return putFailure(warm);

  const rows = [];
  for (let i = 0; i < pairCount; i++) {
    const order = i % 2 === 0 ? ['base', 'branch'] : ['branch', 'base'];
    const got = {};
    for (const side of order) {
      const m = await measure(side === 'base' ? baseDir : branchDir);
      // The merge-base worked in the probe, so its failure here says nothing about the branch.
      if (m.status) return putFailure(m, side === 'base' ? 'base_failed' : m.status);
      got[side] = m.value;
    }
    rows.push([got.base, got.branch]);
  }
  const differences = rows.map(([base, branch]) => pairDifference(base, branch));
  fs.writeFileSync(path.join(outDir, 'pairs.tsv'),
    rows.map((r, i) => [r[0], r[1], differences[i]].join('\t')).join('\n') + '\n');

  const middle = median(differences); // NaN only for +Infinity next to -Infinity
  const pBetter = signedRankP(differences, 1);
  const pWorse = signedRankP(differences, -1);
  // A difference is reported only when the test finds it AND the median points the same way.
  let verdict = 'none';
  if (pBetter <= alpha && middle > 0) verdict = 'better';
  else if (pWorse <= alpha && middle < 0) verdict = 'worse';
  put('verdict', verdict);
  put('pairs', rows.length);
  put('p_better', pBetter);
  put('p_worse', pWorse);
  if (verdict !== 'none') {
    put('p', pText(verdict === 'better' ? pBetter : pWorse));
    put('pct', Number.isFinite(middle) ? percent(middle) : '');
  }
  put('median', format(median(rows.map((r) => r[1]))));
  put('base_median', format(median(rows.map((r) => r[0]))));

  await checks(branchDir);
  put('status', 'ok');
}

(mode === 'probe' ? probe() : pairs()).catch((e) => {
  put('detail', String(e && e.message));
  put('status', 'error');
});
MEASURE_JS
}

result() { cat "$DATA_DIR/$1/$2" 2>/dev/null || true; }

# "exit 1", "timed out after 600 s", ... for a result dir whose status isn't ok.
failure_reason() {
  case "$(result "$1" status)" in
    failed)      result "$1" detail;;
    timeout)     echo "timed out after ${MEASURE_TIMEOUT} s";;
    no_metric)   echo "no METRIC ${METRIC_NAME}=<number> line in the output";;
    worktree)    echo "git could not create a temporary worktree";;
    base_failed) echo "a run on the $TRUNK merge-base failed between the branch's runs: $(result "$1" detail)";;
    *)           echo "the measuring step broke: $(result "$1" detail)";;
  esac
}

# Check <ref> out into the temporary worktree <wt>, detached. The user's own
# checkout is never switched for measuring.
add_worktree() {
  local wt="$1" ref="$2" out="$3"
  mkdir -p "$DATA_DIR/$out"
  if git worktree add --detach "$wt" "$ref" > "$DATA_DIR/$out/worktree.log" 2>&1; then
    return 0
  fi
  echo "worktree" > "$DATA_DIR/$out/status"
  return 1
}

remove_worktree() {
  git worktree remove --force "$1" >/dev/null 2>&1 || true
}

# Put the session's current measure.sh / checks.sh at the same relative path
# inside the worktree, so they run from the session path.
prepare_worktree() {
  local session_path="$1/${SESSION_PREFIX}"
  mkdir -p "$session_path.auto" \
    && cp -p "$DATA_DIR/measure.sh" "$session_path.auto/measure.sh" \
    && { [ "$HAS_CHECKS" != "1" ] || cp -p "$DATA_DIR/checks.sh" "$session_path.auto/checks.sh"; }
}

# run_measure probe <out> <base worktree>
# run_measure pairs <out> <base worktree> <branch worktree>
# Never fails: the outcome is in $DATA_DIR/<out>/status.
run_measure() {
  local mode="$1" out="$2" base_wt="$3" branch_wt="${4:-}"
  local target="$base_wt" branch_path=""
  if [ "$mode" = "pairs" ]; then
    target="$branch_wt"
    branch_path="$branch_wt/${SESSION_PREFIX}"
  fi
  if prepare_worktree "$target"; then
    node "$DATA_DIR/measure.js" "$mode" "$base_wt/${SESSION_PREFIX}" "$branch_path" "$METRIC_NAME" "$PAIRS" \
      "$MEASURE_TIMEOUT" "$DATA_DIR/$out" "$HAS_CHECKS" "$DIRECTION" "$SIGNIFICANT" || true
  else
    echo "could not copy measure.sh into the worktree" > "$DATA_DIR/$out/detail"
  fi
  [ -s "$DATA_DIR/$out/status" ] || echo "error" > "$DATA_DIR/$out/status"
}

# "4.1 % better (p = 0.004)" / "no measurable change" for a measured branch.
verdict_text() {
  local out="$1" pct
  case "$(result "$out" verdict)" in
    better|worse)
      pct=$(result "$out" pct)
      echo "${pct:+$pct }$(result "$out" verdict) ($(result "$out" p))";;
    *) echo "no measurable change";;
  esac
}

# Write the lines that go under a branch's commit message to <out>/trailer.
write_trailer() {
  local out="$1" status base_status
  status=$(result "$out" status)
  base_status=$(result m.base status)
  local file="$DATA_DIR/$out/trailer"

  if [ "$base_status" = "timeout" ]; then
    echo "Measured alone: could not be measured (measure.sh timed out after ${MEASURE_TIMEOUT} s on the $TRUNK merge-base)" > "$file"
    return 0
  fi
  if [ "$base_status" != "ok" ]; then
    echo "Measured alone: could not be measured in a clean checkout (e.g. missing untracked dependencies)" > "$file"
    return 0
  fi
  if [ "$status" = "timeout" ]; then
    echo "Measured alone: FAILED ($(failure_reason "$out")) — this branch may depend on another one, or needs a longer --timeout" > "$file"
    return 0
  fi
  # Our own tooling broke, or the merge-base did, which says nothing about the branch.
  case "$status" in
    failed|no_metric|ok) ;;
    *) echo "Measured alone: could not be measured ($(failure_reason "$out"))" > "$file"; return 0;;
  esac
  if [ "$status" != "ok" ]; then
    echo "Measured alone: FAILED ($(failure_reason "$out")) — this branch may depend on another one" > "$file"
    return 0
  fi

  # A percentage only when the paired test finds the difference; noise is not a result.
  local pairs
  pairs=$(result "$out" pairs)
  case "$(result "$out" verdict)" in
    better|worse)
      echo "Measured alone, $pairs pairs against the $TRUNK merge-base: $METRIC_NAME $(verdict_text "$out")" > "$file";;
    *)
      echo "Measured alone: no measurable change against the $TRUNK merge-base ($pairs pairs)" > "$file";;
  esac

  case "$(result "$out" checks)" in
    passed) echo "Checks: passed" >> "$file";;
    "") ;;
    *)
      local reason
      if [ "$(result "$out" checks)" = "timeout" ]; then
        reason="timed out after ${MEASURE_TIMEOUT} s"
      else
        reason=$(result "$out" checks_detail)
      fi
      if [ "$(result m.base checks)" = "passed" ]; then
        echo "Checks: FAILED ($reason) — this branch may depend on another one" >> "$file"
      else
        echo "Checks: FAILED ($reason; they fail on the $TRUNK merge-base too)" >> "$file"
      fi;;
  esac
}

# Append the trailer to the branch's commit message. The branch isn't checked
# out anywhere, so: amend the detached HEAD of its worktree, then move the
# branch to the new commit. Only the message may change, so the tree is
# compared first (the union check ran on the old commit). --no-verify: the
# content already passed the user's hooks when the commit was made, and hooks
# tend to fail in a worktree without installed dependencies.
amend_branch() {
  local wt="$1" branch="$2" out="$3"
  local old new message="$DATA_DIR/$out/message"
  old=$(git rev-parse --verify --quiet "refs/heads/$branch" 2>/dev/null || true)
  [ -n "$old" ] || return 1
  [ "$(git -C "$wt" rev-parse HEAD 2>/dev/null || true)" = "$old" ] || return 1
  { git log -1 --format=%B "$old"; echo ""; cat "$DATA_DIR/$out/trailer"; } > "$message" 2>/dev/null || return 1
  git -C "$wt" commit --amend --quiet --no-verify --allow-empty -F "$message" \
    > "$DATA_DIR/$out/amend.log" 2>&1 || return 1
  new=$(git -C "$wt" rev-parse HEAD 2>/dev/null || true)
  [ -n "$new" ] || return 1
  [ "$(git rev-parse "$new^{tree}" 2>/dev/null)" = "$(git rev-parse "$old^{tree}" 2>/dev/null)" ] || return 1
  git update-ref "refs/heads/$branch" "$new" "$old" >/dev/null 2>&1 || return 1
  return 0
}

# Runs after the branches exist, the union check passed and the user's
# workspace is back. Nothing in here fails the script: a branch that doesn't
# work alone is a result to report.
measure_branches() {
  [ "$MEASURE" = true ] || return 0
  [ "${#CREATED_BRANCHES[@]}" -gt 0 ] || return 0

  echo ""
  info "═══ Measuring each branch on its own ═══"
  echo ""
  echo "  ${SESSION_PREFIX}.auto/measure.sh, ${MEASURE_TIMEOUT}s limit per run. Per branch: $PAIRS pairs of one merge-base run"
  echo "  and one branch run back to back (order alternating), so drift hits both alike."
  echo "  Each checkout is a clean temporary worktree: only committed files are there."
  echo ""

  WT_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/autoresearch-finalize.XXXXXX") || { WT_ROOT=""; }
  if [ -z "$WT_ROOT" ]; then
    MEASURE=false; MEASURE_SKIP_REASON="could not create a temporary folder"
    warn "Not measuring: $MEASURE_SKIP_REASON."
    return 0
  fi
  WT_ROOT=$(cd "$WT_ROOT" && pwd -P)
  write_measure_runner
  MEASURED=true

  # The merge-base worktree stays for the whole step: every branch's pairs run in it.
  # (Removed by cleanup_worktrees at the end and on every other exit path.)
  local base_wt="$WT_ROOT/wt-base" wt
  echo "  merge-base ($TRUNK): one run to see that it works in a clean checkout ..."
  if add_worktree "$base_wt" "$BASE" m.base; then
    run_measure probe m.base "$base_wt"
  fi
  if [ "$(result m.base status)" = "ok" ]; then
    echo "    ok ($METRIC_NAME $(result m.base median))"
  else
    warn "  The merge-base could not be measured ($(failure_reason m.base)), so the branches aren't measured either."
  fi

  local i branch out
  for i in $(seq 0 $((GROUP_COUNT - 1))); do
    branch="${GROUP_BRANCH[$i]:-skipped}"
    [ "$branch" != "skipped" ] && [ -n "$branch" ] || continue
    out="m.$i"
    wt="$WT_ROOT/wt-$i"
    echo "  $branch ..."
    if add_worktree "$wt" "$branch" "$out"; then
      if [ "$(result m.base status)" = "ok" ]; then
        run_measure pairs "$out" "$base_wt" "$wt"
      else
        echo "base" > "$DATA_DIR/$out/status"
      fi
      write_trailer "$out"
      sed 's/^/    /' "$DATA_DIR/$out/trailer"
      if ! amend_branch "$wt" "$branch" "$out"; then
        echo "failed" > "$DATA_DIR/$out/amend"
        warn "  Could not add the result to the commit message of $branch (the branch is unchanged)."
      fi
    else
      warn "  Could not create a temporary worktree for $branch: not measured."
    fi
    remove_worktree "$wt"
  done

  cleanup_worktrees
}

# The table in the summary.
print_measurements() {
  echo ""
  if [ "$MEASURED" != true ]; then
    if [ "${#CREATED_BRANCHES[@]}" -gt 0 ]; then
      echo "Measured alone: skipped ($MEASURE_SKIP_REASON)."
    fi
    return 0
  fi

  echo "Measured alone ($METRIC_NAME, $DIRECTION is better). Each branch against the $TRUNK merge-base in $PAIRS pairs"
  echo "of runs back to back, clean checkouts. Shown: the median difference of the pairs, and only"
  echo "when an exact signed-rank test finds it (one-sided p <= $SIGNIFICANT); otherwise \"no measurable change\"."
  echo ""
  local base_status
  base_status=$(result m.base status)
  if [ "$base_status" = "ok" ]; then
    printf '  %-44s %-28s %s\n' "$TRUNK merge-base" "reference" "$(checks_cell m.base)"
  else
    printf '  %-44s %s\n' "$TRUNK merge-base" "FAILED ($(failure_reason m.base))"
  fi

  local i branch out status alone=""
  for i in $(seq 0 $((GROUP_COUNT - 1))); do
    branch="${GROUP_BRANCH[$i]:-skipped}"
    [ "$branch" != "skipped" ] && [ -n "$branch" ] || continue
    out="m.$i"
    status=$(result "$out" status)
    if [ "$base_status" != "ok" ]; then
      printf '  %-44s %s\n' "${branch#autoresearch/${GOAL}/}" "not measured"
    elif [ "$status" = "ok" ]; then
      printf '  %-44s %-28s %s\n' "${branch#autoresearch/${GOAL}/}" "$(verdict_text "$out")" "$(checks_cell "$out")"
      case "$(result "$out" checks)" in passed|"") ;; *) [ "$(result m.base checks)" != "passed" ] || alone="$alone $out";; esac
    elif [ "$status" = "failed" ] || [ "$status" = "timeout" ] || [ "$status" = "no_metric" ]; then
      printf '  %-44s %s\n' "${branch#autoresearch/${GOAL}/}" "DOESN'T WORK ON ITS OWN ($(failure_reason "$out"))"
      alone="$alone $out"
    else
      printf '  %-44s %s\n' "${branch#autoresearch/${GOAL}/}" "not measured ($(failure_reason "$out"))"
    fi
    if [ "$(result "$out" amend)" = "failed" ]; then
      printf '  %-44s %s\n' "" "(result not written into the commit message)"
    fi
  done

  if [ "$base_status" != "ok" ]; then
    echo ""
    echo "  The $TRUNK merge-base itself can't be measured in a clean checkout, so nothing was compared."
    if [ "$base_status" = "timeout" ]; then
      echo "  measure.sh ran into the ${MEASURE_TIMEOUT} s limit: pass a longer --timeout <seconds>. Last output:"
    else
      echo "  Usual cause: measure.sh needs files that aren't committed (installed dependencies,"
      echo "  build output, data files). Last output:"
    fi
    echo ""
    result m.base tail | sed 's/^/    | /'
    echo ""
  fi

  if [ -n "$alone" ]; then
    echo ""
    echo "  Branches that don't work on their own most likely need a change from another branch."
    echo "  Merge those groups into one and run again, or have them reviewed as a stack. Last output:"
    for out in $alone; do
      i="${out#m.}"
      echo ""
      echo "    ${GROUP_BRANCH[$i]}:"
      if [ "$(result "$out" status)" = "ok" ]; then
        result "$out" checks_tail | sed 's/^/    | /'
      else
        result "$out" tail | sed 's/^/    | /'
      fi
      echo ""
    done
  fi
}

checks_cell() {
  case "$(result "$1" checks)" in
    "")      echo "";;
    passed)  echo "checks passed";;
    timeout) echo "checks FAILED (timed out after ${MEASURE_TIMEOUT} s)";;
    *)       echo "checks FAILED ($(result "$1" checks_detail))";;
  esac
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

print_summary() {
  echo ""
  info "═══ Summary ═══"
  echo ""

  echo "Goal: $GOAL"
  echo "Base: ${BASE:0:12}"
  echo "Source branch: $ORIG_BRANCH"
  echo ""

  echo "Branches:"
  for i in $(seq 0 $((GROUP_COUNT - 1))); do
    local title body branch group_number
    title=$(cat "$DATA_DIR/$i.title")
    body=$(cat "$DATA_DIR/$i.body")
    branch="${GROUP_BRANCH[$i]:-skipped}"
    group_number=$(printf "%02d" $((i + 1)))
    echo ""
    echo "  $group_number. $title"
    echo "     Branch: $branch"
    echo "     Files: $(tr '\n' ' ' < "$DATA_DIR/$i.files")"
    echo ""
    echo "$body" | sed 's/^/     /'
  done

  print_measurements

  # Order matters: the session files go first (tracked, modified .auto/ files
  # would block the checkout), then leave the experiment branch (git won't
  # delete the branch you're on), then delete it.
  local cleanup=""
  if [ -n "$SESSION_DIR" ] && [ -e "$SESSION_DIR/.auto" ]; then
    cleanup="rm -r .auto && "
  fi
  cleanup="${cleanup}git checkout $(quote_arg "$TRUNK") && git branch -D $(quote_arg "$ORIG_BRANCH")"

  echo ""
  if [ -n "$cleanup" ] && [ -n "$SESSION_DIR" ]; then
    echo "Cleanup: after merging, delete the session files and the autoresearch branch"
    echo "(this discards the experiment log and ideas, so copy anything you want to keep first):"
    echo ""
    echo "  cd $(quote_arg "$SESSION_DIR")"
  else
    echo "Cleanup: after merging, delete the autoresearch branch:"
    echo ""
  fi
  echo "  $cleanup"

  # Read from the copy taken before stashing, not the working tree.
  if [ -f "$DATA_DIR/ideas" ]; then
    echo ""
    echo "Ideas backlog (from ${SESSION_PREFIX}.auto/ideas.md):"
    echo ""
    sed 's/^/  /' "$DATA_DIR/ideas"
  fi

  echo ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

usage() {
  echo "Usage: $0 [--no-measure] [--pairs <n>] [--timeout <seconds>] <groups.json>"
  exit 1
}

main() {
  local groups_file=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --no-measure) MEASURE=false;;
      --timeout)
        [ $# -ge 2 ] || usage
        MEASURE_TIMEOUT="$2"; shift;;
      --timeout=*) MEASURE_TIMEOUT="${1#--timeout=}";;
      --pairs)
        [ $# -ge 2 ] || usage
        PAIRS="$2"; shift;;
      --pairs=*) PAIRS="${1#--pairs=}";;
      -h|--help) usage;;
      -*) echo "Unknown option: $1" >&2; usage;;
      *)
        [ -z "$groups_file" ] || usage
        groups_file="$1";;
    esac
    shift
  done
  [ -n "$groups_file" ] || usage
  case "$MEASURE_TIMEOUT" in
    ""|*[!0-9]*|0*) echo "--timeout needs a whole number of seconds, 1 or more." >&2; exit 1;;
  esac
  # Length first, so the comparison below never sees a number bash can't hold.
  case "$PAIRS" in
    ""|*[!0-9]*|0*|????*) PAIRS="invalid";;
  esac
  if [ "$PAIRS" = "invalid" ] || [ "$PAIRS" -lt "$MIN_PAIRS" ] || [ "$PAIRS" -gt "$MAX_PAIRS" ]; then
    echo "--pairs needs a whole number from $MIN_PAIRS to $MAX_PAIRS. With fewer than $MIN_PAIRS pairs the test can never find a difference; use --no-measure to skip measuring." >&2
    exit 1
  fi

  # Ctrl-C and kill go through the EXIT trap, so temp worktrees are removed and
  # the workspace is restored there too.
  trap 'exit 130' INT TERM HUP
  trap on_early_exit EXIT

  # Parse first (the groups.json path may be relative to the cwd), find the
  # session dir and copy what we need from it, then do all git work from the
  # toplevel: `git diff --name-only` paths are relative to it, not to the cwd.
  parse_groups "$groups_file"
  locate_session
  capture_session
  cd "$REPO_ROOT" || fail "Cannot cd to repo root $REPO_ROOT."
  preflight
  create_branches
  verify_branches
  # Give the user's uncommitted work back before the (possibly long) measuring.
  restore_workspace
  measure_branches
  print_summary
  trap - EXIT
  cleanup_worktrees
  cleanup_data
}

main "$@"
