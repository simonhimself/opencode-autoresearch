// Process and git helpers for the experiment tools.
//
// Rules learned the hard way (QA rounds and the adversarial review):
//   - git is always run with an argument list, never through a shell. Descriptions are
//     model-written and often contain backticks or $(...), which bash would execute.
//   - A run ends when the main process exits, not when its output pipes close. A benchmark
//     that starts a background process would otherwise hold the pipes open and hang the run.
//   - "Revert" means: back to HEAD, staged changes included. `git checkout -- .` only
//     restores from the index, so a staged change survived it.
//   - git is stopped with SIGTERM, not SIGKILL: a killed git leaves .git/index.lock behind
//     and every later keep and discard then fails on the lock.
//   - Output is capped while it's captured. One benchmark printed a 3 MB line and all of
//     it reached the model.
//   - Every git call runs with hooks off. The plugin calls git many times per experiment,
//     and a user's post-index-change (or post-checkout…) hook ran on each of them.

import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFile, lstat, mkdtemp, readdir, readFile, readlink, rm, stat, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"

export interface ShellResult {
  code: number | null
  /** stdout+stderr, at most `MAX_OUTPUT_BYTES` (the tail is kept). */
  output: string
  durationMs: number
  timedOut: boolean
}

/** How long to wait for remaining output after the main process exits. */
const DRAIN_MS = 300
/** setTimeout's maximum; larger values overflow to 1 ms and would kill the run at once. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1
/** Captured output per process. The tail is kept: METRIC lines and errors come last. */
export const MAX_OUTPUT_BYTES = 1024 * 1024
/** Lines longer than this are cut before output is shown to the model. */
export const MAX_LINE_CHARS = 2000
/** git gets this long; hooks are skipped and nothing prompts, so longer means something is stuck. */
export const GIT_TIMEOUT_MS = 120_000
/** After SIGTERM, how long git gets to remove its lock files before SIGKILL. */
const GIT_TERM_GRACE_MS = 5_000

/** A usable timeout: invalid, zero or negative values fall back, huge values are capped. */
export function clampTimeout(ms: number, fallbackMs: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return fallbackMs
  return Math.min(Math.max(ms, 1_000), MAX_TIMEOUT_MS)
}

/** The last `maxLines` lines, each cut to `MAX_LINE_CHARS`, so a tool result stays small. */
export function tailLines(text: string, maxLines: number): string {
  return text
    .trimEnd()
    .split("\n")
    .slice(-maxLines)
    .map((line) =>
      line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)} … (line cut, ${line.length} characters)` : line,
    )
    .join("\n")
}

export interface RunOptions {
  cwd: string
  timeoutMs: number
  signal?: AbortSignal
  input?: string
  /** Extra environment variables. */
  env?: Record<string, string>
  /**
   * On timeout send SIGTERM first and SIGKILL this many ms later. Without it the process
   * group is killed at once (right for benchmarks, wrong for git; see the header).
   */
  termGraceMs?: number
}

/**
 * Run a program with arguments (no shell), merging stdout+stderr.
 * The process gets its own process group; on timeout, abort, or normal exit, the whole
 * group is killed, so stray background children don't outlive the run.
 */
export function run(file: string, args: string[], opts: RunOptions): Promise<ShellResult> {
  return new Promise((resolve) => {
    const started = performance.now()
    const child = spawn(file, args, { cwd: opts.cwd, detached: true, env: { ...process.env, ...opts.env } })
    // Output is kept as chunks and trimmed from the front once it passes twice the cap,
    // so memory stays bounded however much the command prints.
    let chunks: Buffer[] = []
    let held = 0
    let dropped = 0
    const capture = (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk
      chunks.push(buf)
      held += buf.length
      if (held > MAX_OUTPUT_BYTES * 2) {
        const all = Buffer.concat(chunks)
        const kept = all.subarray(all.length - MAX_OUTPUT_BYTES)
        dropped += all.length - kept.length
        chunks = [kept]
        held = kept.length
      }
    }
    const collect = () => {
      let all = Buffer.concat(chunks)
      if (all.length > MAX_OUTPUT_BYTES) {
        dropped += all.length - MAX_OUTPUT_BYTES
        all = all.subarray(all.length - MAX_OUTPUT_BYTES)
      }
      return (dropped ? `[… ${dropped} bytes of earlier output dropped …]\n` : "") + all.toString("utf8")
    }

    let timedOut = false
    let settled = false
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    child.stdout.on("data", capture)
    child.stderr.on("data", capture)
    // A command that doesn't read stdin closes the pipe; that must not crash the plugin.
    child.stdin.on("error", () => {})
    if (opts.input !== undefined) child.stdin.end(opts.input)
    else child.stdin.end()

    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, signal)
      } catch {}
    }
    const killGroup = () => signalGroup("SIGKILL")
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(graceTimer)
      opts.signal?.removeEventListener("abort", killGroup)
      child.stdout.destroy()
      child.stderr.destroy()
      resolve({ code, output: collect(), durationMs: performance.now() - started, timedOut })
    }

    const timer = setTimeout(
      () => {
        timedOut = true
        if (opts.termGraceMs === undefined) return killGroup()
        signalGroup("SIGTERM")
        graceTimer = setTimeout(killGroup, opts.termGraceMs)
      },
      clampTimeout(opts.timeoutMs, 60_000),
    )
    opts.signal?.addEventListener("abort", killGroup, { once: true })

    child.on("exit", (code) => {
      // Clean up anything the command left running in its group, then give the pipes a
      // moment to deliver the last output. A child that escaped the group (setsid) can
      // still hold them open, so don't wait for "close" forever.
      killGroup()
      const drain = setTimeout(() => finish(code), DRAIN_MS)
      child.once("close", () => {
        clearTimeout(drain)
        finish(code)
      })
    })
    child.on("error", (err) => {
      capture(String(err))
      finish(-1)
    })
  })
}

/** Run a command line through bash (the benchmark and the checks). */
export const bash = (command: string, cwd: string, timeoutMs: number, signal?: AbortSignal) =>
  run("bash", ["-c", command], { cwd, timeoutMs, signal })

export interface GitOptions {
  input?: string
  env?: Record<string, string>
  /** For tests; the default is GIT_TIMEOUT_MS. */
  timeoutMs?: number
}

/**
 * Hooks off, for every git call the plugin makes. Not only commit hooks: git runs
 * post-index-change whenever an index is written (also our temporary ones) and
 * post-checkout on restores; a slow or failing hook there stalls or breaks the loop, and a
 * hook with side effects would run dozens of times per experiment. The user's hooks still
 * apply to what they do themselves and to what they merge later.
 */
export const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"]

/**
 * Run git with an argument list. On timeout it gets SIGTERM (so it removes its lock
 * files), SIGKILL only if it ignores that, and the output says "timed out".
 * GIT_TERMINAL_PROMPT=0: nobody is there to answer a credentials prompt.
 * NO_HOOKS is put in front unless the caller's list already starts with it (the exported
 * command constants do, so the permission prompt shows the command exactly as it runs).
 */
export async function git(args: string[], cwd: string, options: GitOptions = {}): Promise<ShellResult> {
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS
  if (args[0] !== NO_HOOKS[0] || args[1] !== NO_HOOKS[1]) args = [...NO_HOOKS, ...args]
  const res = await run("git", args, {
    cwd,
    timeoutMs,
    input: options.input,
    env: { GIT_TERMINAL_PROMPT: "0", ...options.env },
    termGraceMs: GIT_TERM_GRACE_MS,
  })
  if (res.timedOut) {
    const what = args.find((a) => !a.startsWith("-") && !a.includes("=")) ?? "command"
    res.output = `${res.output.trimEnd()}\ngit ${what} timed out after ${Math.round(timeoutMs / 1000)} s and was stopped.`.trim()
  }
  return res
}

/**
 * Everything in the session folder except session state: any `.auto` folder at any depth
 * (in a monorepo, other packages have their own). Glob excludes also work when `.auto` is
 * gitignored; a plain `:(exclude).auto` makes `git add` fail on an ignored path.
 */
export const SCOPE = ["--", ".", ":(exclude,glob)**/.auto/**", ":(exclude,glob)**/.auto"]

// The git commands that change the repo, as argument lists. They're exported so the
// permission check can show the user exactly what will run.
export const GIT_ADD = [...NO_HOOKS, "add", "-A", ...SCOPE]
/**
 * Experiment commits skip hooks and signing: a hook that runs lint or tests, or a signing
 * prompt with no terminal, hangs or fails an unattended loop. The user's hooks still apply
 * to whatever they merge later.
 * `--no-verify` only skips pre-commit and commit-msg; prepare-commit-msg and post-commit
 * would still run (and a hanging post-commit fails the call after HEAD has moved), so the
 * hooks folder is pointed at nothing as well.
 */
export const GIT_COMMIT = [
  ...NO_HOOKS,
  "-c",
  "commit.gpgsign=false",
  "commit",
  "--no-verify",
  "-q",
  "-F",
  "-",
  ...SCOPE,
]
export const GIT_RESTORE = [...NO_HOOKS, "restore", "--source=HEAD", "--staged", "--worktree", ...SCOPE]
export const GIT_CLEAN = [...NO_HOOKS, "clean", "-fd", ...SCOPE]
/**
 * The swap of a paired confirmation (see swapScope). Two tree ids follow at run time, so
 * this prefix is what the permission prompt shows and what "always allow" can match.
 */
export const GIT_SWAP = [...NO_HOOKS, "read-tree", "-m", "-u"]

/** A git argument list as the command line a person would type (for permission prompts). */
export const gitCommandLine = (args: string[]) =>
  ["git", ...args.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a}'`))].join(" ")

// ── Read-only questions about the repo ────────────────────

/** Full sha of HEAD, or null when the repo has no commits (or this isn't a repo). */
export async function headSha(cwd: string): Promise<string | null> {
  const res = await git(["rev-parse", "--verify", "-q", "HEAD"], cwd)
  return res.code === 0 ? res.output.trim() : null
}

/** The checked-out branch, or null on a detached HEAD. */
export async function currentBranch(cwd: string): Promise<string | null> {
  const res = await git(["symbolic-ref", "-q", "--short", "HEAD"], cwd)
  return res.code === 0 && res.output.trim() ? res.output.trim() : null
}

/**
 * Is this branch the project's trunk? `main`, `master`, or whatever origin/HEAD points
 * at. Experiments commit and revert freely, which must never happen there.
 */
export async function isTrunk(cwd: string, branch: string): Promise<boolean> {
  if (branch === "main" || branch === "master") return true
  const res = await git(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], cwd)
  return res.code === 0 && res.output.trim().replace(/^origin\//, "") === branch
}

/**
 * `git status --short` for the scope: "" when the scope has no uncommitted changes and
 * no untracked files. Untracked files are listed one by one, so the `.auto` exclude works
 * on them and the user sees exactly which files are in the way.
 */
export async function scopeStatus(cwd: string): Promise<{ ok: true; status: string } | { ok: false; error: string }> {
  const res = await git(["status", "--short", "--untracked-files=all", ...SCOPE], cwd)
  if (res.code !== 0) return { ok: false, error: res.output.trim() }
  return { ok: true, status: res.output.trimEnd() }
}

/**
 * Does git track anything in the scope? If not, the folder is an untracked project inside
 * a bigger repo, and reverting an experiment (`git clean`) would delete all of it.
 */
export async function scopeHasTrackedFiles(cwd: string): Promise<boolean> {
  const res = await git(["ls-files", ...SCOPE], cwd)
  return res.code === 0 && res.output.trim() !== ""
}

/** The tree of the HEAD commit (whole repo). Equal to scopeTreeHash() exactly when the scope has no diff to HEAD. */
export async function headTree(cwd: string): Promise<string | null> {
  const res = await git(["rev-parse", "--verify", "-q", "HEAD^{tree}"], cwd)
  return res.code === 0 ? res.output.trim() : null
}

/**
 * The tree a keep would commit right now: HEAD with the scope replaced by what's in the
 * working tree (untracked files included, ignored files and `.auto` not).
 *
 * This is the fingerprint that ties a measurement to code. It's computed in a temporary
 * index, so the user's real index is never touched. The temporary index starts as a copy
 * of the real one reset to HEAD: that keeps git's file-stat cache, so unchanged files
 * aren't re-read (matters in big repos); anything staged is dropped from the copy, so the
 * result doesn't depend on what happens to be staged.
 */
export async function scopeTreeHash(cwd: string): Promise<{ ok: true; tree: string } | { ok: false; error: string }> {
  return withScopeIndex(cwd, async (tree) => ({ ok: true as const, tree }))
}

/**
 * Build the temporary index described at scopeTreeHash, write its tree, and hand both to
 * `then` while the index still exists (the swap needs an index that matches the files).
 */
async function withScopeIndex<T>(
  cwd: string,
  then: (tree: string, env: Record<string, string>) => Promise<T>,
): Promise<T | { ok: false; error: string }> {
  const dir = await mkdtemp(join(tmpdir(), "autoresearch-index-"))
  const env = { GIT_INDEX_FILE: join(dir, "index") }
  try {
    let seeded = false
    const real = await git(["rev-parse", "--git-path", "index"], cwd)
    if (real.code === 0) {
      const path = real.output.trim()
      const copied = await copyIndex(isAbsolute(path) ? path : join(cwd, path), env.GIT_INDEX_FILE)
      // -m keeps stat data for entries that match HEAD. It fails on an index with
      // conflicts; then start from an empty one below.
      if (copied) seeded = (await git(["read-tree", "-m", "HEAD"], cwd, { env })).code === 0
    }
    if (!seeded) {
      await rm(env.GIT_INDEX_FILE, { force: true })
      const read = await git(["read-tree", "HEAD"], cwd, { env })
      if (read.code !== 0) return { ok: false, error: `git read-tree failed: ${read.output.trim()}` }
    }
    const add = await git(GIT_ADD, cwd, { env })
    if (add.code !== 0) return { ok: false, error: `git add (temporary index) failed: ${add.output.trim()}` }
    const tree = await git(["write-tree"], cwd, { env })
    if (tree.code !== 0) return { ok: false, error: `git write-tree failed: ${tree.output.trim()}` }
    return await then(tree.output.trim(), env)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Make the scope's files equal `target`, a tree that scopeTreeHash() produced earlier (the
 * candidate's fingerprint) or HEAD's tree. This is the swap of the paired confirmation:
 * candidate → HEAD → candidate → HEAD → candidate.
 *
 * How: a temporary index is filled with the files as they are now (tree A), then
 * `git read-tree -m -u A target` moves index and files from A to the target. That is the
 * machinery behind `git checkout <branch>`, and it has the properties the swap needs:
 *   - Only paths that differ between A and the target are written or deleted. Both trees
 *     are "HEAD with the scope replaced", so `.auto/`, other packages of a monorepo and
 *     their uncommitted changes are equal on both sides and never touched.
 *   - Ignored files are in neither tree (git add skips them), so node_modules and build
 *     caches stay. The one way to lose one: the target has a file at a path where an
 *     ignored file sits now, and read-tree overwrites ignored files without asking (git
 *     ≥ 2.34). So that case is looked for first and refused (occupiedPaths).
 *   - Unchanged files keep their mtime; changed ones get a new one, so a benchmark that
 *     builds incrementally rebuilds what was swapped, as after a checkout.
 *   - The real index and HEAD are never touched. Everything the files held before is in
 *     git's object store as tree A, so no state is lost even if something goes wrong.
 * Afterwards the result is checked by hashing the files again: equal to `target` or an error.
 *
 * A swap never overwrites a file nobody told it about. The caller says where the files
 * are expected to be:
 * - `expect.exactly`: the files must hash to this tree (the steps of a confirmation: the
 *   candidate before going to HEAD, HEAD before going back). An edit made meanwhile, by a
 *   parallel tool call or by the user, is refused instead of silently replaced.
 * - `expect.oneOf`: every path must equal its version in one of these trees or in the
 *   target (putting the candidate back after an abort, and crash recovery, where a swap
 *   may be half done). A path at none of these versions is someone's edit: refused.
 * A refusal for these reasons, or for an ignored file in the way, has `untouched: true`:
 * nothing on disk was changed.
 */
export async function swapScope(
  cwd: string,
  target: string,
  expect?: { exactly: string } | { oneOf: string[] },
): Promise<{ ok: true; from: string } | { ok: false; error: string; from?: string; untouched?: true }> {
  const names = (paths: string[]) => `${paths.slice(0, 10).join(", ")}${paths.length > 10 ? ", …" : ""}`
  const swapped = await withScopeIndex(cwd, async (from, env) => {
    if (from === target) return { ok: true as const, from }
    const refuse = (error: string) => ({ ok: false as const, from, error, untouched: true as const })
    if (expect) {
      const foreign = await foreignPaths(cwd, from, "exactly" in expect ? [expect.exactly] : [target, ...expect.oneOf])
      if (foreign === null) return refuse("git diff failed while checking the working tree")
      if (foreign.length) return refuse(`these files were changed by something else: ${names(foreign)}`)
    }
    const occupied = await occupiedPaths(cwd, from, target)
    if (occupied === null) return refuse("git diff failed while checking the working tree")
    if (occupied.length) return refuse(`gitignored files are in the way and would be overwritten: ${names(occupied)}`)
    const res = await git([...GIT_SWAP, from, target], cwd, { env })
    if (res.code !== 0) return { ok: false as const, from, error: `git read-tree failed: ${res.output.trim()}` }
    return { ok: true as const, from }
  })
  if (!swapped.ok) return swapped
  if (swapped.from === target) return swapped
  // Trust nothing: hash what is on disk now. (A changed submodule pointer, for one, is
  // something read-tree doesn't check out.)
  const after = await scopeTreeHash(cwd)
  if (!after.ok) return { ok: false, from: swapped.from, error: after.error }
  if (after.tree !== target) {
    return { ok: false, from: swapped.from, error: "the files don't match the expected tree after the swap (submodules, or files changed meanwhile)" }
  }
  return swapped
}

/**
 * Paths that `target` has and `from` doesn't, but where something exists on disk. `from`
 * is the tree of the files as they are (ignored ones left out), so whatever sits there is
 * an ignored file or folder, which the swap would overwrite or replace. Null when git fails.
 */
async function occupiedPaths(cwd: string, from: string, target: string): Promise<string[] | null> {
  const added = await git(["diff", "--name-only", "--no-renames", "--diff-filter=A", "-z", from, target], cwd)
  const top = await git(["rev-parse", "--show-toplevel"], cwd)
  if (added.code !== 0 || top.code !== 0) return null
  const root = top.output.trim()
  const occupied: string[] = []
  for (const path of added.output.split("\0").filter(Boolean)) {
    // The path itself, or a parent that is a file where a folder is needed.
    const parts = path.split("/")
    for (let i = parts.length; i >= 1; i--) {
      const info = await lstat(join(root, ...parts.slice(0, i))).catch(() => null)
      if (!info) continue
      if (i === parts.length || !info.isDirectory()) occupied.push(parts.slice(0, i).join("/"))
      break
    }
  }
  return [...new Set(occupied)]
}

/** Paths whose version in `tree` equals none of their versions in `known`. Null when git fails. */
async function foreignPaths(cwd: string, tree: string, known: string[]): Promise<string[] | null> {
  let foreign: string[] | undefined
  for (const other of known) {
    const res = await git(["diff", "--name-only", "--no-renames", "-z", tree, other], cwd)
    if (res.code !== 0) return null
    const differing = new Set(res.output.split("\0").filter(Boolean))
    foreign = foreign === undefined ? [...differing] : foreign.filter((p) => differing.has(p))
  }
  return foreign ?? []
}

/**
 * Lines added and removed between two trees (binary files count as 0). With HEAD's tree
 * and a candidate's fingerprint tree this is the experiment's whole diff, new files included.
 */
export async function diffLineCounts(cwd: string, treeA: string, treeB: string): Promise<{ added: number; removed: number } | null> {
  const res = await git(["diff", "--numstat", "--no-renames", treeA, treeB], cwd)
  if (res.code !== 0) return null
  let added = 0
  let removed = 0
  for (const line of res.output.split("\n")) {
    const m = line.match(/^(\d+)\t(\d+)\t/)
    if (m) {
      added += Number(m[1])
      removed += Number(m[2])
    }
  }
  return { added, removed }
}

/**
 * Copy an index file and give the copy an OLDER timestamp than the original.
 *
 * git decides "this file is unchanged" from cached size and mtime, and protects itself
 * against edits made in the same second as the index was written by re-reading every file
 * that is as new as the index file. A plain copy has a newer timestamp, which switches
 * that protection off: a same-size edit right after a commit then hashed as unchanged
 * (seen in testing). An older timestamp only makes git re-read a few more files.
 */
async function copyIndex(from: string, to: string): Promise<boolean> {
  try {
    const { atime, mtime } = await stat(from)
    await copyFile(from, to)
    await utimes(to, atime, new Date(mtime.getTime() - 2_000))
    return true
  } catch {
    return false
  }
}

/** Files that differ between two trees (for "the benchmark changed these files"). */
export async function changedBetween(cwd: string, treeA: string, treeB: string): Promise<string[]> {
  const res = await git(["diff", "--name-only", treeA, treeB], cwd)
  return res.code === 0 ? res.output.split("\n").filter(Boolean) : []
}

/** sha256 of a file's content, or null when it doesn't exist. Used to freeze the benchmark per segment. */
export async function fileHash(path: string): Promise<string | null> {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex")
  } catch {
    return null
  }
}

/** Files under `.auto/` that are session state, not benchmark input: they change during a session by design. */
const UNFROZEN = new Set(["log.jsonl", "ideas.md", "config.json", "prompt.md"])
/** Hashed on their own (measure_hash, checks_hash), so not part of the inputs hash. */
const BENCHMARK_SCRIPTS = new Set(["measure.sh", "checks.sh"])

export interface FrozenInputs {
  /** One hash over all files below; equal hashes mean equal files. */
  hash: string
  /** Path relative to `.auto/` → content hash, to say WHICH file changed. */
  files: Record<string, string>
}

/**
 * Everything else under `.auto/`: helper files a benchmark may read (a workload size, test
 * data, a script it sources). They're frozen with the benchmark, because a benchmark that
 * read `.auto/scale` was "improved" by editing that file while measure.sh's hash stayed
 * the same. `.auto/` is outside the scope, so the tree fingerprint doesn't see these files.
 */
export async function frozenInputs(autoDir: string): Promise<FrozenInputs> {
  const files: Record<string, string> = {}
  const walk = async (dir: string, prefix: string) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // no .auto/ yet
    }
    for (const entry of entries) {
      const rel = prefix + entry.name
      if (!prefix && (UNFROZEN.has(entry.name) || BENCHMARK_SCRIPTS.has(entry.name))) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path, `${rel}/`)
      else if (entry.isSymbolicLink()) files[rel] = `link:${await readlink(path).catch(() => "?")}`
      else files[rel] = (await fileHash(path)) ?? "unreadable"
    }
  }
  await walk(autoDir, "")
  const hash = createHash("sha256")
  for (const rel of Object.keys(files).sort()) hash.update(`${rel}\0${files[rel]}\n`)
  return { hash: hash.digest("hex"), files }
}

/** Names of the files that differ between two frozenInputs() results. */
export function changedInputs(a: Record<string, string>, b: Record<string, string>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort()
}

/**
 * `git status` of the benchmark scripts, "" when both are exactly as committed at HEAD.
 * Untracked ("??"), ignored ("!!"), modified, staged and mode changes all show up.
 */
export async function benchmarkScriptStatus(cwd: string): Promise<{ ok: true; status: string } | { ok: false; error: string }> {
  const res = await git(["status", "--porcelain", "--ignored", "--untracked-files=all", "--", ".auto/measure.sh", ".auto/checks.sh"], cwd)
  if (res.code !== 0) return { ok: false, error: res.output.trim() }
  return { ok: true, status: res.output.trimEnd() }
}

/**
 * `autoresearch/*` branches that hold a session for this folder (`.auto/prompt.md` at the
 * folder's path), newest commit first. Used when `/autoresearch` runs on a branch without
 * session files: the session is probably on one of these.
 */
export async function sessionBranches(cwd: string): Promise<string[]> {
  const list = await git(["branch", "--list", "autoresearch/*", "--sort=-committerdate", "--format=%(refname:short)"], cwd)
  if (list.code !== 0) return []
  const prefix = (await git(["rev-parse", "--show-prefix"], cwd)).output.trim()
  const found: string[] = []
  for (const branch of list.output.split("\n").filter(Boolean)) {
    if ((await git(["cat-file", "-e", `${branch}:${prefix}.auto/prompt.md`], cwd)).code === 0) found.push(branch)
  }
  return found
}

// ── Commands that change the repo ─────────────────────────

export type KeepResult =
  | { ok: true; commit: string | null; sha: string | null } // null = nothing to commit (no code change)
  | { ok: false; error: string }

/**
 * Commit the experiment's changes. `.auto/` is excluded: the session files change on
 * every run and would otherwise turn every keep into a commit (and add noise to the
 * branches finalize creates). If the commit fails, the changes are unstaged again so
 * a later discard can revert them.
 */
export async function commitKeep(cwd: string, message: string): Promise<KeepResult> {
  const add = await git(GIT_ADD, cwd)
  if (add.code !== 0) return { ok: false, error: `git add failed:\n${add.output.trim()}` }

  const staged = await git(["diff", "--cached", "--quiet", ...SCOPE], cwd)
  if (staged.code === 0) return { ok: true, commit: null, sha: null }

  // Commit only this scope: anything staged elsewhere (other folders, .auto/) stays out.
  const commit = await git(GIT_COMMIT, cwd, { input: message })
  if (commit.code !== 0) {
    await git(["reset", "-q", ...SCOPE], cwd)
    return { ok: false, error: `git commit failed:\n${commit.output.trim()}` }
  }
  const sha = await headSha(cwd)
  return { ok: true, commit: sha?.slice(0, 7) ?? null, sha }
}

/**
 * Put the session folder back to HEAD: staged and unstaged changes to tracked files,
 * newly added files, and untracked files and folders. `.auto/` and gitignored files stay.
 */
export async function revertToHead(cwd: string): Promise<{ ok: boolean; output: string }> {
  if ((await headSha(cwd)) === null) {
    return { ok: false, output: "This repository has no commits yet. Make an initial commit, then try again." }
  }
  // Nothing tracked here means the whole folder is untracked: `git clean` would delete the
  // project. (It did, once.) autoresearch_init refuses such a folder; this is the backstop.
  if (!(await scopeHasTrackedFiles(cwd))) {
    return {
      ok: false,
      output: "git tracks no files in this folder, so reverting would delete everything in it. Commit the project first.",
    }
  }
  const restore = await git(GIT_RESTORE, cwd)
  // If restoring failed, stop: deleting untracked files on top of a half-done revert would
  // lose work while the tool reports that nothing was logged.
  if (restore.code !== 0) return { ok: false, output: restore.output.trim() }
  const clean = await git(GIT_CLEAN, cwd)
  return { ok: clean.code === 0, output: [restore.output, clean.output].join("\n").trim() }
}
