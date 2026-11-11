// Process and git helpers for the experiment tools.
//
// Rules learned the hard way (QA round 1):
//   - git is always run with an argument list, never through a shell. Descriptions are
//     model-written and often contain backticks or $(...), which bash would execute.
//   - A run ends when the main process exits, not when its output pipes close. A benchmark
//     that starts a background process would otherwise hold the pipes open and hang the run.
//   - "Revert" means: back to HEAD, staged changes included. `git checkout -- .` only
//     restores from the index, so a staged change survived it.

import { spawn } from "node:child_process"

export interface ShellResult {
  code: number | null
  output: string
  durationMs: number
  timedOut: boolean
}

/** How long to wait for remaining output after the main process exits. */
const DRAIN_MS = 300

/**
 * Run a program with arguments (no shell), merging stdout+stderr.
 * The process gets its own process group; on timeout, abort, or normal exit, the whole
 * group is killed, so stray background children don't outlive the run.
 */
export function run(
  file: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal; input?: string },
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const started = performance.now()
    const child = spawn(file, args, { cwd: opts.cwd, detached: true, env: process.env })
    let output = ""
    let timedOut = false
    let settled = false
    child.stdout.on("data", (d) => (output += d))
    child.stderr.on("data", (d) => (output += d))
    if (opts.input !== undefined) child.stdin.end(opts.input)
    else child.stdin.end()

    const killGroup = () => {
      try {
        process.kill(-child.pid!, "SIGKILL")
      } catch {}
    }
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener("abort", killGroup)
      child.stdout.destroy()
      child.stderr.destroy()
      resolve({ code, output, durationMs: performance.now() - started, timedOut })
    }

    const timer = setTimeout(() => {
      timedOut = true
      killGroup()
    }, opts.timeoutMs)
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
      output += String(err)
      finish(-1)
    })
  })
}

/** Run a user-supplied command line through bash (the benchmark command). */
export const bash = (command: string, cwd: string, timeoutMs: number, signal?: AbortSignal) =>
  run("bash", ["-c", command], { cwd, timeoutMs, signal })

export const git = (args: string[], cwd: string, input?: string) =>
  run("git", args, { cwd, timeoutMs: 60_000, input })

/** Everything in the session folder except the plugin's own state. */
const SCOPE = ["--", ".", ":(exclude).auto"]

export type KeepResult =
  | { ok: true; commit: string | null } // null = nothing to commit (no code change)
  | { ok: false; error: string }

/**
 * Commit the experiment's changes. `.auto/` is excluded: the session files change on
 * every run and would otherwise turn every keep into a commit (and add noise to the
 * branches finalize creates). If the commit fails, the changes are unstaged again so
 * a later discard can revert them.
 */
export async function commitKeep(cwd: string, message: string): Promise<KeepResult> {
  const add = await git(["add", "-A", ...SCOPE], cwd)
  if (add.code !== 0) return { ok: false, error: `git add failed:\n${add.output.trim()}` }

  const staged = await git(["diff", "--cached", "--quiet", ...SCOPE], cwd)
  if (staged.code === 0) return { ok: true, commit: null }

  const commit = await git(["commit", "-q", "-F", "-"], cwd, message)
  if (commit.code !== 0) {
    await git(["reset", "-q", ...SCOPE], cwd)
    return { ok: false, error: `git commit failed:\n${commit.output.trim()}` }
  }
  const head = await git(["rev-parse", "--short", "HEAD"], cwd)
  return { ok: true, commit: head.output.trim() }
}

/**
 * Put the session folder back to HEAD: staged and unstaged changes to tracked files,
 * newly added files, and untracked files and folders. `.auto/` and gitignored files stay.
 */
export async function revertToHead(cwd: string): Promise<{ ok: boolean; output: string }> {
  const restore = await git(["restore", "--source=HEAD", "--staged", "--worktree", ...SCOPE], cwd)
  // If restoring failed, stop: deleting untracked files on top of a half-done revert would
  // lose work while the tool reports that nothing was logged.
  if (restore.code !== 0) return { ok: false, output: restore.output.trim() }
  const clean = await git(["clean", "-fd", ...SCOPE], cwd)
  return { ok: clean.code === 0, output: [restore.output, clean.output].join("\n").trim() }
}
