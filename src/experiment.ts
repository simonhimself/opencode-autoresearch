// The experiment tools: autoresearch_init, _run, _log and _pause.
//
// Rule of thumb for everything here: the plugin decides, the agent proposes. The agent
// can't choose what is measured (always ./.auto/measure.sh, frozen per segment by hash),
// can't type in a result (the plugin records what it measured), and can't decide a keep
// (the plugin re-measures and judges). What it can do: change code, ask for a
// measurement, and say what it thinks the result means.
//
// The logic talks to OpenCode only through `Host`, so the tests can drive it against real
// git repos with a small fake.

import { accessSync, constants, existsSync } from "node:fs"
import {
  bash,
  changedBetween,
  commitKeep,
  currentBranch,
  fileHash,
  GIT_ADD,
  GIT_CLEAN,
  GIT_COMMIT,
  GIT_RESTORE,
  gitCommandLine,
  headSha,
  headTree,
  isTrunk,
  revertToHead,
  scopeHasTrackedFiles,
  scopeStatus,
  scopeTreeHash,
  tailLines,
  type ShellResult,
} from "./shell.ts"
import {
  appendLog,
  checksPath,
  countRuns,
  currentRun,
  currentSegment,
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
  sampleList,
  summarize,
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
  /** Files in the scope that the benchmark itself changed; such a run can't be kept. */
  benchmarkWrites: string[]
  /**
   * The confirmation measurement, stored as soon as it exists. If the commit or revert
   * after it fails and the agent calls log again, the same samples are judged again;
   * otherwise a failed git command would be a free second roll of the dice.
   */
  confirmation?: { samples: number[]; metrics: Record<string, number>; failure?: string }
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

type ToolResult = { content: string }
const error = (text: string): ToolResult => ({ content: `ERROR: ${text}` })

/** One run or log at a time per project: they share the working tree, git's index and the run numbers. */
const locks = new Map<string, Promise<unknown>>()
function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const next = (locks.get(key) ?? Promise.resolve()).then(task, task)
  locks.set(
    key,
    next.catch(() => {}),
  )
  return next
}

// ── Formatting ────────────────────────────────────────────

/** Numbers as measured: exact for integers and short decimals; long ones cut to 8 significant digits. */
export const fmt = (n: number | null | undefined) =>
  n === null || n === undefined
    ? "–"
    : Number.isInteger(n) || String(n).length <= 12
      ? String(n)
      : String(Number(n.toPrecision(8)))

/** A percentage with enough digits that a tiny change doesn't read as "-0.0%". */
export const pctText = (pct: number) =>
  `${pct > 0 ? "+" : ""}${Math.abs(pct) >= 0.1 ? pct.toFixed(1) : Number(pct.toPrecision(2))}%`

/** Change from `from` to `to` in percent, or "" when it can't be expressed. */
export const changeText = (from: number | null, to: number | null) =>
  from === null || to === null || from === 0 || from === to ? "" : ` (${pctText(((to - from) / Math.abs(from)) * 100)})`

const withUnit = (n: number | null, unit: string) => `${fmt(n)}${unit ? ` ${unit}` : ""}`

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
      `${streak} runs in a row without an improvement (maxNoImprovement = ${settings.maxNoImprovement}). ` +
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
  const [head, branch, tree, measure, checks] = await Promise.all([
    headSha(cwd),
    currentBranch(cwd),
    scopeTreeHash(cwd),
    fileHash(measurePath(cwd)),
    fileHash(checksPath(cwd)),
  ])
  if (!tree.ok) return { ok: false, error: tree.error }
  if (!head || !branch) return { ok: false, error: "no commit or no branch checked out" }
  return { ok: true, fp: { head, branch, tree: tree.tree, measure, checks } }
}

/** Why a segment's frozen benchmark no longer matches the files, or "" if it does. */
function benchmarkDrift(config: ConfigEntry, measure: string | null, checks: string | null): string {
  if (measure === null) return ".auto/measure.sh is missing"
  if (measure !== config.measure_hash) return ".auto/measure.sh changed since this segment started"
  if (checks !== (config.checks_hash ?? null)) {
    return checks === null
      ? ".auto/checks.sh was removed since this segment started"
      : config.checks_hash
        ? ".auto/checks.sh changed since this segment started"
        : ".auto/checks.sh was added since this segment started"
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
 * Run the benchmark `repeat` times, stopping at the first failure. Only the last run's
 * output is kept (capped in shell.ts); earlier ones are parsed and dropped.
 */
async function measure(
  host: Host,
  cwd: string,
  config: ConfigEntry,
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
  for (let i = 1; i <= config.repeat; i++) {
    const step = config.repeat > 1 ? `${label} (${i}/${config.repeat})` : label
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

// ── autoresearch_init ─────────────────────────────────────

export async function initExperiment(host: Host, input: unknown, context: ToolCtx): Promise<ToolResult> {
  const { sessionID } = context
  const cwd = await host.cwdOf(sessionID)
  return withLock(cwd, async () => {
    // HEAD isn't checked here: setup creates the branch and commits the session files
    // before the first init, and init is where the loop learns what HEAD is.
    const gated = await gate(host, sessionID, "branch")
    if (!gated.ok) return gated.result
    const { state } = gated
    if (state.stopping) return error("The user turned the loop off. Don't start a new segment; end your turn.")

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

    const entries = await readLog(cwd)
    const segment = (currentSegment(entries).config?.segment ?? 0) + 1
    const checksHash = await fileHash(checksPath(cwd))
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
    return {
      content: [
        `Initialized "${name.trim()}" (segment ${segment}) on branch ${branch}: ${metric_name}${metric_unit ? ` in ${metric_unit}` : ""}, ${direction} is better.`,
        `Each measurement runs ${MEASURE_COMMAND} ${rawRepeat}×` +
          (rawRepeat < 3
            ? ` (fewer than 3: no noise estimate, so a keep needs at least ${settings.minImprovement * 100}% in two measurements).`
            : " and uses the median.") +
          ` Checks: ${checksHash ? "./.auto/checks.sh" : "none (no .auto/checks.sh)"}.`,
        "The benchmark is now frozen for this segment: if measure.sh or checks.sh change, autoresearch_run refuses until you call autoresearch_init again.",
        `Runs used: ${total}/${settings.maxIterations} (all segments).`,
        ...settings.warnings.map((w) => `Settings warning: ${w}`),
        "Next: autoresearch_run for the baseline (unchanged code), then autoresearch_log with status \"keep\".",
      ].join("\n"),
    }
  })
}

// ── autoresearch_run ──────────────────────────────────────

export async function runExperiment(host: Host, input: unknown, context: ToolCtx): Promise<ToolResult> {
  const { sessionID } = context
  const cwd = await host.cwdOf(sessionID)
  return withLock(cwd, async () => {
    const gated = await gate(host, sessionID, "branch+head")
    if (!gated.ok) return gated.result
    const { state } = gated
    if (state.stopping) return error("The user turned the loop off. Don't start another experiment; end your turn.")

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
    const drift = benchmarkDrift(config, before.fp.measure, before.fp.checks)
    if (drift) {
      return error(
        `The benchmark changed: ${drift}. Results wouldn't be comparable with this segment's earlier runs. ` +
          "If the change is intended and honest (see \"What counts as cheating\" in the skill), revert your code changes and call " +
          "autoresearch_init to start a new segment with a fresh baseline. Otherwise restore the file.",
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
      result = await measure(host, cwd, config, timeoutSeconds, context, "measuring")
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
    const after = await scopeTreeHash(cwd)
    if (!after.ok) return error(`Couldn't read the repository state after the run: ${after.error}`)
    const benchmarkWrites = after.tree === before.fp.tree ? [] : await changedBetween(cwd, before.fp.tree, after.tree)
    if (after.tree !== before.fp.tree && !benchmarkWrites.length) benchmarkWrites.push("(unknown files)")

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
      fingerprint: { ...before.fp, tree: after.tree },
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
        `The benchmark itself changed files in the project: ${benchmarkWrites.slice(0, 10).join(", ")}. A keep is refused in that state, ` +
        "because the committed code would differ from the measured code. Make measure.sh write its output under .auto/ or to a " +
        "gitignored path (changing measure.sh needs a new autoresearch_init), or add those files to .gitignore."
    } else if (isBaseline) {
      verdict = "This is the baseline (one warm-up run was done first and not counted). Log it with status `keep`."
    } else {
      const cur = median(sampleList(current))
      const better = isBetter(metric!, cur, config.direction)
      verdict =
        `current is ${withUnit(cur, unit)}; this first measurement is ${fmt(metric)}${changeText(cur, metric)}, ${better ? "better" : metric === cur ? "equal" : "worse"}. ` +
        (better
          ? `Log \`keep\`: the plugin then measures ${config.repeat} more time${config.repeat > 1 ? "s" : ""} and commits only if that confirms the gain; otherwise it reverts and logs a discard.`
          : "Log `discard`. Only if the change removes or simplifies code at equal performance: `keep` with `simplification: true` (also re-measured).")
    }
    lines.push("", verdict, "Don't change any file before logging: a keep is refused if the code differs from what was measured.")
    lines.push("", "── output (tail) ──", tailLines(result.last.output, OUTPUT_TAIL_LINES))
    if (checksFailed) lines.push("", "── checks output (tail) ──", tailLines(checks!.output, OUTPUT_TAIL_LINES))
    return { content: lines.join("\n") }
  })
}

// ── autoresearch_log ──────────────────────────────────────

const STATUSES: RunStatus[] = ["keep", "discard", "crash", "checks_failed"]

export async function logExperiment(host: Host, input: unknown, context: ToolCtx): Promise<ToolResult> {
  const { sessionID } = context
  const cwd = await host.cwdOf(sessionID)
  return withLock(cwd, async () => {
    const gated = await gate(host, sessionID, "branch+head")
    if (!gated.ok) return gated.result
    const { state } = gated

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
      const { baseline, current: now } = summarize([...runs, entry])
      const lines = [
        headline,
        `baseline ${withUnit(baseline, unit)} → current ${withUnit(now, unit)}${changeText(baseline, now)}`,
        `Runs: ${countRuns(all)}/${settings.maxIterations} · without improvement: ${noImprovementStreak(all, state.startRunCount)}/${settings.maxNoImprovement}`,
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
        `The benchmark changed files in the project while measuring (${pending.benchmarkWrites.slice(0, 10).join(", ")}), so the measured ` +
          "code and the code that would be committed differ. Make the benchmark write under .auto/ or to a gitignored path, then run again. " +
          "Or log this run as `discard`.",
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
            : ""
    if (changed) {
      return error(
        `${changed[0].toUpperCase()}${changed.slice(1)} since the measurement, so the result no longer describes this code. ` +
          "Call autoresearch_run again, then log. (Or log `discard` to revert.)",
      )
    }
    const tree = await headTree(cwd)

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
    const currentSamples = sampleList(current)
    const currentMetric = median(currentSamples)
    const neutral = simplification === true
    // Not in the design's list of refusals, but in its spirit: a keep is proposed on a
    // measurement that looked better. Without this, proposing a keep on everything gives
    // each no-op a second draw against the noise. Nothing is lost: the agent can still
    // discard, or keep as a simplification.
    if (!neutral && !isBetter(pending.metric, currentMetric, config.direction)) {
      return error(
        `The measurement (${fmt(pending.metric)}) isn't better than current (${fmt(currentMetric)}), so there's no gain to confirm. ` +
          "Log it as `discard`. If the change removes or simplifies code at equal performance, log `keep` with `simplification: true`.",
      )
    }

    // 4. Confirmation. Ask for every permission first: a rejection halfway would leave a
    // measured-but-undecided tree behind.
    await host.assertShell(context, [MEASURE_COMMAND, gitCommandLine(GIT_ADD), gitCommandLine(GIT_COMMIT)], true)
    await host.assertShell(context, revertCommands, false)

    let confirmation = pending.confirmation
    if (!confirmation) {
      let result: Measurement
      try {
        result = await measure(host, cwd, config, pending.timeoutSeconds, context, "confirming")
      } finally {
        host.setStatus(cwd, { running: false })
      }
      if (context.signal?.aborted) return error("Interrupted while confirming. Nothing was logged or changed; call autoresearch_log again.")
      // The confirmed tree must still be the measured tree.
      const afterTree = await scopeTreeHash(cwd)
      if (!afterTree.ok || afterTree.tree !== fp.tree) {
        await host.storage.remove(runKey(sessionID))
        return error(
          "Files changed while the keep was being confirmed, so nothing was logged. Don't edit files while autoresearch_log runs. " +
            "Call autoresearch_run again, then log.",
        )
      }
      confirmation = { samples: result.samples, metrics: result.metrics, failure: result.failure }
      await host.storage.set(runKey(sessionID), { ...pending, confirmation })
    }

    const verdict: Verdict = confirmation.failure
      ? { confirmed: false, gain: 0, relGain: 0, se: null, confidence: null, exact: false, reason: `Not confirmed: ${confirmation.failure} during the confirmation runs.` }
      : judge({
          current: currentSamples,
          candidate: confirmation.samples,
          firstMetric: pending.metric,
          direction: config.direction,
          minImprovement: settings.minImprovement,
          neutral,
        })
    const confirmedMetric = confirmation.failure ? null : median(confirmation.samples)
    const measured = {
      metric: confirmedMetric,
      metrics: confirmation.failure ? {} : confirmation.metrics,
      samples: confirmation.failure ? [] : confirmation.samples,
      noise: !confirmation.failure && confirmation.samples.length >= 3 ? mad(confirmation.samples) : null,
      first_metric: pending.metric,
      vs: currentMetric,
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
        ? `keep not confirmed: ${confirmation.failure} during confirmation (first ${fmt(pending.metric)}, current ${fmt(currentMetric)})`
        : `keep not confirmed: first ${fmt(pending.metric)}, confirmed ${fmt(confirmedMetric)}, current ${fmt(currentMetric)}`
      return finish(
        { ...entryBase, status: "discard", ...measured, commit: null, confidence: null, note, timestamp: new Date().toISOString() },
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
        confidence: verdict.confidence === null ? null : Number(verdict.confidence.toFixed(2)),
        ...(neutral ? { neutral: true as const } : {}),
        ...(mismatch ? { note: mismatch } : {}),
        timestamp: new Date().toISOString(),
      },
      `Run #${entryBase.run} logged as keep @ ${res.commit}${neutral ? " (simplification)" : ""}.\n${verdict.reason}` +
        (mismatch ? `\n${mismatch}` : ""),
    )
  })
}

// ── autoresearch_pause ────────────────────────────────────

export async function pauseLoop(host: Host, input: unknown, context: ToolCtx): Promise<ToolResult> {
  const { sessionID } = context
  const reason = String((input as { reason?: unknown } | undefined)?.reason ?? "").trim()
  if (!reason) return error("`reason` is required: one or two sentences for the user on why you're pausing and what you need.")
  const state = await host.loopState(sessionID)
  if (!state) return { content: "The loop is already off. End your turn." }
  const unlogged = await host.storage.get(runKey(sessionID))
  const status = await scopeStatus(state.directory)
  const leftovers = status.ok && status.status !== ""
  await host.stopLoop(
    sessionID,
    `Loop paused by the agent: ${reason}` +
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
