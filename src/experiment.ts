// The experiment tools: autoresearch_init, _run, _log and _pause.
//
// Rule of thumb for everything here: the plugin decides, the agent proposes. The agent
// can't choose what is measured (always ./.auto/measure.sh, frozen per segment by hash,
// together with every helper file under .auto/), can't type in a result (the plugin
// records what it measured), and can't decide a keep (the plugin measures the last commit
// and the candidate back to back and judges). What it can do: change code, ask for a
// measurement, and say what it thinks the result means.
//
// The logic talks to OpenCode only through `Host`, so the tests can drive it against real
// git repos with a small fake.

import { createHash } from "node:crypto"
import { accessSync, constants, existsSync } from "node:fs"
import {
  bash,
  benchmarkScriptStatus,
  changedBetween,
  changedInputs,
  commitKeep,
  currentBranch,
  diffLineCounts,
  fileHash,
  frozenInputs,
  GIT_ADD,
  GIT_CLEAN,
  GIT_COMMIT,
  GIT_RESTORE,
  GIT_SWAP,
  gitCommandLine,
  headSha,
  headTree,
  isTrunk,
  revertToHead,
  scopeHasTrackedFiles,
  scopeStatus,
  scopeTreeHash,
  swapScope,
  tailLines,
  type ShellResult,
} from "./shell.ts"
import {
  appendLog,
  autoDir,
  checksPath,
  confirmationRuns,
  countRuns,
  currentRun,
  currentSegment,
  gainText,
  halfRuns,
  isBetter,
  judge,
  mad,
  measurePath,
  median,
  noImprovementStreak,
  parseMetrics,
  promptPath,
  readLog,
  readSettings,
  relativeGain,
  sampleList,
  segmentSummaries,
  type SegmentSummary,
  type ConfigEntry,
  type Direction,
  type LogEntry,
  type RunEntry,
  type RunStatus,
  type Settings,
  type Verdict,
} from "./state.ts"

export const MEASURE_COMMAND = "./.auto/measure.sh"
export const CHECKS_COMMAND = "./.auto/checks.sh"
const OUTPUT_TAIL_LINES = 80
const DEFAULT_REPEAT = 5
const MAX_REPEAT = 50

/** The parts of a tool call's context the tools need. */
export interface ToolCtx {
  sessionID: string
  agent: string
  messageID: string
  id: string
  signal?: AbortSignal
  progress?: (update: { status: string }) => Promise<void>
}

/** Persisted in plugin storage under `active/<sessionID>` while the loop is on. */
export interface ActiveState {
  directory: string
  /**
   * True when the loop was started without .auto/prompt.md: the agent is setting up and
   * may be waiting for the user's answers, so no nudges until setup is done (prompt.md and
   * a new config entry exist).
   */
  setup?: boolean
  /** Config entries in the log when setup started; a higher count means init has run. */
  setupConfigs?: number
  /**
   * When the loop was turned on (ISO time). The start-up continue uses it to tell the loop
   * it saw at plugin start from one that was stopped and started again since.
   */
  since?: string
  /**
   * Branch and HEAD the loop expects. Set by autoresearch_init and on resume, HEAD updated
   * after every log. If either differs when a tool runs, someone switched branches or
   * committed underneath, and reverting or committing would hit the wrong tree.
   */
  branch?: string
  head?: string
  /** Number of logged runs when the loop was turned on. */
  startRunCount: number
  /** Number of logged runs when we last auto-continued; detects a stalled agent. */
  lastRunCount: number
  /** Consecutive auto-continues with no new logged run. */
  stalls: number
  /** Consecutive turns that failed (provider errors). */
  failures: number
  /**
   * `/autoresearch off` arrived while an experiment was being measured: the agent may
   * still log that one run (so its changes are committed or reverted, not left behind),
   * then the loop turns off.
   */
  stopping?: boolean
}

/** What a measurement was taken on. A keep is refused unless all of it still holds. */
export interface Fingerprint {
  head: string
  branch: string
  /** scopeTreeHash(): the exact tree a keep would commit. */
  tree: string
  measure: string | null
  checks: string | null
  /** frozenInputs(): the helper files under .auto/ (hash, and per file to name what changed). */
  inputs: string
  inputFiles: Record<string, string>
}

/**
 * Persisted under `run/<sessionID>` by autoresearch_run and consumed by autoresearch_log,
 * so each logged result is tied to one actual measurement of one known tree.
 */
export interface PendingRun {
  segment: number
  samples: number[]
  /** Median of the samples; null if the run failed or printed no value. */
  metric: number | null
  /** Secondary metrics (medians). */
  metrics: Record<string, number>
  exitCode: number | null
  timedOut: boolean
  checks: "none" | "skipped" | "passed" | "failed"
  timeoutSeconds: number
  checksTimeoutSeconds: number
  fingerprint: Fingerprint
  /** Files in the scope or under .auto/ that the benchmark itself changed; such a run can't be kept. */
  benchmarkWrites: string[]
  /**
   * The paired confirmation, stored as soon as it exists. If the commit or revert after it
   * fails and the agent calls log again, the same samples are judged again; otherwise a
   * failed git command would be a free second roll of the dice.
   */
  confirmation?: Confirmation
}

/** What a paired confirmation measured. */
export interface Confirmation {
  /** The candidate's samples. */
  samples: number[]
  /** HEAD's samples, measured right before and right after the candidate's. */
  currentSamples: number[]
  /** The candidate's secondary metrics (medians). */
  metrics: Record<string, number>
  /** Set when the candidate failed the benchmark during the confirmation. */
  failure?: string
}

/**
 * Persisted under swapKey(cwd) while a paired confirmation has the scope's files swapped
 * to HEAD. If the process dies in that window, the working tree looks clean and the
 * experiment's files exist only as git objects; this marker is how they come back.
 */
export interface SwapMarker {
  directory: string
  sessionID: string
  /** The candidate: the fingerprint tree of the measured run. */
  tree: string
  /** HEAD and branch during the swap. Recovery only touches files while both still hold. */
  head: string
  branch: string
  at: string
}
type StoredRun = PendingRun | { running: true }

/** What the tools need from OpenCode (and what the tests fake). */
export interface Host {
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    remove(key: string): Promise<void>
  }
  /** The session's working directory. */
  cwdOf(sessionID: string): Promise<string>
  loopState(sessionID: string): Promise<ActiveState | undefined>
  saveLoopState(sessionID: string, state: ActiveState): Promise<void>
  /** Turn the loop off and tell the user why. */
  stopLoop(sessionID: string, reason: string): Promise<void>
  /**
   * Ask OpenCode's permission system. `offerSave: false` for destructive commands: the
   * user may allow them, but isn't offered "always allow".
   */
  assertShell(context: ToolCtx, commands: string[], offerSave: boolean): Promise<void>
  /** Dashboard "running" indicator. */
  setStatus(cwd: string, status: { running: boolean; command?: string; startedAt?: number }): void
}

export const runKey = (sessionID: string) => `run/${sessionID}`
/** Per folder, not per session: whichever session touches the project next must find it. */
export const swapKey = (cwd: string) => `swap/${createHash("sha256").update(cwd).digest("hex").slice(0, 24)}`

type ToolResult = { content: string }
const error = (text: string): ToolResult => ({ content: `ERROR: ${text}` })

/**
 * Process-wide state, kept on globalThis so it survives a plugin reload (a reloaded copy
 * of this module would otherwise start with empty maps while the old copy is still
 * measuring):
 * - locks: one run or log at a time per project; they share the working tree, git's index
 *   and the run numbers.
 * - swapping: folders where a paired confirmation is under way in THIS process. A swap
 *   marker for such a folder is live, not left over from a crash, and must not be "recovered".
 */
const shared: { locks: Map<string, Promise<unknown>>; swapping: Set<string> } = ((globalThis as Record<symbol, unknown>)[
  Symbol.for("opencode-autoresearch.shared")
] ??= { locks: new Map(), swapping: new Set() }) as never
function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const next = (shared.locks.get(key) ?? Promise.resolve()).then(task, task)
  shared.locks.set(
    key,
    next.catch(() => {}),
  )
  return next
}

/** Reject arguments the tool doesn't have, by name. They used to be dropped silently, so
 * an agent passing `command` or `metric` believed it had chosen the benchmark or the result. */
function unknownArguments(input: unknown, allowed: string[], tool: string, hint: string): ToolResult | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null
  const unknown = Object.keys(input).filter((k) => !allowed.includes(k))
  if (!unknown.length) return null
  return error(
    `Unknown argument${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => `\`${k}\``).join(", ")}. ` +
      `${tool} takes only: ${allowed.join(", ")}. ${hint} Nothing was done; call it again without ${unknown.length > 1 ? "them" : "it"}.`,
  )
}

// ── Formatting ────────────────────────────────────────────

/** Numbers as measured: exact for integers and short decimals; long ones cut to 8 significant digits. */
export const fmt = (n: number | null | undefined) =>
  n === null || n === undefined
    ? "–"
    : Number.isInteger(n) || String(n).length <= 12
      ? String(n)
      : String(Number(n.toPrecision(8)))

const withUnit = (n: number | null, unit: string) => `${fmt(n)}${unit ? ` ${unit}` : ""}`

/**
 * Where a segment stands, in the one wording used by tool output and `/autoresearch
 * status`: kept experiments (never the baseline), their compounded gain, and the absolute
 * values labelled as what they are (measured at different times, so not comparable).
 */
export function progressText(summary: SegmentSummary): string {
  const { kept, gain, skipped, baseline, current, config } = summary
  return (
    `${kept} kept` +
    (kept > skipped ? `, ${gainText(gain)} overall (the kept experiments' back-to-back gains, compounded)` : "") +
    (baseline === null
      ? ""
      : ` · measured at the time: baseline ${withUnit(baseline, config.metric_unit)}, current ${withUnit(current, config.metric_unit)}`)
  )
}

// ── Shared checks ─────────────────────────────────────────

/** The run and stop limits, checked after every log and at every turn end. Null = keep going. */
export function limitReached(entries: LogEntry[], state: ActiveState, settings: Settings): string | null {
  const total = countRuns(entries)
  if (total >= settings.maxIterations) {
    return (
      `maxIterations reached (${total} of ${settings.maxIterations} runs logged). Raise it in .auto/config.json to go on, ` +
      "or run `/autoresearch finalize` to turn the kept experiments into reviewable branches."
    )
  }
  const streak = noImprovementStreak(entries, state.startRunCount)
  if (streak >= settings.maxNoImprovement) {
    return (
      `${streak} runs in a row without a keep since the loop was last started (maxNoImprovement = ${settings.maxNoImprovement}). ` +
      "`/autoresearch` resumes with a fresh allowance; `/autoresearch finalize` wraps up what was kept."
    )
  }
  return null
}

type Gate = { ok: true; cwd: string; state: ActiveState } | { ok: false; result: ToolResult }

/**
 * Every experiment tool starts here. The tools commit and revert, so they only work while
 * the user has the loop on for this session, and only on the branch (and, for run and
 * log, the commit) the loop expects.
 */
async function gate(host: Host, sessionID: string, check: "branch" | "branch+head"): Promise<Gate> {
  const [state, cwd] = await Promise.all([host.loopState(sessionID), host.cwdOf(sessionID)])
  if (!state || state.directory !== cwd) {
    return {
      ok: false,
      result: error(
        "The autoresearch loop is off for this session, so the experiment tools are disabled (they commit and revert files). " +
          "The user turns it on with `/autoresearch <goal>`. Don't run experiments until then.",
      ),
    }
  }
  if (!state.branch) {
    // Setup mode before the first init: nothing ties the loop to a branch yet. Init may
    // run (it records the branch); measuring and logging may not, or an old log would let
    // them commit and revert on whatever branch happens to be checked out.
    if (check === "branch") return { ok: true, cwd, state }
    return { ok: false, result: error("Setup isn't finished: call autoresearch_init first (it ties the loop to the experiment branch).") }
  }
  const branch = await currentBranch(cwd)
  const head = await headSha(cwd)
  let problem = ""
  if (branch !== state.branch) {
    problem = `the checked-out branch is ${branch ? `\`${branch}\`` : "a detached HEAD"}, but the loop runs on \`${state.branch}\``
  } else if (check === "branch+head" && state.head && head !== state.head) {
    problem = `HEAD is ${head?.slice(0, 7) ?? "missing"}, but the loop's last known commit is ${state.head.slice(0, 7)} (something was committed or reset outside the loop)`
  }
  if (!problem) return { ok: true, cwd, state }
  await host.stopLoop(
    sessionID,
    `Loop paused: ${problem}. Nothing was reverted or committed. Check out the experiment branch as you want it, then \`/autoresearch\` resumes from there.`,
  )
  return {
    ok: false,
    result: error(
      `${problem}. The loop is paused and the user has been told. Don't switch branches, commit, reset or revert anything yourself; end your turn.`,
    ),
  }
}

async function fingerprintNow(cwd: string): Promise<{ ok: true; fp: Fingerprint } | { ok: false; error: string }> {
  const [head, branch, tree, measure, checks, inputs] = await Promise.all([
    headSha(cwd),
    currentBranch(cwd),
    scopeTreeHash(cwd),
    fileHash(measurePath(cwd)),
    fileHash(checksPath(cwd)),
    frozenInputs(autoDir(cwd)),
  ])
  if (!tree.ok) return { ok: false, error: tree.error }
  if (!head || !branch) return { ok: false, error: "no commit or no branch checked out" }
  return { ok: true, fp: { head, branch, tree: tree.tree, measure, checks, inputs: inputs.hash, inputFiles: inputs.files } }
}

/** The files a segment freezes besides the two scripts, for messages. */
const FROZEN_NOTE = "every file under .auto/ except log.jsonl, ideas.md, config.json and prompt.md"

/** Why a segment's frozen benchmark no longer matches the files, or "" if it does. */
export function benchmarkDrift(config: ConfigEntry, fp: Pick<Fingerprint, "measure" | "checks" | "inputs" | "inputFiles">): string {
  const { measure, checks } = fp
  if (measure === null) return ".auto/measure.sh is missing"
  if (measure !== config.measure_hash) return ".auto/measure.sh changed since this segment started"
  if (checks !== (config.checks_hash ?? null)) {
    return checks === null
      ? ".auto/checks.sh was removed since this segment started"
      : config.checks_hash
        ? ".auto/checks.sh changed since this segment started"
        : ".auto/checks.sh was added since this segment started"
  }
  // Segments started before v0.2.1 have no inputs hash; they keep working unchecked.
  if (config.inputs_hash !== undefined && fp.inputs !== config.inputs_hash) {
    const names = Object.keys(fp.inputFiles).sort()
    return (
      `a helper file under .auto/ was added, edited or removed since this segment started (frozen: ${FROZEN_NOTE}). ` +
      (names.length
        ? `Helper files there now: ${names.slice(0, 15).join(", ")}${names.length > 15 ? ", …" : ""}`
        : "There are none now, so one was removed")
    )
  }
  return ""
}

interface Measurement {
  samples: number[]
  /** Secondary metrics, medians across the runs that printed them. */
  metrics: Record<string, number>
  last: ShellResult
  /** Set when the measurement isn't usable: what went wrong. */
  failure?: string
  wallMs: number
}

/**
 * Run the benchmark `count` times, stopping at the first failure. Only the last run's
 * output is kept (capped in shell.ts); earlier ones are parsed and dropped.
 */
async function measure(
  host: Host,
  cwd: string,
  config: ConfigEntry,
  count: number,
  timeoutSeconds: number,
  context: ToolCtx,
  label: string,
): Promise<Measurement> {
  const samples: number[] = []
  const perName = new Map<string, number[]>()
  let last: ShellResult = { code: null, output: "", durationMs: 0, timedOut: false }
  let failure: string | undefined
  let wallMs = 0
  const startedAt = Date.now()
  for (let i = 1; i <= count; i++) {
    const step = count > 1 ? `${label} (${i}/${count})` : label
    await context.progress?.({ status: step }).catch(() => {})
    host.setStatus(cwd, { running: true, command: step, startedAt })
    last = await bash(MEASURE_COMMAND, cwd, timeoutSeconds * 1000, context.signal)
    wallMs += last.durationMs
    const parsed = parseMetrics(last.output)
    if (last.timedOut) failure = `the benchmark timed out after ${timeoutSeconds} s`
    else if (last.code !== 0) failure = `the benchmark exited with code ${last.code}`
    else if (parsed[config.metric_name] === undefined) failure = `the benchmark printed no \`METRIC ${config.metric_name}=<number>\` line`
    if (failure) break
    samples.push(parsed[config.metric_name])
    for (const [k, v] of Object.entries(parsed)) if (k !== config.metric_name) perName.set(k, [...(perName.get(k) ?? []), v])
  }
  const metrics = Object.fromEntries([...perName].map(([k, vs]) => [k, median(vs)]))
  return { samples, metrics, last, failure, wallMs }
}

const seconds = (value: unknown, fallback: number) => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// ── Interrupted swaps ─────────────────────────────────────

type Recovery = { note?: string; failed?: string }

/**
 * Put back the experiment's files if a paired confirmation was cut off while the scope
 * was swapped to HEAD (process killed, machine restarted, a restore that failed). Must be
 * called with the folder's lock held and no swap under way in this process.
 *
 * It only ever moves files that are exactly HEAD's version to the candidate's version:
 * - HEAD or the branch changed since: nothing is touched. The candidate was measured
 *   against another commit; the marker is dropped and the tree id is reported.
 * - A file differs from both HEAD's and the candidate's version: someone edited it after
 *   the crash (the tree looked clean). Nothing is touched and the marker stays, so the
 *   next call tries again once the edit is out of the way.
 * A half-finished swap passes both tests (each file is at one version or the other).
 */
async function recoverLocked(host: Host, cwd: string): Promise<Recovery | null> {
  const marker = (await host.storage.get(swapKey(cwd))) as SwapMarker | undefined
  if (!marker) return null
  const manual =
    `The experiment's files are saved in git as tree ${marker.tree}; ` +
    `\`git restore --source=${marker.tree} --worktree -- .\` (run in ${cwd}) brings them back.`
  const [head, branch, tree] = await Promise.all([headSha(cwd), currentBranch(cwd), headTree(cwd)])
  if (head !== marker.head || branch !== marker.branch || !tree) {
    await host.storage.remove(swapKey(cwd))
    await host.storage.remove(runKey(marker.sessionID))
    return {
      note:
        `A keep was being confirmed when the plugin was cut off (${marker.at}), with the project's files set to the last commit. ` +
        `The branch or commit has changed since, so the unfinished experiment was not restored. ${manual}`,
    }
  }
  const res = await swapScope(cwd, marker.tree, { oneOf: [tree] })
  if (!res.ok) {
    return {
      failed:
        `A keep was being confirmed when the plugin was cut off (${marker.at}), with the project's files set to the last commit. ` +
        `The experiment's files could not be put back: ${res.error}. Nothing was changed. ` +
        "To get the experiment back, revert or stash those changes and run `/autoresearch` again. To drop it, commit them. " +
        manual,
    }
  }
  await host.storage.remove(swapKey(cwd))
  return res.from === marker.tree
    ? {} // the files were already the candidate's: only the marker was left over
    : {
        note:
          "A keep was being confirmed when the plugin was cut off, with the project's files set to the last commit. " +
          "The experiment's files have been put back exactly as measured.",
      }
}

/**
 * The same for callers outside the tools (the /autoresearch command, plugin start).
 * Returns null when there was nothing to do, also while a confirmation is running right now.
 */
export async function recoverInterruptedSwap(host: Host, cwd: string): Promise<Recovery | null> {
  if (shared.swapping.has(cwd)) return null
  if (!(await host.storage.get(swapKey(cwd)))) return null
  return withLock(cwd, async () => (shared.swapping.has(cwd) ? null : recoverLocked(host, cwd)))
}

/**
 * First step of every tool call (inside the lock, before anything looks at the working
 * tree): restore an interrupted swap. If that isn't possible, the tool must not go on (it
 * would measure, revert or commit the wrong files), so the loop pauses.
 */
async function recoverFirst(host: Host, sessionID: string, cwd: string): Promise<{ stop?: ToolResult; note: string }> {
  const recovery = await recoverLocked(host, cwd)
  if (recovery?.failed) {
    if (await host.loopState(sessionID)) await host.stopLoop(sessionID, `Loop paused: ${recovery.failed}`)
    return {
      note: "",
      stop: error(`${recovery.failed}\nThe loop is paused and the user has been told. Don't change or revert files yourself; end your turn.`),
    }
  }
  return { note: recovery?.note ? `NOTE: ${recovery.note}\n\n` : "" }
}

const withNote = (note: string, result: ToolResult): ToolResult => (note ? { content: note + result.content } : result)

// ── autoresearch_init ─────────────────────────────────────

export async function initExperiment(host: Host, input: unknown, context: ToolCtx): Promise<ToolResult> {
  const { sessionID } = context
  const cwd = await host.cwdOf(sessionID)
  return withLock(cwd, async () => {
    const first = await recoverFirst(host, sessionID, cwd)
    if (first.stop) return first.stop
    return withNote(first.note, await initLocked(host, input, context, cwd))
  })
}

async function initLocked(host: Host, input: unknown, context: ToolCtx, cwd: string): Promise<ToolResult> {
  const { sessionID } = context
  {
    // HEAD isn't checked here: setup creates the branch and commits the session files
    // before the first init, and init is where the loop learns what HEAD is.
    const gated = await gate(host, sessionID, "branch")
    if (!gated.ok) return gated.result
    const { state } = gated
    if (state.stopping) return error("The user turned the loop off. Don't start a new segment; end your turn.")

    const bad = unknownArguments(
      input,
      ["name", "metric_name", "metric_unit", "direction", "repeat"],
      "autoresearch_init",
      "The benchmark is always ./.auto/measure.sh.",
    )
    if (bad) return bad
    const { name, metric_name, metric_unit = "", direction, repeat: rawRepeat = DEFAULT_REPEAT } = (input ?? {}) as {
      name?: string
      metric_name?: string
      metric_unit?: string
      direction?: Direction
      repeat?: number
    }
    if (!name?.trim() || !metric_name?.trim()) return error("`name` and `metric_name` are required.")
    if (direction !== "lower" && direction !== "higher") return error('`direction` must be "lower" or "higher".')
    if (!/^[\w.\-]+$/.test(metric_name)) {
      return error("`metric_name` may only contain letters, digits, `_`, `.` and `-` (it must match the METRIC line).")
    }
    if (!Number.isInteger(rawRepeat) || rawRepeat < 1 || rawRepeat > MAX_REPEAT) {
      return error(`\`repeat\` must be a whole number from 1 to ${MAX_REPEAT} (default ${DEFAULT_REPEAT}).`)
    }

    // Preflight: everything that makes commit/revert safe and the baseline honest.
    const head = await headSha(cwd)
    if (!head) return error("This folder isn't in a git repository with at least one commit. Create the repo and commit the project first.")
    const branch = await currentBranch(cwd)
    if (!branch) return error("HEAD is detached. Create a branch for the experiments first: `git switch -c autoresearch/<goal>-<date>`.")
    if (await isTrunk(cwd, branch)) {
      return error(
        `You're on \`${branch}\`, the project's main branch. Experiments commit and revert freely, so they need their own branch: ` +
          "`git switch -c autoresearch/<goal>-<date>`, then call autoresearch_init again.",
      )
    }
    if (!(await scopeHasTrackedFiles(cwd))) {
      return error(
        "git tracks no files in this folder (outside .auto/). Reverting an experiment would delete the whole project. " +
          "Ask the user to commit the project first; don't commit it yourself unless they asked for that.",
      )
    }
    const status = await scopeStatus(cwd)
    if (!status.ok) return error(`git status failed:\n${tailLines(status.error, 20)}`)
    if (status.status) {
      return error(
        "The working tree has uncommitted changes (outside .auto/). A segment starts from committed code, because every " +
          "discard reverts to the last commit:\n" +
          tailLines(status.status, 20) +
          "\nIf these are leftovers of your own experiment, revert them. If they might be the user's work, call autoresearch_pause and ask.",
      )
    }
    if (!existsSync(measurePath(cwd))) return error("`.auto/measure.sh` doesn't exist. Write it first (see the autoresearch-create skill).")
    try {
      accessSync(measurePath(cwd), constants.X_OK)
    } catch {
      return error("`.auto/measure.sh` isn't executable. Run `chmod +x .auto/measure.sh`.")
    }
    // Every segment's benchmark must be in git: an uncommitted edit leaves no trace of what
    // was measured once it's edited again, and the user couldn't review it.
    const scripts = await benchmarkScriptStatus(cwd)
    if (!scripts.ok) return error(`git status failed:\n${tailLines(scripts.error, 20)}`)
    if (scripts.status) {
      return error(
        "The benchmark has uncommitted changes, or isn't in git yet:\n" +
          tailLines(scripts.status, 10) +
          "\nCommit it first, so every segment's benchmark can be reviewed later: " +
          "`git add .auto/measure.sh .auto/checks.sh && git commit -m \"autoresearch: benchmark\"` (leave out checks.sh if there is none; " +
          "lines starting with `!!` mean .auto/ is gitignored: use `git add -f`). This is the one kind of commit you make yourself. " +
          "Then call autoresearch_init again.",
      )
    }

    const entries = await readLog(cwd)
    const segment = (currentSegment(entries).config?.segment ?? 0) + 1
    const checksHash = await fileHash(checksPath(cwd))
    const inputs = await frozenInputs(autoDir(cwd))
    await appendLog(cwd, {
      type: "config",
      segment,
      name: name.trim(),
      metric_name,
      metric_unit,
      direction,
      repeat: rawRepeat,
      measure_hash: (await fileHash(measurePath(cwd)))!,
      checks_hash: checksHash,
      inputs_hash: inputs.hash,
      timestamp: new Date().toISOString(),
    })
    // A measurement from before this init must never become the new segment's baseline.
    await host.storage.remove(runKey(sessionID))
    await host.saveLoopState(sessionID, {
      ...state,
      branch,
      head,
      setup: state.setup && !existsSync(promptPath(cwd)) ? true : undefined,
    })

    const settings = await readSettings(cwd)
    const total = countRuns(entries)
    const helpers = Object.keys(inputs.files).sort()
    return {
      content: [
        `Initialized "${name.trim()}" (segment ${segment}) on branch ${branch}: ${metric_name}${metric_unit ? ` in ${metric_unit}` : ""}, ${direction} is better.`,
        `Each measurement runs ${MEASURE_COMMAND} ${rawRepeat}×` +
          (rawRepeat < 3
            ? ` (fewer than 3: no noise estimate, so a keep needs at least ${settings.minImprovement * 100}% over the last commit).`
            : " and uses the median.") +
          ` Checks: ${checksHash ? "./.auto/checks.sh" : "none (no .auto/checks.sh)"}.`,
        `A proposed keep is confirmed by measuring the last commit and your change back to back: about ${confirmationRuns(rawRepeat)} more benchmark runs.`,
        `The benchmark is now frozen for this segment: measure.sh, checks.sh and ${FROZEN_NOTE}` +
          (helpers.length ? ` (now: ${helpers.slice(0, 15).join(", ")}${helpers.length > 15 ? ", …" : ""})` : "") +
          ". If any of them changes, autoresearch_run refuses until you call autoresearch_init again.",
        `Runs used: ${total}/${settings.maxIterations} (all segments).`,
        ...settings.warnings.map((w) => `Settings warning: ${w}`),
        "Next: autoresearch_run for the baseline (unchanged code), then autoresearch_log with status \"keep\".",
      ].join("\n"),
    }
  }
}

// ── autoresearch_run ──────────────────────────────────────

/** Advice for a benchmark that writes where it mustn't. */
const WRITE_ELSEWHERE =
  "Make measure.sh (and checks.sh) write their output to a gitignored path or outside the project (e.g. \"$TMPDIR\"); " +
  "not under .auto/, whose files are frozen as benchmark inputs. Changing measure.sh needs a commit and a new autoresearch_init."

export async function runExperiment(host: Host, input: unknown, context: ToolCtx): Promise<ToolResult> {
  const { sessionID } = context
  const cwd = await host.cwdOf(sessionID)
  return withLock(cwd, async () => {
    const first = await recoverFirst(host, sessionID, cwd)
    if (first.stop) return first.stop
    return withNote(first.note, await runLocked(host, input, context, cwd))
  })
}

async function runLocked(host: Host, input: unknown, context: ToolCtx, cwd: string): Promise<ToolResult> {
  const { sessionID } = context
  {
    const gated = await gate(host, sessionID, "branch+head")
    if (!gated.ok) return gated.result
    const { state } = gated
    if (state.stopping) return error("The user turned the loop off. Don't start another experiment; end your turn.")

    const bad = unknownArguments(
      input,
      ["timeout_seconds", "checks_timeout_seconds"],
      "autoresearch_run",
      "The benchmark is always ./.auto/measure.sh, repeated as often as autoresearch_init fixed for the segment.",
    )
    if (bad) return bad

    const entries = await readLog(cwd)
    const { config, runs } = currentSegment(entries)
    if (!config) return error("No session yet. Call autoresearch_init first.")
    const settings = await readSettings(cwd)
    const limit = limitReached(entries, state, settings)
    if (limit) return { content: `STOP: ${limit}\nDon't run more experiments. Summarize the results for the user and end your turn.` }

    const { timeout_seconds, checks_timeout_seconds } = (input ?? {}) as { timeout_seconds?: number; checks_timeout_seconds?: number }
    const timeoutSeconds = seconds(timeout_seconds, 600)
    const checksTimeoutSeconds = seconds(checks_timeout_seconds, 300)

    const before = await fingerprintNow(cwd)
    if (!before.ok) return error(`Couldn't read the repository state: ${before.error}`)
    const drift = benchmarkDrift(config, before.fp)
    if (drift) {
      return error(
        `The benchmark changed: ${drift}. Results wouldn't be comparable with this segment's earlier runs. ` +
          "If the change is intended and honest (see \"What counts as cheating\" in the skill), revert your code changes, commit the " +
          "benchmark edit and call autoresearch_init to start a new segment with a fresh baseline. Otherwise restore the file.",
      )
    }

    const current = currentRun(runs)
    const isBaseline = !current
    if (isBaseline && before.fp.tree !== (await headTree(cwd))) {
      const status = await scopeStatus(cwd)
      return error(
        "The baseline must be measured on unchanged code, but the working tree has changes:\n" +
          tailLines(status.ok ? status.status : status.error, 20) +
          "\nRevert them, measure and log the baseline (status keep), then start experimenting.",
      )
    }

    const hasChecks = before.fp.checks !== null
    // Rejections propagate (the docs: rethrow, don't return them as tool output).
    await host.assertShell(context, hasChecks ? [MEASURE_COMMAND, CHECKS_COMMAND] : [MEASURE_COMMAND], true)

    // Mark the run as in progress, so `/autoresearch off` during it can say so, and so an
    // interrupted run can't be logged.
    await host.storage.set(runKey(sessionID), { running: true })
    let result: Measurement
    let checks: ShellResult | null = null
    try {
      if (isBaseline) {
        // One uncounted run first: the very first run is often slower (cold caches, a
        // first build), and a slow baseline makes every later experiment look good.
        await context.progress?.({ status: "warm-up run" }).catch(() => {})
        host.setStatus(cwd, { running: true, command: "warm-up", startedAt: Date.now() })
        await bash(MEASURE_COMMAND, cwd, timeoutSeconds * 1000, context.signal)
      }
      result = await measure(host, cwd, config, config.repeat, timeoutSeconds, context, "measuring")
      if (!result.failure && hasChecks) {
        await context.progress?.({ status: "running checks" }).catch(() => {})
        host.setStatus(cwd, { running: true, command: "checks.sh", startedAt: Date.now() })
        // Relative path: an absolute one breaks when the project path contains spaces.
        checks = await bash(CHECKS_COMMAND, cwd, checksTimeoutSeconds * 1000, context.signal)
      }
    } finally {
      host.setStatus(cwd, { running: false })
    }
    if (context.signal?.aborted) return error("The run was interrupted before it finished. Nothing was recorded.")

    // The benchmark must not change the code it measures: otherwise the tree that gets
    // committed isn't the tree that was measured, and every later "is there a diff?" lies.
    // The same goes for its frozen inputs under .auto/: a benchmark that writes there would
    // make the next run fail with "the benchmark changed", which says nothing useful.
    const after = await scopeTreeHash(cwd)
    if (!after.ok) return error(`Couldn't read the repository state after the run: ${after.error}`)
    const benchmarkWrites = after.tree === before.fp.tree ? [] : await changedBetween(cwd, before.fp.tree, after.tree)
    if (after.tree !== before.fp.tree && !benchmarkWrites.length) benchmarkWrites.push("(unknown files)")
    const inputsAfter = await frozenInputs(autoDir(cwd))
    const wroteInputs = changedInputs(before.fp.inputFiles, inputsAfter.files).map((f) => `.auto/${f}`)
    benchmarkWrites.push(...wroteInputs)

    const complete = !result.failure
    const metric = complete ? median(result.samples) : null
    const checksFailed = checks !== null && (checks.code !== 0 || checks.timedOut)
    const pending: PendingRun = {
      segment: config.segment,
      samples: result.samples,
      metric,
      metrics: result.metrics,
      exitCode: result.last.code,
      timedOut: result.last.timedOut,
      checks: !hasChecks ? "none" : checks === null ? "skipped" : checksFailed ? "failed" : "passed",
      timeoutSeconds,
      checksTimeoutSeconds,
      fingerprint: { ...before.fp, tree: after.tree, inputs: inputsAfter.hash, inputFiles: inputsAfter.files },
      benchmarkWrites,
    }
    await host.storage.set(runKey(sessionID), pending)

    const unit = config.metric_unit
    const lines = [
      `${config.metric_name}: ` +
        (metric === null
          ? `– (${result.failure})`
          : `${withUnit(metric, unit)}${config.repeat > 1 ? ` (median of ${config.repeat})` : ""}`) +
        ` · wall ${(result.wallMs / 1000).toFixed(2)}s`,
    ]
    if (result.samples.length > 1) {
      lines.push(`samples: ${result.samples.map(fmt).join(", ")}${complete && result.samples.length >= 3 ? ` · noise (MAD) ${fmt(mad(result.samples))}` : ""}`)
    }
    const secondary = Object.entries(result.metrics)
    if (secondary.length) lines.push(`secondary: ${secondary.map(([k, v]) => `${k}=${fmt(v)}`).join(", ")}`)
    if (hasChecks) {
      lines.push(
        `checks: ${checks === null ? "not run (the benchmark failed)" : checks.timedOut ? `TIMED OUT after ${checksTimeoutSeconds} s` : checksFailed ? "FAILED" : "passed"}`,
      )
    }
    for (const w of settings.warnings) lines.push(`settings warning: ${w}`)

    // What this means and what autoresearch_log will do with it.
    let verdict: string
    if (!complete) {
      verdict = "The benchmark failed. Log it as `crash` (reverts your changes), or fix a trivial mistake and run again."
    } else if (checksFailed) {
      verdict = "Checks failed, so this can't be kept. Log it as `checks_failed` (reverts your changes), or fix it and run again."
    } else if (benchmarkWrites.length) {
      verdict =
        `The benchmark itself changed files: ${benchmarkWrites.slice(0, 10).join(", ")}. A keep is refused in that state` +
        (wroteInputs.length
          ? `, and the next run will be refused too, because ${FROZEN_NOTE} is frozen as benchmark input. `
          : ", because the committed code would differ from the measured code. ") +
        WRITE_ELSEWHERE +
        (wroteInputs.length ? "" : " Or add those files to .gitignore.")
    } else if (isBaseline) {
      verdict = "This is the baseline (one warm-up run was done first and not counted). Log it with status `keep`."
    } else {
      const cur = median(sampleList(current))
      const better = isBetter(metric!, cur, config.direction)
      const paired = confirmationRuns(config.repeat)
      verdict =
        `First measurement: ${withUnit(metric, unit)}, ` +
        (metric === cur ? "equal to" : `${gainText(relativeGain(metric!, cur, config.direction))} than`) +
        ` current's logged ${withUnit(cur, unit)}. That number is from earlier and the machine's speed drifts, so this is only a first look. ` +
        (better
          ? `Log \`keep\`: the plugin then measures the last commit and your change back to back (${paired} more benchmark runs) ` +
            "and commits only if that confirms the gain; otherwise it reverts and logs a discard."
          : "Log `discard`. Only if the change removes more lines than it adds and performance is about equal: `keep` with " +
            "`simplification: true` (also measured back to back).")
    }
    lines.push("", verdict, "Don't change any file before logging: a keep is refused if the code differs from what was measured.")
    lines.push("", "── output (tail) ──", tailLines(result.last.output, OUTPUT_TAIL_LINES))
    if (checksFailed) lines.push("", "── checks output (tail) ──", tailLines(checks!.output, OUTPUT_TAIL_LINES))
    return { content: lines.join("\n") }
  }
}

// ── Paired confirmation ───────────────────────────────────

/**
 * Measure HEAD and the candidate back to back: HEAD, candidate, HEAD (halfRuns() runs of
 * HEAD on each side).
 *
 * Why: the first design compared the candidate with current's LOGGED samples. On a loaded
 * machine the same tree measured 13 % apart minutes later, which rejected sound changes
 * and let no-ops through whenever the logged reference had been unluckily slow. Only
 * numbers taken together are comparable.
 *
 * The scope's files are swapped to HEAD and back (swapScope). While they're swapped, a
 * marker in plugin storage names the candidate's tree; whatever happens (an abort, a
 * failing benchmark, an exception) the `finally` puts the candidate back, and if even
 * that fails or the process dies, the next tool call or loop start does it from the marker.
 */
async function pairedConfirmation(
  host: Host,
  cwd: string,
  config: ConfigEntry,
  pending: PendingRun,
  context: ToolCtx,
  head: string,
): Promise<{ ok: true; confirmation: Confirmation } | { ok: false; result: ToolResult; pause?: string }> {
  const candidate = pending.fingerprint.tree
  const half = halfRuns(config.repeat)
  const marker: SwapMarker = {
    directory: cwd,
    sessionID: context.sessionID,
    tree: candidate,
    head: pending.fingerprint.head,
    branch: pending.fingerprint.branch,
    at: new Date().toISOString(),
  }
  const interrupted = (): { ok: false; result: ToolResult } => ({
    ok: false,
    result: error(
      "Interrupted while the keep was being confirmed. Your change is back in the working tree as measured and nothing was logged; " +
        "call autoresearch_log again to repeat the confirmation.",
    ),
  })
  const headFailed = (m: Measurement): { ok: false; result: ToolResult } => ({
    ok: false,
    result: error(
      `The confirmation measures the last commit next to your change, and on the last commit ${m.failure}. ` +
        "Your change is back in the working tree as measured and nothing was logged. If the benchmark is flaky, call autoresearch_log " +
        "again; if it really fails without your change, log `discard` and call autoresearch_pause to tell the user.\n" +
        `── output (tail) ──\n${tailLines(m.last.output, 30)}`,
    ),
  })
  const swapFailed = (what: string, err: string): { ok: false; result: ToolResult } => ({
    ok: false,
    result: error(
      `Couldn't ${what} for the confirmation: ${err}. Your change is back in the working tree as measured and nothing was logged. ` +
        "Log `discard`, or call autoresearch_pause if you can't tell why.",
    ),
  })

  let outcome: { ok: true; confirmation: Confirmation } | { ok: false; result: ToolResult; pause?: string }
  shared.swapping.add(cwd)
  try {
    await host.storage.set(swapKey(cwd), marker)
    // 1. To HEAD. The files must still be exactly the measured candidate: the permission
    // prompts above can take a while, and whatever was edited meanwhile isn't in the
    // candidate's tree, so swapping would lose it.
    const first = await swapScope(cwd, head, { exactly: candidate })
    if (!first.ok && first.untouched) {
      await host.storage.remove(swapKey(cwd))
      return {
        ok: false,
        result: error(
          `Files changed since the measurement (${first.error}), so the result no longer describes this code. ` +
            "Nothing was logged or changed. Call autoresearch_run again, then log. (Or log `discard` to revert.)",
        ),
      }
    }
    try {
      outcome = await (async () => {
        if (!first.ok) return swapFailed("set the files to the last commit", first.error)
        const before = await measure(host, cwd, config, half, pending.timeoutSeconds, context, "confirming: last commit")
        if (context.signal?.aborted) return interrupted()
        if (before.failure) return headFailed(before)

        // 2. The candidate. swapScope checks that the files hash to the fingerprint again.
        // From exactly HEAD's files: an edit made during the measurement is refused here
        // (and by the restore below, which then leaves it in place and pauses the loop).
        let swap = await swapScope(cwd, candidate, { exactly: head })
        if (!swap.ok) return swapFailed("put your change back", swap.error)
        const mine = await measure(host, cwd, config, config.repeat, pending.timeoutSeconds, context, "confirming: your change")
        if (context.signal?.aborted) return interrupted()
        // A candidate that fails here is "not confirmed"; HEAD needn't be measured again.
        if (mine.failure) {
          return { ok: true as const, confirmation: { samples: mine.samples, currentSamples: before.samples, metrics: mine.metrics, failure: mine.failure } }
        }

        // 3. HEAD, second half.
        swap = await swapScope(cwd, head, { exactly: candidate })
        if (!swap.ok) return swapFailed("set the files to the last commit", swap.error)
        const after = await measure(host, cwd, config, half, pending.timeoutSeconds, context, "confirming: last commit again")
        if (context.signal?.aborted) return interrupted()
        if (after.failure) return headFailed(after)
        return {
          ok: true as const,
          confirmation: { samples: mine.samples, currentSamples: [...before.samples, ...after.samples], metrics: mine.metrics },
        }
      })()
    } finally {
      host.setStatus(cwd, { running: false })
      // Back to the candidate, whatever happened above. Only files that are at HEAD's or
      // the candidate's version are touched: one at neither was edited by someone
      // meanwhile, and overwriting it would lose that edit.
      const back = await swapScope(cwd, candidate, { oneOf: [head] }).catch((err) => ({ ok: false as const, error: String(err) }))
      if (back.ok) {
        await host.storage.remove(swapKey(cwd))
      } else {
        // The marker stays: the next tool call or loop start tries again.
        const reason =
          `Couldn't put the experiment's files back after measuring the last commit: ${back.error}. ` +
          `Nothing was overwritten. The experiment's files are saved in git as tree ${candidate}; revert or stash the changed files ` +
          "and `/autoresearch` puts the experiment back."
        // eslint-disable-next-line no-unsafe-finally -- deliberate: this failure outranks whatever the measurement returned or threw
        return { ok: false, pause: `Loop paused: ${reason}`, result: error(`${reason}\nThe loop is paused and the user has been told. Don't change or revert files yourself; end your turn.`) }
      }
    }
  } finally {
    shared.swapping.delete(cwd)
  }
  return outcome
}

// ── autoresearch_log ──────────────────────────────────────

const STATUSES: RunStatus[] = ["keep", "discard", "crash", "checks_failed"]

export async function logExperiment(host: Host, input: unknown, context: ToolCtx): Promise<ToolResult> {
  const { sessionID } = context
  const cwd = await host.cwdOf(sessionID)
  return withLock(cwd, async () => {
    const first = await recoverFirst(host, sessionID, cwd)
    if (first.stop) return first.stop
    return withNote(first.note, await logLocked(host, input, context, cwd))
  })
}

async function logLocked(host: Host, input: unknown, context: ToolCtx, cwd: string): Promise<ToolResult> {
  const { sessionID } = context
  {
    const gated = await gate(host, sessionID, "branch+head")
    if (!gated.ok) return gated.result
    const { state } = gated

    const bad = unknownArguments(
      input,
      ["status", "description", "asi", "simplification"],
      "autoresearch_log",
      "The plugin records the numbers it measured itself; a result can't be typed in.",
    )
    if (bad) return bad
    const { status, description, asi = {}, simplification = false } = (input ?? {}) as {
      status?: RunStatus
      description?: string
      asi?: Record<string, unknown>
      simplification?: boolean
    }
    if (!status || !STATUSES.includes(status)) return error(`\`status\` must be one of: ${STATUSES.join(", ")}.`)
    if (typeof description !== "string" || !description.trim()) return error("`description` is required: one line saying what this experiment changed.")

    const entries = await readLog(cwd)
    const { config, runs } = currentSegment(entries)
    if (!config) return error("No session yet. Call autoresearch_init first.")

    // Each logged result belongs to exactly one completed measurement of this segment.
    const stored = (await host.storage.get(runKey(sessionID))) as StoredRun | undefined
    if (!stored) return error("No unlogged run. Call autoresearch_run first; each run is logged once.")
    if ("running" in stored) return error("The last autoresearch_run didn't finish (interrupted?). Run it again before logging.")
    const pending = stored
    if (pending.segment !== config.segment) {
      await host.storage.remove(runKey(sessionID))
      return error("The last run was measured in an earlier segment. Call autoresearch_run again.")
    }

    const settings = await readSettings(cwd)
    const current = currentRun(runs)
    const unit = config.metric_unit
    const entryBase = {
      type: "run" as const,
      segment: config.segment,
      run: runs.length + 1,
      description: description.trim(),
      asi: asi && typeof asi === "object" ? asi : {},
    }

    /** Write the entry, move the loop's HEAD marker, and apply the limits. */
    const finish = async (entry: RunEntry, headline: string): Promise<ToolResult> => {
      await appendLog(cwd, entry)
      await host.storage.remove(runKey(sessionID))
      const all = [...entries, entry]
      // Re-read the loop state: `/autoresearch off` may have arrived while this call was
      // measuring, and saving the old copy would turn the loop back on.
      const fresh = await host.loopState(sessionID)
      if (fresh) await host.saveLoopState(sessionID, { ...fresh, head: (await headSha(cwd)) ?? fresh.head })
      const lines = [
        headline,
        `Segment ${config.segment} so far: ${progressText(segmentSummaries([config, ...runs, entry])[0])}`,
        // "since the loop was last started": the count restarts on every `/autoresearch`,
        // which read as a miscount next to the log's longer run of discards.
        `Runs: ${countRuns(all)}/${settings.maxIterations} · runs without a keep since the loop was last started: ` +
          `${noImprovementStreak(all, state.startRunCount)} (the loop pauses at ${settings.maxNoImprovement})`,
      ]
      const limit = limitReached(all, state, settings)
      if (!fresh) {
        lines.push("STOP: the loop was turned off meanwhile. End your turn.")
      } else if (fresh.stopping) {
        await host.stopLoop(sessionID, "Loop turned off as you asked; the experiment that was in progress has been logged.")
        lines.push("STOP: the user turned the loop off. End your turn.")
      } else if (limit) {
        await host.stopLoop(sessionID, `Loop stopped: ${limit}`)
        lines.push(`STOP: ${limit}`, "Don't run more experiments. Summarize the results for the user and end your turn.")
      }
      return { content: lines.join("\n") }
    }

    const revertCommands = [gitCommandLine(GIT_RESTORE), gitCommandLine(GIT_CLEAN)]

    // ── discard / crash / checks_failed: back to HEAD ──
    if (status !== "keep") {
      await host.assertShell(context, revertCommands, false)
      // Staged changes included; .auto/ is never touched.
      const res = await revertToHead(cwd)
      if (!res.ok) {
        return error(
          `Reverting failed, so the run was NOT logged:\n${tailLines(res.output, 20)}\n` +
            "If the cause is a leftover .git/index.lock or similar, call autoresearch_pause and tell the user; don't delete git's files yourself.",
        )
      }
      const metric = status === "crash" ? null : pending.metric
      return finish(
        {
          ...entryBase,
          status,
          metric,
          metrics: metric === null ? {} : pending.metrics,
          samples: metric === null ? [] : pending.samples,
          noise: metric !== null && pending.samples.length >= 3 ? mad(pending.samples) : null,
          commit: null,
          confidence: null,
          ...(current && typeof current.metric === "number" ? { vs: current.metric } : {}),
          timestamp: new Date().toISOString(),
        },
        `Run #${entryBase.run} logged as ${status}; changes reverted to the last commit.`,
      )
    }

    // ── keep ──
    // 1. Only a clean measurement of exactly this code can be kept.
    if (pending.timedOut || pending.exitCode !== 0) return error("The benchmark failed or timed out, so this run can't be kept. Log it as `crash`.")
    if (pending.metric === null) return error(`The run printed no METRIC ${config.metric_name}=… line, so it can't be kept. Log it as \`crash\`.`)
    if (pending.checks === "failed") return error("Checks failed on this run, so it can't be kept. Log it as `checks_failed`.")
    if (pending.benchmarkWrites.length) {
      return error(
        `The benchmark changed files while measuring (${pending.benchmarkWrites.slice(0, 10).join(", ")}), so what was measured ` +
          `can't be tied to what would be committed. ${WRITE_ELSEWHERE} Or log this run as \`discard\`.`,
      )
    }
    const now = await fingerprintNow(cwd)
    if (!now.ok) return error(`Couldn't read the repository state: ${now.error}`)
    const fp = pending.fingerprint
    const changed =
      now.fp.tree !== fp.tree
        ? "files changed"
        : now.fp.head !== fp.head || now.fp.branch !== fp.branch
          ? "the branch or commit changed"
          : now.fp.measure !== fp.measure || now.fp.checks !== fp.checks
            ? "the benchmark files changed"
            : now.fp.inputs !== fp.inputs
              ? `the benchmark files changed (under .auto/: ${changedInputs(fp.inputFiles ?? {}, now.fp.inputFiles).slice(0, 10).join(", ")})`
              : ""
    if (changed) {
      return error(
        `${changed[0].toUpperCase()}${changed.slice(1)} since the measurement, so the result no longer describes this code. ` +
          "Call autoresearch_run again, then log. (Or log `discard` to revert.)",
      )
    }
    const tree = await headTree(cwd)
    if (!tree) return error("Couldn't read the last commit's tree.")

    // 2. Baseline: the unchanged code. Nothing to commit, nothing to confirm against.
    if (!current) {
      if (fp.tree !== tree) return error("The baseline must be the unchanged code. Revert your changes and call autoresearch_run again.")
      return finish(
        {
          ...entryBase,
          status: "keep",
          metric: pending.metric,
          metrics: pending.metrics,
          samples: pending.samples,
          noise: pending.samples.length >= 3 ? mad(pending.samples) : null,
          commit: null,
          confidence: null,
          baseline: true,
          timestamp: new Date().toISOString(),
        },
        `Run #${entryBase.run} logged as the baseline: ${config.metric_name} = ${withUnit(pending.metric, unit)}. Now start experimenting.`,
      )
    }

    // 3. A keep needs a change.
    if (fp.tree === tree) {
      return error("There are no code changes to keep (the working tree equals the last commit). Log this run as `discard`.")
    }
    const loggedCurrent = median(sampleList(current))
    const neutral = simplification === true
    if (neutral) {
      // "Simplification" used to be a claim the agent made, and it was used to get a
      // performance change past the filter below. Now it's something the diff shows.
      const lines = await diffLineCounts(cwd, tree, fp.tree)
      if (!lines) return error("Couldn't read the size of the change (git diff failed). Try again, or log `discard`.")
      if (lines.removed <= lines.added) {
        return error(
          `\`simplification: true\` is only for changes that remove more lines than they add; this one adds ${lines.added} and removes ${lines.removed}. ` +
            "If it's meant to perform better, log `keep` without `simplification` (that needs a first measurement better than current). Otherwise log `discard`.",
        )
      }
    } else if (!isBetter(pending.metric, loggedCurrent, config.direction)) {
      // A cheap filter, not a judgment: a keep is proposed on a measurement that looked
      // better. Without it, proposing a keep on everything gives each no-op a full
      // confirmation, i.e. twice the chances against the noise.
      return error(
        `The measurement (${fmt(pending.metric)}) isn't better than current (${fmt(loggedCurrent)}), so there's no gain to confirm. ` +
          "Log it as `discard`. Only if the change removes more lines than it adds at about equal performance: `keep` with `simplification: true`.",
      )
    }

    // 4. Paired confirmation. Ask for every permission first: a rejection halfway would
    // leave a measured-but-undecided tree behind.
    await host.assertShell(context, [MEASURE_COMMAND, gitCommandLine(GIT_SWAP), gitCommandLine(GIT_ADD), gitCommandLine(GIT_COMMIT)], true)
    await host.assertShell(context, revertCommands, false)

    let confirmation = pending.confirmation
    if (!confirmation) {
      const paired = await pairedConfirmation(host, cwd, config, pending, context, tree)
      if (!paired.ok) {
        if (paired.pause) await host.stopLoop(sessionID, paired.pause)
        return paired.result
      }
      // The helper files must still be the measured ones (the code is checked by the swap).
      const inputsAfter = await frozenInputs(autoDir(cwd))
      if (inputsAfter.hash !== fp.inputs) {
        await host.storage.remove(runKey(sessionID))
        return error(
          `Files under .auto/ changed while the keep was being confirmed (${changedInputs(fp.inputFiles ?? {}, inputsAfter.files).slice(0, 10).join(", ")}), ` +
            "so nothing was logged. Don't edit files while autoresearch_log runs. Call autoresearch_run again, then log.",
        )
      }
      confirmation = paired.confirmation
      await host.storage.set(runKey(sessionID), { ...pending, confirmation })
    }

    const headMetric = median(confirmation.currentSamples)
    const verdict: Verdict = confirmation.failure
      ? { confirmed: false, gain: 0, relGain: 0, se: null, confidence: null, exact: false, reason: `Not confirmed: ${confirmation.failure} when your change was measured again.` }
      : judge({
          current: confirmation.currentSamples,
          candidate: confirmation.samples,
          direction: config.direction,
          minImprovement: settings.minImprovement,
          neutral,
        })
    const confirmedMetric = confirmation.failure ? null : median(confirmation.samples)
    const measured = {
      metric: confirmedMetric,
      metrics: confirmation.failure ? {} : confirmation.metrics,
      samples: confirmation.failure ? [] : confirmation.samples,
      current_samples: confirmation.currentSamples,
      noise: !confirmation.failure && confirmation.samples.length >= 3 ? mad(confirmation.samples) : null,
      first_metric: pending.metric,
      vs: headMetric,
      // Recorded for unconfirmed keeps too, so the decision can be audited from the log.
      confidence: verdict.confidence === null ? null : Number(verdict.confidence.toFixed(2)),
    }

    // 5a. Not confirmed: revert, and record it as a discard. The same tree can't be tried again.
    if (!verdict.confirmed) {
      const res = await revertToHead(cwd)
      if (!res.ok) {
        return error(
          `The keep was not confirmed, and reverting failed, so nothing was logged:\n${tailLines(res.output, 20)}\n` +
            "Call autoresearch_pause and tell the user; don't delete git's files yourself.",
        )
      }
      const note = confirmation.failure
        ? `keep not confirmed: ${confirmation.failure} during the confirmation (first measurement ${fmt(pending.metric)}, HEAD ${fmt(headMetric)})`
        : `keep not confirmed: candidate ${fmt(confirmedMetric)} vs HEAD ${fmt(headMetric)} back to back ` +
          `(${gainText(verdict.relGain)}); first measurement ${fmt(pending.metric)}`
      return finish(
        { ...entryBase, status: "discard", ...measured, commit: null, note, timestamp: new Date().toISOString() },
        `Run #${entryBase.run}: keep NOT confirmed, so the changes were reverted and the run is logged as discard.\n${verdict.reason}\n` +
          "Don't retry the same change hoping for a luckier measurement; move on to a different idea.",
      )
    }

    // 5b. Confirmed: commit exactly the measured tree.
    // The message goes to git as data (stdin), never through a shell.
    const res = await commitKeep(
      cwd,
      `autoresearch: ${entryBase.description} (${config.metric_name}=${fmt(confirmedMetric)}${neutral ? ", simplification" : ""})`,
    )
    if (!res.ok || !res.commit) {
      // Don't log a keep that isn't in git: the changes stay in place, unstaged.
      return error(
        `Couldn't commit, so the run was NOT logged:\n${tailLines(res.ok ? "nothing to commit" : res.error, 20)}\n` +
          "Call autoresearch_log again to retry (the confirmation isn't repeated), or log `discard` to revert.",
      )
    }
    const committedTree = await headTree(cwd)
    const mismatch =
      committedTree === fp.tree ? undefined : "warning: the committed tree differs from the measured tree (files changed during the commit)"
    return finish(
      {
        ...entryBase,
        status: "keep",
        ...measured,
        commit: res.commit,
        ...(neutral ? { neutral: true as const } : {}),
        ...(mismatch ? { note: mismatch } : {}),
        timestamp: new Date().toISOString(),
      },
      `Run #${entryBase.run} logged as keep @ ${res.commit}${neutral ? " (simplification)" : ""}.\n${verdict.reason}` +
        (mismatch ? `\n${mismatch}` : ""),
    )
  }
}

// ── autoresearch_pause ────────────────────────────────────

export async function pauseLoop(host: Host, input: unknown, context: ToolCtx): Promise<ToolResult> {
  const { sessionID } = context
  const bad = unknownArguments(input, ["reason"], "autoresearch_pause", "")
  if (bad) return bad
  const reason = String((input as { reason?: unknown } | undefined)?.reason ?? "").trim()
  if (!reason) return error("`reason` is required: one or two sentences for the user on why you're pausing and what you need.")
  const state = await host.loopState(sessionID)
  if (!state) return { content: "The loop is already off. End your turn." }
  // If a confirmation was cut off earlier, the files must be back before "uncommitted
  // changes?" is answered below. (Skipped while one is running right now.)
  const recovery = await recoverInterruptedSwap(host, state.directory)
  const unlogged = await host.storage.get(runKey(sessionID))
  const status = await scopeStatus(state.directory)
  const leftovers = status.ok && status.status !== ""
  await host.stopLoop(
    sessionID,
    `Loop paused by the agent: ${reason}` +
      (recovery?.failed ? `\nAlso: ${recovery.failed}` : "") +
      (leftovers
        ? `\nNote: the working tree has uncommitted changes${unlogged ? " from an experiment that wasn't logged" : ""}. \`/autoresearch\` won't resume until they're committed, stashed or reverted.`
        : "") +
      "\n`/autoresearch` resumes the loop.",
  )
  return {
    content:
      "Loop paused; the user has been told why. End your turn now with a short summary: what was achieved, why you paused, and what you need from the user." +
      (leftovers ? " Mention that uncommitted changes are still in the working tree." : ""),
  }
}
