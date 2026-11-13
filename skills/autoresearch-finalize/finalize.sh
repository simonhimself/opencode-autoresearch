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
#   - session files are only `.auto/` (any depth) and pi's legacy flat files at the session
#     root, so user files such as `lib/autoresearch.utils.js` are no longer dropped
#   - works from any folder inside the repo (e.g. a monorepo package): the session dir is
#     found by walking up to the nearest `.auto/`, then all git work runs from the toplevel
#   - every branch name is validated with `git check-ref-format` in preflight
#   - the printed cleanup commands run in a working order (remove session files, switch to
#     trunk, then delete the experiment branch)

# autoresearch-finalize — creates independent branches from an autoresearch session
#
# Usage: finalize.sh <groups.json>
#
# groups.json format:
# {
#   "base": "<full merge-base commit hash>",
#   "trunk": "main",
#   "final_tree": "<full HEAD hash of autoresearch branch>",
#   "goal": "short-slug",
#   "groups": [
#     {
#       "title": "Switch to forks pool",
#       "body": "Use forks instead of threads...\n\nExperiments: #3, #5\nMetric: 42.3s → 38.1s (-9.9%)",
#       "last_commit": "<full commit hash>",
#       "slug": "forks-pool"
#     }
#   ]
# }

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
# Session dir (absolute) and its path relative to the repo toplevel ("" or "pkg/app/").
SESSION_DIR=""
SESSION_PREFIX=""
REPO_ROOT=""
LEGACY_FILES="autoresearch.jsonl autoresearch.sh autoresearch.md autoresearch.ideas.md autoresearch.checks.sh autoresearch.config.json"

quote_arg() { printf '%q' "$1"; }
warn() { echo -e "${YELLOW}⚠ $1${NC}"; }
info() { echo -e "${GREEN}$1${NC}"; }
cleanup_data() { if [ -d "${DATA_DIR:-}" ]; then rm -rf "$DATA_DIR"; fi; }
fail() { cleanup_data; echo -e "${RED}ERROR: $1${NC}" >&2; exit 1; }

# Takes a repo-root-relative path. Session files are anything under a `.auto`
# path component (any depth, so a session in a monorepo package is covered) and
# pi's legacy flat files, but only at the session root. Nothing else: a user
# file like `lib/autoresearch.utils.js` is real code and must be kept.
is_session_file() {
  case "/$1/" in
    */.auto/*) return 0;;
  esac
  local legacy
  for legacy in $LEGACY_FILES; do
    [ "$1" = "${SESSION_PREFIX}${legacy}" ] && return 0
  done
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

# Find the session dir: the nearest folder from the cwd up to the repo toplevel
# that holds `.auto/` (or legacy `autoresearch.jsonl`); the cwd if none does.
locate_session() {
  REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || fail "Not inside a git repository."
  REPO_ROOT=$(cd "$REPO_ROOT" && pwd -P)
  local dir
  dir=$(pwd -P)
  SESSION_DIR="$dir"
  while :; do
    if [ -d "$dir/.auto" ] || [ -f "$dir/autoresearch.jsonl" ]; then
      SESSION_DIR="$dir"
      break
    fi
    [ "$dir" = "$REPO_ROOT" ] && break
    case "$dir" in "$REPO_ROOT"/*) ;; *) break;; esac
    dir=$(dirname "$dir")
  done
  SESSION_PREFIX=$(cd "$SESSION_DIR" && git rev-parse --show-prefix)
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
fs.writeFileSync(outDir + '/final_tree', config.final_tree);
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
  FINAL_TREE=$(cat "$DATA_DIR/final_tree")
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
  git rev-parse "$BASE" >/dev/null 2>&1 || fail "Base commit $BASE not found."
  git rev-parse "$FINAL_TREE" >/dev/null 2>&1 || fail "Final tree commit $FINAL_TREE not found."
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

  assert_on_feature_branch
  assert_commits_exist

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
  echo "  Base:       ${BASE:0:12}"
  echo "  Groups:     $GROUP_COUNT"
}

# ---------------------------------------------------------------------------
# Create branches
# ---------------------------------------------------------------------------

rollback_on_failure() {
  local exit_code=$?
  if [ $exit_code -eq 0 ]; then return; fi

  echo ""
  echo -e "${RED}FAILED — rolling back...${NC}"
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
  restore_workspace || true
  cleanup_data
}

# Copy the ideas backlog now, before stashing hides it, so the summary can show it.
capture_ideas() {
  local ideas_file=""
  if [ -f "$SESSION_DIR/.auto/ideas.md" ]; then
    ideas_file=".auto/ideas.md"
  elif [ -f "$SESSION_DIR/autoresearch.ideas.md" ]; then
    ideas_file="autoresearch.ideas.md"
  fi
  if [ -n "$ideas_file" ]; then
    cp "$SESSION_DIR/$ideas_file" "$DATA_DIR/ideas" 2>/dev/null || true
    echo "${SESSION_PREFIX}${ideas_file}" > "$DATA_DIR/ideas_name"
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

warn_missing_metric_data() {
  for branch in ${CREATED_BRANCHES[@]+"${CREATED_BRANCHES[@]}"}; do
    local msg short
    msg=$(git log -1 --format="%B" "$branch" 2>/dev/null || echo "")
    if ! echo "$msg" | grep -qiE '(metric|→|->|%\))'; then
      short=$(git log -1 --oneline "$branch" 2>/dev/null | head -c 80)
      warn "Commit $short — no metric data in message"
    fi
  done
}

verify_branches() {
  echo ""
  info "═══ Verifying ═══"
  echo ""

  local errors=0

  verify_union_matches_original || errors=$((errors + 1))
  verify_no_session_artifacts || errors=$((errors + 1))
  verify_no_empty_commits || errors=$((errors + $?))
  warn_missing_metric_data

  echo ""
  if [ $errors -gt 0 ]; then
    restore_workspace || true
    echo -e "${RED}Verification failed with $errors error(s).${NC}"
    echo -e "${RED}Branches are intact — inspect and fix manually, or delete and retry.${NC}"
    echo "  Branches: ${CREATED_BRANCHES[*]:-}"
    echo "  You are on: $(git branch --show-current 2>/dev/null || echo 'detached')"
    cleanup_data
    exit 1
  fi
  info "✓ All checks passed."
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

  # Order matters: the session files go first (tracked, modified .auto/ files
  # would block the checkout), then leave the experiment branch (git won't
  # delete the branch you're on), then delete it.
  local cleanup="" legacy legacy_present=""
  if [ -e "$SESSION_DIR/.auto" ]; then
    cleanup="rm -r .auto && "
  fi
  for legacy in $LEGACY_FILES; do
    if [ -e "$SESSION_DIR/$legacy" ]; then legacy_present="$legacy_present $legacy"; fi
  done
  if [ -n "$legacy_present" ]; then
    cleanup="${cleanup}rm -f${legacy_present} && "
  fi
  cleanup="${cleanup}git checkout $(quote_arg "$TRUNK") && git branch -D $(quote_arg "$ORIG_BRANCH")"

  echo ""
  echo "Cleanup — after merging, delete the session files and the autoresearch branch"
  echo "(this discards the experiment log and ideas, so copy anything you want to keep first):"
  echo ""
  echo "  cd $(quote_arg "$SESSION_DIR")"
  echo "  $cleanup"

  # Read from the copy taken before stashing, not the working tree.
  if [ -f "$DATA_DIR/ideas" ]; then
    echo ""
    echo "Ideas backlog (from $(cat "$DATA_DIR/ideas_name")):"
    echo ""
    sed 's/^/  /' "$DATA_DIR/ideas"
  fi

  echo ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  if [ $# -lt 1 ]; then
    echo "Usage: $0 <groups.json>"
    exit 1
  fi

  # Parse first (the groups.json path may be relative to the cwd), find the
  # session dir and grab the ideas from it, then do all git work from the
  # toplevel: `git diff --name-only` paths are relative to it, not to the cwd.
  parse_groups "$1"
  locate_session
  capture_ideas
  cd "$REPO_ROOT" || fail "Cannot cd to repo root $REPO_ROOT."
  preflight
  create_branches
  verify_branches
  restore_workspace
  print_summary
  trap - EXIT
  cleanup_data
}

main "$@"
