// The experiment tools: autoresearch_init, _run, _log and _pause.
//
// Rule of thumb for everything here: the plugin decides, the agent proposes. The agent
// can't choose what is measured (always ./.auto/measure.sh, frozen per segment by hash,
// together with every helper file under .auto/), can't type in a result (the plugin
// records what it measured), and can't decide a keep (the plugin measures the last commit
// and the candidate in back-to-back pairs and applies an exact test, see stats.ts). What it
// can do: change code, ask for a first look, and propose a keep.
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
  countRuns,
  currentRun,
  currentSegment,
  gainText,
  levelText,
  measurePath,
  median,
  medianPairGain,
  noImprovementStreak,
  pairGain,
  parseMetrics,
  promptPath,
  pText,
  readLog,
  readSettings,
  segmentSummaries,
  type SegmentSummary,
  type ConfigEntry,
  type Direction,
  type LogEntry,
  type Pair,
  type RunEntry,
  type RunStatus,
  type Settings,
} from "./state.ts"
import { ALPHA_STAGE, CONFIRM_PAIRS, decide, headFirst, isSlow, LOOK_PAIRS, lookPairs, stagePairs, swapOrderEffect } from "./stats.ts"

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
  /** The candidate's values: from the first look's pairs, or the baseline's samples. */
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
  /** The first look's pairs. Absent for a baseline measurement (nothing to pair it with). */
  look?: Pair[]
  /**
   * The LAST COMMIT failed the benchmark during the first look. There is nothing to compare
   * the change with, so it can't be kept; it can still be logged as discard (which reverts it).
   */
  headFailure?: string
  /**
   * A keep decision under way or finished. Stored pair by pair, so whatever interrupts it
   * (an abort, a failing HEAD run, a commit or revert that fails after it) the next
   * autoresearch_log goes on from these pairs. Measuring afresh instead would be a second
   * roll of the dice.
   */
  decision?: DecisionProgress
}

/** The decision pairs of a proposed keep, as far as they've been measured. */
export interface DecisionProgress {
  /** How the keep was proposed. A proposal can't change kind halfway (the rule differs). */
  neutral: boolean
  pairs: Pair[]
  /** The candidate's secondary metrics, one value per candidate run. */
  metrics: Record<string, number[]>
  /** Set when the candidate failed the benchmark while being measured: not confirmed. */
  failure?: string
}

/**
 * Persisted under swapKey(cwd) while a first look or a keep decision is measuring pairs:
 * between the two runs of a pair the scope's files are swapped to HEAD or back. If the
 * process dies while they are at HEAD, the working tree looks clean and the experiment's
 * files exist only as git objects; this marker is how they come back.
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
/**
 * `running`: autoresearch_run is measuring, or was cut off. It has no result and can't be
 * logged; its fingerprint says which files were being measured (so `/autoresearch` can
 * tell the experiment's own changes from someone else's after a crash).
 */
export type StoredRun = PendingRun | { running: true; fingerprint?: Fingerprint }

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
 * - swapping: folders where pairs are being measured in THIS process. A swap
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
 * Progress in the one sentence the agent is told to use, or "" while nothing is confirmed.
 * The level is in the metric's own direction ("19.0% lower than the baseline" for two 10 %
 * reductions; see compoundedLevel). "The compounded result of the confirmed keeps": each
 * keep was measured back to back with HEAD; a ratio of the absolute baseline and current
 * values (measured hours apart) says something else and is wrong.
 */
export function progressSentence(summary: SegmentSummary): string {
  if (!summary.gains) return ""
  return (
    `${levelText(summary.level, summary.config.direction)}, the compounded result of ${summary.gains} confirmed ` +
    `keep${summary.gains === 1 ? "" : "s"} (not a ratio of raw numbers)`
  )
}

/**
 * Where a segment stands, in the one wording used by tool output and `/autoresearch
 * status`: kept experiments (never the baseline), their compounded level (simplifications
 * count as no change), and the absolute values labelled as what they are.
 */
export function progressText(summary: SegmentSummary): string {
  const { kept, simplifications, baseline, current, config } = summary
  const sentence = progressSentence(summary)
  return (
    `${kept} kept` +
    (simplifications
      ? ` (${simplifications === kept ? (kept === 1 ? "a simplification" : "all simplifications") : `${simplifications} of them simplification${simplifications === 1 ? "" : "s"}`}, kept for less code, not for a gain)`
      : "") +
    (sentence ? `: ${sentence}` : kept ? ": no confirmed gain" : "") +
    (baseline === null
      ? ""
      : ` · absolute values, each measured at its own time (not comparable): baseline ${withUnit(baseline, config.metric_unit)}, current ${withUnit(current, config.metric_unit)}`)
  )
}

/** What a mode costs and promises, for init and status. */
export function modeText(repeat: number, minImprovement: number): string {
  const stage = stagePairs(repeat)
  if (isSlow(repeat)) {
    return (
      `Slow mode (repeat ${repeat}): a first look is 1 pair of benchmark runs (the last commit and your change, 2 runs); ` +
      `a proposed keep is decided on ${stage} fresh pair${stage === 1 ? "" : "s"} (${2 * stage} runs) and needs every pair better and a median of at least ` +
      `${minImprovement * 100}%. NO statistical check in this mode: with so few runs a lucky draw can be kept.`
    )
  }
  return (
    `Standard mode: a first look is ${LOOK_PAIRS} back-to-back pairs of benchmark runs (the last commit and your change, ${2 * LOOK_PAIRS} runs); ` +
    `a proposed keep is decided on ${CONFIRM_PAIRS} fresh pairs (${2 * CONFIRM_PAIRS} runs), plus ${CONFIRM_PAIRS} more when those are promising but not conclusive, ` +
    `by an exact paired test (p ≤ ${ALPHA_STAGE}): a change that does nothing is kept at most 1 % of the time.`
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
 * Put back the experiment's files if a first look or a keep decision was cut off while the
 * scope was swapped to HEAD (process killed, machine restarted, a restore that failed). Must be
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
        `An experiment was being measured next to the last commit when the plugin was cut off (${marker.at}), with the project's files set to the last commit. ` +
        `The branch or commit has changed since, so the unfinished experiment was not restored. ${manual}`,
    }
  }
  const res = await swapScope(cwd, marker.tree, { oneOf: [tree] })
  if (!res.ok) {
    return {
      failed:
        `An experiment was being measured next to the last commit when the plugin was cut off (${marker.at}), with the project's files set to the last commit. ` +
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
          "An experiment was being measured next to the last commit when the plugin was cut off, with the project's files set to the last commit. " +
          "The experiment's files have been put back exactly as measured.",
      }
}

/**
 * The same for callers outside the tools (the /autoresearch command, plugin start).
 * Returns null when there was nothing to do, also while pairs are being measured right now.
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
      ...(isSlow(rawRepeat) ? { mode: "slow" as const } : {}),
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
        `The baseline is ${rawRepeat} run${rawRepeat === 1 ? "" : "s"} of ${MEASURE_COMMAND} on the unchanged code (after one warm-up). Checks: ${checksHash ? "./.auto/checks.sh" : "none (no .auto/checks.sh)"}.`,
        modeText(rawRepeat, settings.minImprovement),
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
    const headTreeNow = await headTree(cwd)
    if (!headTreeNow) return error("Couldn't read the last commit's tree.")
    if (isBaseline && before.fp.tree !== headTreeNow) {
      const status = await scopeStatus(cwd)
      return error(
        "The baseline must be measured on unchanged code, but the working tree has changes:\n" +
          tailLines(status.ok ? status.status : status.error, 20) +
          "\nRevert them, measure and log the baseline (status keep), then start experimenting.",
      )
    }
    if (!isBaseline && before.fp.tree === headTreeNow) {
      // A look compares the change with the last commit; without a change both sides are
      // the same files and the runs would only cost time.
      return error(
        "There is nothing to measure: the working tree equals the last commit. Change the code first, then call autoresearch_run. " +
          "(Out of ideas? Call autoresearch_pause.)",
      )
    }

    const hasChecks = before.fp.checks !== null
    // Rejections propagate (the docs: rethrow, don't return them as tool output).
    await host.assertShell(
      context,
      [MEASURE_COMMAND, ...(hasChecks ? [CHECKS_COMMAND] : []), ...(isBaseline ? [] : [gitCommandLine(GIT_SWAP)])],
      true,
    )

    // Mark the run as in progress, so `/autoresearch off` during it can say so, and so an
    // interrupted run can't be logged.
    await host.storage.set(runKey(sessionID), { running: true, fingerprint: before.fp } satisfies StoredRun)
    const pairCount = lookPairs(config.repeat)
    let samples: number[] = []
    let metrics: Record<string, number> = {}
    let last: ShellResult = { code: null, output: "", durationMs: 0, timedOut: false }
    let failure: string | undefined
    let wallMs = 0
    let look: PairBatch | undefined
    let checks: ShellResult | null = null
    try {
      if (isBaseline) {
        // One uncounted run first: the very first run is often slower (cold caches, a
        // first build), and a slow baseline makes the absolute numbers look odd later.
        await context.progress?.({ status: "warm-up run" }).catch(() => {})
        host.setStatus(cwd, { running: true, command: "warm-up", startedAt: Date.now() })
        await bash(MEASURE_COMMAND, cwd, timeoutSeconds * 1000, context.signal)
        const result = await measure(host, cwd, config, config.repeat, timeoutSeconds, context, "measuring the baseline")
        ;({ samples, metrics, last, failure, wallMs } = result)
      } else {
        look = await measurePairs(host, cwd, config, {
          candidate: before.fp.tree,
          head: headTreeNow,
          fingerprint: before.fp,
          from: 0,
          count: pairCount,
          total: pairCount,
          timeoutSeconds,
          context,
          what: "first look",
        })
        samples = look.pairs.map((p) => p[1])
        metrics = medians(look.metrics)
        ;({ last, wallMs } = look)
        if (look.stop?.why === "candidate") failure = look.stop.failure
      }
      if (!failure && !look?.stop && !look?.pause && !context.signal?.aborted && hasChecks) {
        await context.progress?.({ status: "running checks" }).catch(() => {})
        host.setStatus(cwd, { running: true, command: "checks.sh", startedAt: Date.now() })
        // Relative path: an absolute one breaks when the project path contains spaces.
        checks = await bash(CHECKS_COMMAND, cwd, checksTimeoutSeconds * 1000, context.signal)
      }
    } finally {
      host.setStatus(cwd, { running: false })
    }
    if (look?.pause) {
      await host.stopLoop(sessionID, look.pause)
      return error(`${look.pause.replace(/^Loop paused: /, "")}\nThe loop is paused and the user has been told. Don't change or revert files yourself; end your turn.`)
    }
    if (context.signal?.aborted || look?.stop?.why === "aborted") {
      return error(
        "The run was interrupted before it finished. Nothing was recorded" +
          (isBaseline ? "." : "; your change is in the working tree as it was. Call autoresearch_run again."),
      )
    }
    if (look?.stop?.why === "changed") {
      return error(`Files changed while the first look was starting (${look.stop.error}). Nothing was measured or changed. Call autoresearch_run again.`)
    }
    if (look?.stop?.why === "swap") {
      return error(
        `Couldn't ${look.stop.what} during the first look: ${look.stop.error}. Your change is in the working tree as it was and nothing was recorded. ` +
          `If the benchmark writes those files itself: ${WRITE_ELSEWHERE} Otherwise call autoresearch_run again, or autoresearch_pause if you can't tell why.`,
      )
    }

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

    const headFailure = look?.stop?.why === "head" ? look.stop.failure : undefined
    const complete = !failure && !headFailure
    const metric = complete ? median(samples) : null
    const checksFailed = checks !== null && (checks.code !== 0 || checks.timedOut)
    const pending: PendingRun = {
      segment: config.segment,
      samples,
      metric,
      metrics,
      // The candidate's own exit state: a failure of the last commit isn't the experiment's crash.
      exitCode: headFailure ? 0 : last.code,
      timedOut: headFailure ? false : last.timedOut,
      checks: !hasChecks ? "none" : checks === null ? "skipped" : checksFailed ? "failed" : "passed",
      timeoutSeconds,
      checksTimeoutSeconds,
      fingerprint: { ...before.fp, tree: after.tree, inputs: inputsAfter.hash, inputFiles: inputsAfter.files },
      benchmarkWrites,
      ...(look ? { look: look.pairs } : {}),
      ...(headFailure ? { headFailure } : {}),
    }
    await host.storage.set(runKey(sessionID), pending)

    if (headFailure) {
      return error(
        `The first look measures the last commit next to your change, and on the last commit ${headFailure}. ` +
          "Your change is back in the working tree as it was and nothing was logged. If the benchmark is flaky, call autoresearch_run " +
          "again. If it really fails without your change, log `discard` (a keep isn't possible without a comparison) and call " +
          "autoresearch_pause to tell the user.\n" +
          `── output (tail) ──\n${tailLines(last.output, 30)}`,
      )
    }

    const unit = config.metric_unit
    const slow = isSlow(config.repeat)
    const lookGain = look && complete ? medianPairGain(look.pairs, config.direction) : 0
    const lines: string[] = []
    if (isBaseline) {
      lines.push(
        `${config.metric_name}: ` +
          (metric === null ? `– (${failure})` : `${withUnit(metric, unit)}${config.repeat > 1 ? ` (median of ${config.repeat})` : ""}`) +
          ` · wall ${(wallMs / 1000).toFixed(2)}s`,
      )
      if (samples.length > 1) lines.push(`samples: ${samples.map(fmt).join(", ")}`)
    } else {
      const n = look!.pairs.length
      lines.push(
        `${config.metric_name}, first look: ` +
          (complete
            ? `${n} back-to-back pair${n === 1 ? "" : "s"} of the last commit and your change, median ${gainText(lookGain)}`
            : `– (${failure}, on your change, in pair ${n + 1} of ${pairCount})`) +
          ` · wall ${(wallMs / 1000).toFixed(2)}s`,
      )
      if (n) {
        lines.push(
          `pairs (last commit → your change${unit ? `, ${unit}` : ""}): ` +
            look!.pairs.map((p) => `${fmt(p[0])} → ${fmt(p[1])} (${gainText(pairGain(p, config.direction))})`).join(", "),
        )
      }
    }
    const secondary = Object.entries(metrics)
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
      verdict =
        "This is the baseline (one warm-up run was done first and not counted). Log it with status `keep`. " +
        "Its numbers are for orientation only: every later comparison is measured fresh, next to your change."
    } else {
      const stage = stagePairs(config.repeat)
      const rough = slow
        ? "This is one pair, with no statistical meaning (slow mode)."
        : `This is a rough look from ${look!.pairs.length} pairs, not a result: such a median is often off by a few percent.`
      const simplify =
        "Only if the change removes more lines than it adds: `keep` with `simplification: true`, which is kept unless it measures worse."
      if (lookGain > 0) {
        verdict =
          `Looks better (median ${gainText(lookGain)}). ${rough} Propose it: log \`keep\`. The plugin then measures ` +
          (slow
            ? `${stage} fresh pair${stage === 1 ? "" : "s"} (${2 * stage} benchmark runs) and commits only if every pair is better and the median is at least ${settings.minImprovement * 100}%`
            : `${stage} fresh pairs (${2 * stage} benchmark runs; ${stage} more pairs when those are promising but not conclusive) and commits only if an exact paired test confirms the gain`) +
          "; otherwise it reverts and logs a discard. Proposing costs benchmark time, never truth."
      } else if (lookGain >= -settings.minImprovement) {
        verdict = `Looks about equal (median ${gainText(lookGain)}). ${rough} Log \`discard\`: a \`keep\` is refused when the look doesn't say better. ${simplify}`
      } else {
        verdict = `Looks worse (median ${gainText(lookGain)}). ${rough} Log \`discard\`. ${simplify}`
      }
    }
    lines.push("", verdict, "Don't change any file before logging: a keep is refused if the code differs from what was measured.")
    lines.push("", "── output (tail) ──", tailLines(last.output, OUTPUT_TAIL_LINES))
    if (checksFailed) lines.push("", "── checks output (tail) ──", tailLines(checks!.output, OUTPUT_TAIL_LINES))
    return { content: lines.join("\n") }
  }
}

// ── Pairs ─────────────────────────────────────────────────

const medians = (perName: Record<string, number[]>) => Object.fromEntries(Object.entries(perName).map(([k, vs]) => [k, median(vs)]))

type Side = "head" | "candidate"

/** What measurePairs() got done. */
interface PairBatch {
  /** The pairs completed in this call, in order. */
  pairs: Pair[]
  /** The candidate's secondary metrics, one value per completed pair. */
  metrics: Record<string, number[]>
  /** Output of the candidate's last run, or of the run that failed. */
  last: ShellResult
  wallMs: number
  /** Why it stopped before all pairs were measured. The candidate's files are back in every case. */
  stop?:
    | { why: "candidate" | "head"; failure: string }
    | { why: "aborted" }
    /** The files weren't the measured candidate when the first swap was due. Nothing was touched. */
    | { why: "changed"; error: string }
    | { why: "swap"; what: string; error: string }
  /** The candidate's files could NOT be put back (someone edited a file meanwhile): the loop must pause. */
  pause?: string
}

/**
 * Measure `count` pairs: one run of the last commit and one of the candidate, back to
 * back. The order inside the pairs alternates (headFirst): HC, CH, HC, … so the files
 * change hands once per pair, between its two runs, and a steady drift of the machine's
 * speed helps the candidate in one pair and hurts it in the next.
 *
 * Why pairs: v0.2.0 compared the candidate with current's LOGGED samples; the same tree
 * measured 13 % apart minutes later. v0.2.1 measured blocks (HEAD, candidate, HEAD); one
 * load burst on one block rejected a change that was 10 % faster. In a pair both runs are
 * seconds apart, and the decision ranks pair differences (stats.ts).
 *
 * The scope's files are swapped with swapScope: only paths that differ between the two
 * trees are touched, each swap starts from exactly the tree the last one left (an edit
 * made meanwhile is refused, never overwritten) and is verified by hashing the files.
 * While pairs are measured a marker in plugin storage names the candidate's tree. Whatever
 * happens (an abort, a failing benchmark, an exception) the `finally` puts the candidate
 * back; if even that fails or the process dies, the next tool call or loop start does it
 * from the marker.
 */
async function measurePairs(
  host: Host,
  cwd: string,
  config: ConfigEntry,
  o: {
    /** The measured tree (the run's fingerprint) and HEAD's tree. */
    candidate: string
    head: string
    fingerprint: Fingerprint
    /** Index of the first pair to measure: it decides which side goes first. */
    from: number
    count: number
    /** For progress labels: pairs there will be in all. */
    total: number
    timeoutSeconds: number
    context: ToolCtx
    what: "first look" | "deciding"
    /** Called after every completed pair, before the next one starts. */
    onPair?: (pair: Pair, candidateMetrics: Record<string, number>) => Promise<void>
  },
): Promise<PairBatch> {
  const batch: PairBatch = { pairs: [], metrics: {}, last: { code: null, output: "", durationMs: 0, timedOut: false }, wallMs: 0 }
  const treeOf: Record<Side, string> = { head: o.head, candidate: o.candidate }
  const marker: SwapMarker = {
    directory: cwd,
    sessionID: o.context.sessionID,
    tree: o.candidate,
    head: o.fingerprint.head,
    branch: o.fingerprint.branch,
    at: new Date().toISOString(),
  }
  // Where the files are, as far as this function made them so. `unsure`: a swap failed
  // halfway or something threw, so only hashing can tell.
  let at: Side = "candidate"
  let unsure = false
  let swaps = 0
  let thrown: { error: unknown } | undefined
  shared.swapping.add(cwd)
  try {
    await host.storage.set(swapKey(cwd), marker)
    try {
      pairs: for (let k = o.from; k < o.from + o.count; k++) {
        const value: Partial<Record<Side, number>> = {}
        let candidateMetrics: Record<string, number> = {}
        for (const side of (headFirst(k) ? ["head", "candidate"] : ["candidate", "head"]) as Side[]) {
          if (at !== side) {
            // From exactly the tree the files should be at: the permission prompts and the
            // benchmark runs take a while, and whatever was edited meanwhile is in neither
            // tree, so swapping over it would lose it.
            const swap = await swapScope(cwd, treeOf[side], { exactly: treeOf[at] })
            if (!swap.ok) {
              if (!swap.untouched) unsure = true
              batch.stop =
                swaps === 0 && swap.untouched
                  ? { why: "changed", error: swap.error }
                  : { why: "swap", what: side === "head" ? "set the files to the last commit" : "put your change back", error: swap.error }
              break pairs
            }
            at = side
            swaps++
          }
          const label = `${o.what}: pair ${k + 1}/${o.total}, ${side === "head" ? "last commit" : "your change"}`
          const m = await measure(host, cwd, config, 1, o.timeoutSeconds, o.context, label)
          batch.wallMs += m.wallMs
          if (side === "candidate" || m.failure) batch.last = m.last
          if (o.context.signal?.aborted) {
            batch.stop = { why: "aborted" }
            break pairs
          }
          if (m.failure) {
            batch.stop = { why: side, failure: m.failure }
            break pairs
          }
          value[side] = m.samples[0]
          if (side === "candidate") candidateMetrics = m.metrics
        }
        const pair: Pair = [value.head!, value.candidate!]
        batch.pairs.push(pair)
        for (const [name, v] of Object.entries(candidateMetrics)) (batch.metrics[name] ??= []).push(v)
        await o.onPair?.(pair, candidateMetrics)
      }
    } catch (err) {
      thrown = { error: err }
      unsure = true
    } finally {
      host.setStatus(cwd, { running: false })
      if (at === "candidate" && !unsure) {
        // The files are the candidate's as far as swapping goes. (If the benchmark wrote
        // into the project during the last run, the caller's own tree check finds it.)
        await host.storage.remove(swapKey(cwd))
      } else {
        // Back to the candidate. Only files that are at HEAD's or the candidate's version
        // are touched: one at neither was edited by someone meanwhile, and overwriting it
        // would lose that edit.
        const back = await swapScope(cwd, o.candidate, { oneOf: [o.head] }).catch((err) => ({ ok: false as const, error: String(err) }))
        if (back.ok) {
          await host.storage.remove(swapKey(cwd))
        } else {
          // The marker stays: the next tool call or loop start tries again.
          batch.pause =
            `Loop paused: Couldn't put the experiment's files back after measuring the last commit: ${back.error}. ` +
            `Nothing was overwritten. The experiment's files are saved in git as tree ${o.candidate}; revert or stash the changed files ` +
            "and `/autoresearch` puts the experiment back."
        }
      }
    }
  } finally {
    shared.swapping.delete(cwd)
  }
  // A failure to put the files back outranks whatever was thrown; otherwise rethrow.
  if (thrown && !batch.pause) throw thrown.error
  return batch
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
      const summary = segmentSummaries([config, ...runs, entry])[0]
      const sentence = progressSentence(summary)
      const lines = [
        headline,
        `Segment ${config.segment} so far: ${progressText(summary)}`,
        // The one way to state progress. Agents used to divide the baseline's absolute
        // number by the current one, which compares measurements taken hours apart.
        ...(sentence
          ? [
              `When you report progress, use this sentence: "${sentence}". Never quote a ratio or difference of absolute numbers measured at different times.`,
            ]
          : []),
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
    const look = pending.look ?? []
    const lookHeads = look.map((p) => p[0])

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
          commit: null,
          // What the first look saw, for the record. No `gain`/`pairs`: nothing was decided on it.
          ...(look.length ? { look_pairs: look } : {}),
          ...(metric !== null && lookHeads.length ? { vs: median(lookHeads) } : {}),
          timestamp: new Date().toISOString(),
        },
        `Run #${entryBase.run} logged as ${status}; changes reverted to the last commit.`,
      )
    }

    // ── keep ──
    // 1. Only a clean measurement of exactly this code can be kept.
    if (pending.headFailure) {
      return error(
        `During the first look the last commit failed the benchmark (${pending.headFailure}), so there is nothing to compare your change with. ` +
          "Call autoresearch_run again if the benchmark is flaky; otherwise log `discard` and call autoresearch_pause.",
      )
    }
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

    // 2. Baseline: the unchanged code. Nothing to commit, nothing to compare with.
    if (!current) {
      if (fp.tree !== tree) return error("The baseline must be the unchanged code. Revert your changes and call autoresearch_run again.")
      return finish(
        {
          ...entryBase,
          status: "keep",
          metric: pending.metric,
          metrics: pending.metrics,
          samples: pending.samples,
          commit: null,
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
    const neutral = simplification === true
    const lookGain = look.length ? medianPairGain(look, config.direction) : 0
    if (pending.decision && pending.decision.neutral !== neutral) {
      // The two kinds are judged by different rules; switching after the pairs are in
      // would be picking the rule that fits the result.
      return error(
        `This keep was proposed ${pending.decision.neutral ? "with" : "without"} \`simplification: true\` and its pairs are already measured. ` +
          "Log it the same way again, or log `discard`.",
      )
    }
    if (neutral) {
      // "Simplification" used to be a claim the agent made, and it was used to get a
      // performance change past the filter below. Now it's something the diff shows.
      const lines = await diffLineCounts(cwd, tree, fp.tree)
      if (!lines) return error("Couldn't read the size of the change (git diff failed). Try again, or log `discard`.")
      if (lines.removed <= lines.added) {
        return error(
          `\`simplification: true\` is only for changes that remove more lines than they add; this one adds ${lines.added} and removes ${lines.removed}. ` +
            "If it's meant to perform better, log `keep` without `simplification` (that needs a first look that says better). Otherwise log `discard`.",
        )
      }
    } else if (!pending.decision && !(lookGain > 0)) {
      // A filter for benchmark time, not for truth: the look's pairs are fresh and never
      // enter the decision, so skipping it wouldn't bias anything. It keeps an agent from
      // spending 16 runs on every change the look already says nothing good about.
      return error(
        `The first look didn't say better (median ${gainText(lookGain)} in ${look.length} pair${look.length === 1 ? "" : "s"}), so there's no gain to confirm. ` +
          "Log it as `discard`. Only if the change removes more lines than it adds at about equal performance: `keep` with `simplification: true`.",
      )
    }

    // 4. The decision. Ask for every permission first: a rejection halfway would leave a
    // measured-but-undecided tree behind.
    await host.assertShell(context, [MEASURE_COMMAND, gitCommandLine(GIT_SWAP), gitCommandLine(GIT_ADD), gitCommandLine(GIT_COMMIT)], true)
    await host.assertShell(context, revertCommands, false)

    const progress: DecisionProgress = pending.decision ?? { neutral, pairs: [], metrics: {} }
    const decideNow = () =>
      decide({ pairs: progress.pairs, direction: config.direction, repeat: config.repeat, minImprovement: settings.minImprovement, neutral })
    const save = () => host.storage.set(runKey(sessionID), { ...pending, decision: progress })
    const kept = "The pairs measured so far are kept"
    let verdict = decideNow()
    let measuredNow = false
    while (verdict.more > 0 && !progress.failure) {
      measuredNow = true
      const batch = await measurePairs(host, cwd, config, {
        candidate: fp.tree,
        head: tree,
        fingerprint: fp,
        from: progress.pairs.length,
        count: verdict.more,
        total: progress.pairs.length + verdict.more,
        timeoutSeconds: pending.timeoutSeconds,
        context,
        what: "deciding",
        onPair: async (pair, candidateMetrics) => {
          progress.pairs.push(pair)
          for (const [name, v] of Object.entries(candidateMetrics)) (progress.metrics[name] ??= []).push(v)
          await save()
        },
      })
      if (batch.pause) {
        await host.stopLoop(sessionID, batch.pause)
        return error(`${batch.pause.replace(/^Loop paused: /, "")}\nThe loop is paused and the user has been told. Don't change or revert files yourself; end your turn.`)
      }
      const stop = batch.stop
      if (stop?.why === "changed") {
        return error(
          `Files changed since the measurement (${stop.error}), so the result no longer describes this code. ` +
            "Nothing was logged or changed. Call autoresearch_run again, then log. (Or log `discard` to revert.)",
        )
      }
      if (stop?.why === "aborted") {
        return error(
          "Interrupted while the keep was being decided. Your change is back in the working tree as measured and nothing was logged. " +
            `${kept}; call autoresearch_log again to go on from there.`,
        )
      }
      if (stop?.why === "head") {
        return error(
          `The decision measures the last commit next to your change, and on the last commit ${stop.failure}. ` +
            `Your change is back in the working tree as measured and nothing was logged. ${kept}. If the benchmark is flaky, call ` +
            "autoresearch_log again; if it really fails without your change, log `discard` and call autoresearch_pause to tell the user.\n" +
            `── output (tail) ──\n${tailLines(batch.last.output, 30)}`,
        )
      }
      if (stop?.why === "swap") {
        return error(
          `Couldn't ${stop.what} while the keep was being decided: ${stop.error}. Your change is back in the working tree as measured and nothing was logged. ` +
            "Log `discard`, or call autoresearch_pause if you can't tell why.",
        )
      }
      if (stop?.why === "candidate") {
        // A candidate that fails while being measured is "not confirmed", whatever its pairs said.
        progress.failure = stop.failure
        await save()
      }
      verdict = decideNow()
    }
    if (measuredNow) {
      // The helper files must still be the measured ones (the code is checked by every swap).
      const inputsAfter = await frozenInputs(autoDir(cwd))
      if (inputsAfter.hash !== fp.inputs) {
        await host.storage.remove(runKey(sessionID))
        return error(
          `Files under .auto/ changed while the keep was being decided (${changedInputs(fp.inputFiles ?? {}, inputsAfter.files).slice(0, 10).join(", ")}), ` +
            "so nothing was logged. Don't edit files while autoresearch_log runs. Call autoresearch_run again, then log.",
        )
      }
    }

    const failed = progress.failure
    const pairs = progress.pairs
    const heads = pairs.map((p) => p[0])
    const candidates = pairs.map((p) => p[1])
    const confirmed = !failed && verdict.more === 0 && verdict.confirmed
    const metric = failed || !candidates.length ? null : median(candidates)
    const gain = failed ? null : Number.isFinite(verdict.gain) ? Number(verdict.gain.toPrecision(6)) : null
    const measured = {
      metric,
      metrics: failed ? {} : medians(progress.metrics),
      samples: failed ? [] : candidates,
      current_samples: heads,
      pairs,
      look_pairs: look,
      gain,
      p: failed ? null : verdict.p,
      ...(neutral && !failed && verdict.pWorse !== undefined ? { p_worse: verdict.pWorse } : {}),
      first_metric: pending.metric,
      ...(heads.length ? { vs: median(heads) } : {}),
    }
    const reason = failed ? `Not confirmed: ${failed} when your change was measured again (pair ${pairs.length + 1}).` : verdict.reason

    // 5a. Not confirmed: revert, and record it as a discard. The same tree can't be tried again.
    if (!confirmed) {
      const res = await revertToHead(cwd)
      if (!res.ok) {
        return error(
          `The keep was not confirmed, and reverting failed, so nothing was logged:\n${tailLines(res.output, 20)}\n` +
            "Call autoresearch_pause and tell the user; don't delete git's files yourself.",
        )
      }
      const note = failed
        ? `keep not confirmed: ${failed} while the candidate was measured again (pair ${pairs.length + 1}); first look ${gainText(lookGain)}`
        : `keep not confirmed: median ${gainText(verdict.gain)} over ${verdict.used} pair${verdict.used === 1 ? "" : "s"}, better in ${verdict.better}` +
          `${verdict.p === null ? " (slow mode, no test)" : ` (${pText(verdict.p)})`}; first look ${gainText(lookGain)}`
      // A cost paid only by the run right after a file swap hides gains smaller than itself.
      const rebuild =
        !failed && !neutral && swapOrderEffect(pairs, config.direction)
          ? "\nNote: in every pair the run right after the files were swapped was the slower one. If measure.sh times a rebuild of changed " +
            "files, that cost hides real gains: it should build first and time only the workload (a benchmark change: commit it, then autoresearch_init)."
          : ""
      return finish(
        { ...entryBase, status: "discard", ...measured, commit: null, note, timestamp: new Date().toISOString() },
        `Run #${entryBase.run}: keep NOT confirmed, so the changes were reverted and the run is logged as discard.\n${reason}${rebuild}\n` +
          "Don't retry the same change hoping for a luckier measurement; move on to a different idea.",
      )
    }

    // 5b. Confirmed: commit exactly the measured tree.
    // The message goes to git as data (stdin), never through a shell.
    const res = await commitKeep(
      cwd,
      `autoresearch: ${entryBase.description} (${config.metric_name}=${fmt(metric)}${neutral ? ", simplification" : ""})`,
    )
    if (!res.ok || !res.commit) {
      // Don't log a keep that isn't in git: the changes stay in place, unstaged.
      return error(
        `Couldn't commit, so the run was NOT logged:\n${tailLines(res.ok ? "nothing to commit" : res.error, 20)}\n` +
          "Call autoresearch_log again to retry (nothing is measured again), or log `discard` to revert.",
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
      `Run #${entryBase.run} logged as keep @ ${res.commit}${neutral ? " (simplification)" : ""}.\n${reason}` + (mismatch ? `\n${mismatch}` : ""),
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
  // If a measurement was cut off earlier, the files must be back before "uncommitted
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
        ? unlogged
          ? "\nNote: the working tree holds the changes of an experiment that wasn't logged. `/autoresearch` resumes with it while those files stay exactly as they are; " +
            "otherwise it won't resume until they're committed, stashed or reverted."
          : "\nNote: the working tree has uncommitted changes. `/autoresearch` won't resume until they're committed, stashed or reverted."
        : "") +
      "\n`/autoresearch` resumes the loop.",
  )
  return {
    content:
      "Loop paused; the user has been told why. End your turn now with a short summary: what was achieved, why you paused, and what you need from the user." +
      (leftovers ? " Mention that uncommitted changes are still in the working tree." : ""),
  }
}
