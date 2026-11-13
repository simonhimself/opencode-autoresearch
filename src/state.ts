// Session state for autoresearch. Everything durable lives in `<cwd>/.auto/`,
// so a fresh agent (or a new OpenCode session) can resume from files alone.
//
// This file also holds the pure rules: what "baseline" and "current" mean (summarize) and
// when a candidate counts as better than current (judge). They are pure on purpose: the
// keep decision is the heart of the plugin and must be testable without git or OpenCode.

import { appendFile, mkdir, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"

export type Direction = "lower" | "higher"
export type RunStatus = "keep" | "discard" | "crash" | "checks_failed"

/**
 * Written by autoresearch_init. Each one starts a new "segment" of comparable runs and
 * freezes how they're measured: the benchmark files (by hash) and the repeat count.
 */
export interface ConfigEntry {
  type: "config"
  segment: number
  name: string
  metric_name: string
  metric_unit: string
  direction: Direction
  /** Benchmark runs per measurement, fixed for the segment (mixed counts aren't comparable). */
  repeat: number
  /** sha256 of .auto/measure.sh when the segment started. */
  measure_hash: string
  /** sha256 of .auto/checks.sh, or null when the segment has no checks. */
  checks_hash: string | null
  timestamp: string
}

/** Written by autoresearch_log, one per measured experiment. */
export interface RunEntry {
  type: "run"
  segment: number
  run: number
  status: RunStatus
  /** Median of `samples`; null when the run produced no value (crash, missing METRIC line). */
  metric: number | null
  /** Secondary metrics as measured (medians), never typed in by the agent. */
  metrics: Record<string, number>
  /**
   * The measured values. For a keep these are the confirmation samples (the first measurement
   * was selected for looking good, so it's biased); the baseline's are its only measurement.
   */
  samples: number[]
  /** Spread (MAD) of `samples`; null with fewer than 3. */
  noise: number | null
  description: string
  asi: Record<string, unknown>
  commit: string | null
  /** gain / standard error of THIS keep vs the state before it. Null for non-keeps, "exact" and unknown. */
  confidence: number | null
  /** The segment's first keep: the unchanged code, measured on a clean tree. */
  baseline?: true
  /** A simplification kept at equal performance (not an improvement). */
  neutral?: true
  /** Median of the first (pre-confirmation) measurement, for keeps and unconfirmed keeps. */
  first_metric?: number
  /** Current's metric this run was compared with. */
  vs?: number
  /** E.g. "keep not confirmed: first 95, confirmed 101, current 100". */
  note?: string
  timestamp: string
}

export type LogEntry = ConfigEntry | RunEntry

export const autoDir = (cwd: string) => join(cwd, ".auto")
export const logPath = (cwd: string) => join(autoDir(cwd), "log.jsonl")
export const promptPath = (cwd: string) => join(autoDir(cwd), "prompt.md")
export const measurePath = (cwd: string) => join(autoDir(cwd), "measure.sh")
export const checksPath = (cwd: string) => join(autoDir(cwd), "checks.sh")
export const settingsPath = (cwd: string) => join(autoDir(cwd), "config.json")

export async function readLog(cwd: string): Promise<LogEntry[]> {
  if (!existsSync(logPath(cwd))) return []
  const raw = await readFile(logPath(cwd), "utf8")
  const entries: LogEntry[] = []
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed?.type === "config" || parsed?.type === "run") entries.push(parsed)
    } catch {
      // A torn final line from a crash shouldn't break the whole session.
    }
  }
  return entries
}

export async function appendLog(cwd: string, entry: LogEntry): Promise<void> {
  await mkdir(autoDir(cwd), { recursive: true })
  // If the file was edited by hand and lost its final newline, add one first.
  // Otherwise the new entry would be glued onto the last line and both lost.
  let prefix = ""
  if (existsSync(logPath(cwd))) {
    const raw = await readFile(logPath(cwd), "utf8")
    if (raw.length && !raw.endsWith("\n")) prefix = "\n"
  }
  await appendFile(logPath(cwd), prefix + JSON.stringify(entry) + "\n")
}

/** The active config is the most recent autoresearch_init; runs before it belong to older segments. */
export function currentSegment(entries: LogEntry[]) {
  const configs = entries.filter((e): e is ConfigEntry => e.type === "config")
  const config = configs.at(-1)
  const runs = config
    ? entries.filter((e): e is RunEntry => e.type === "run" && e.segment === config.segment)
    : []
  return { config, runs }
}

export const countRuns = (entries: LogEntry[]) => entries.filter((e) => e.type === "run").length

export const isBetter = (a: number, b: number, direction: Direction) =>
  direction === "lower" ? a < b : a > b

/** The last keep of a segment: the run that describes HEAD, which every candidate is compared with. */
export function currentRun<R extends Pick<RunEntry, "status">>(runs: R[]): R | undefined {
  for (let i = runs.length - 1; i >= 0; i--) if (runs[i].status === "keep") return runs[i]
  return undefined
}

/**
 * Baseline = first keep of the segment; current = last keep. Only keeps count: a crash has
 * no value. There is deliberately no "best of all runs": the minimum of many noisy
 * measurements drifts down on its own, which is how no-op experiments used to look like
 * gains. Every keep was confirmed against the keep before it, so the last keep IS the best
 * known state. `best` is the same value under the old name, for callers that still use it.
 */
export function summarize(runs: Pick<RunEntry, "status" | "metric">[], _direction?: Direction) {
  const keeps = runs.filter((r) => r.status === "keep" && typeof r.metric === "number")
  const baseline = keeps[0]?.metric ?? null
  const current = keeps.at(-1)?.metric ?? null
  return { baseline, current, best: current }
}

/** A run's samples as a list (entries written before v0.2 stored only a count). */
export function sampleList(run: Pick<RunEntry, "samples" | "metric">): number[] {
  if (Array.isArray(run.samples)) return run.samples.filter((v) => typeof v === "number")
  return typeof run.metric === "number" ? [run.metric] : []
}

/**
 * Trailing runs without an improvement, counted from `from` (the number of runs logged
 * when the loop was last turned on, so a resume starts with a fresh allowance). A keep
 * resets the count. Baselines are skipped: measuring the unchanged code is neither an
 * improvement nor a failed attempt.
 */
export function noImprovementStreak(entries: LogEntry[], from = 0): number {
  const runs = entries.filter((e): e is RunEntry => e.type === "run").slice(from)
  let streak = 0
  for (let i = runs.length - 1; i >= 0; i--) {
    if (runs[i].status === "keep" && runs[i].baseline) continue
    if (runs[i].status === "keep") break
    streak++
  }
  return streak
}

/**
 * Parse `METRIC name=value` lines from benchmark output.
 * Last value wins if a name is printed twice.
 */
export function parseMetrics(output: string): Record<string, number> {
  const metrics: Record<string, number> = {}
  const re = /^METRIC\s+([\w.\-]+)=(\S+)\s*$/gm
  for (const m of output.matchAll(re)) {
    const value = Number(m[2])
    if (Number.isFinite(value)) metrics[m[1]] = value
  }
  return metrics
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** MAD (median absolute deviation): a spread estimate that one outlier can't skew. */
export function mad(values: number[]): number {
  const center = median(values)
  return median(values.map((v) => Math.abs(v - center)))
}

// ── judge ─────────────────────────────────────────────────

export interface JudgeInput {
  /** Samples of current (the last keep). */
  current: number[]
  /** Fresh confirmation samples of the candidate, measured after the agent proposed the keep. */
  candidate: number[]
  /** Median of the first measurement (the one that made the agent propose the keep). */
  firstMetric?: number
  direction: Direction
  /** Relative gain needed when there's no noise estimate (settings.minImprovement). */
  minImprovement: number
  /** A simplification: "not worse" is enough. */
  neutral?: boolean
}

export interface Verdict {
  confirmed: boolean
  /** Improvement of the candidate median over the current median; positive = better. */
  gain: number
  /** `gain` relative to the current median. */
  relGain: number
  /** Standard error of the difference of medians; null without a noise estimate. */
  se: number | null
  /** gain / se; null when the metric is exact or the noise is unknown. */
  confidence: number | null
  /** True when both sides repeat one identical value (a deterministic metric such as a file size). */
  exact: boolean
  /** A sentence the tool shows the agent. */
  reason: string
}

/** MAD → standard deviation for normal data. */
const MAD_TO_SIGMA = 1.4826
/** The median of n samples has about 1.2533 × sigma / sqrt(n) standard error. */
const MEDIAN_SE = 1.2533
/** Standard errors a gain must clear. */
const CONFIRM_AT = 2

const signedGain = (candidate: number, current: number, direction: Direction) =>
  direction === "lower" ? current - candidate : candidate - current
const relative = (gain: number, base: number) =>
  base !== 0 ? gain / Math.abs(base) : gain === 0 ? 0 : gain > 0 ? Infinity : -Infinity
const pct = (rel: number) =>
  Number.isFinite(rel) ? `${rel > 0 ? "+" : ""}${(rel * 100).toFixed(Math.abs(rel) >= 0.1 ? 1 : 2)}%` : rel > 0 ? "+∞" : "−∞"
const num = (n: number) => (Number.isInteger(n) || String(n).length <= 12 ? String(n) : String(Number(n.toPrecision(8))))

/**
 * Is the candidate better than current (or, for a simplification, not worse)?
 *
 * Confidence is per keep: this candidate against the state before it. It is never
 * cumulative, so one real win can't make later noise look significant.
 *
 * - With ≥ 3 samples on both sides the noise is estimated from the samples themselves and
 *   the gain must clear 2 standard errors. On top of that the first measurement must have
 *   been better too: the agent may only propose a keep on a measurement that looked
 *   better, and asking for two independent agreeing measurements halves the false keeps.
 * - Without a noise estimate (repeat 1–2), or when the estimate is zero although the
 *   samples differ (a coarse metric with ties), the gain must reach `minImprovement` in
 *   both measurements.
 */
export function judge(input: JudgeInput): Verdict {
  const { current, candidate, firstMetric, direction, minImprovement, neutral = false } = input
  if (!current.length || !candidate.length) {
    return { confirmed: false, gain: 0, relGain: 0, se: null, confidence: null, exact: false, reason: "No samples to compare." }
  }
  const cur = median(current)
  const cand = median(candidate)
  const gain = signedGain(cand, cur, direction)
  const relGain = relative(gain, cur)
  const firstRel = firstMetric === undefined ? undefined : relative(signedGain(firstMetric, cur, direction), cur)
  const numbers =
    `current ${num(cur)}, ` +
    (firstMetric === undefined ? "" : `first measurement ${num(firstMetric)}, `) +
    `confirmation ${num(cand)} (${pct(relGain)})`
  const base = { gain, relGain }

  if (current.length >= 3 && candidate.length >= 3) {
    const sigma = MAD_TO_SIGMA * median([mad(current), mad(candidate)])
    const se = MEDIAN_SE * sigma * Math.sqrt(1 / current.length + 1 / candidate.length)
    const identical = (xs: number[]) => xs.every((x) => x === xs[0])

    if (se === 0 && identical(current) && identical(candidate)) {
      const confirmed = neutral ? gain >= 0 : gain > 0
      return {
        ...base,
        confirmed,
        se: 0,
        confidence: null,
        exact: true,
        reason: confirmed
          ? neutral && gain === 0
            ? `Confirmed: the metric is exact and unchanged (${numbers}).`
            : `Confirmed: the metric is exact and better (${numbers}).`
          : `Not confirmed: the metric is exact and ${gain === 0 ? "unchanged" : "worse"} (${numbers}).`,
      }
    }
    if (se > 0) {
      const confidence = gain / se
      if (neutral) {
        const confirmed = confidence >= -CONFIRM_AT
        return {
          ...base,
          confirmed,
          se,
          confidence,
          exact: false,
          reason: confirmed
            ? `Confirmed as a simplification: not worse than current beyond the noise (${numbers}; ${confidence.toFixed(1)} standard errors).`
            : `Not confirmed: worse than current beyond the noise (${numbers}; ${confidence.toFixed(1)} standard errors).`,
        }
      }
      if (firstRel !== undefined && firstRel <= 0) {
        return {
          ...base,
          confirmed: false,
          se,
          confidence,
          exact: false,
          reason: `Not confirmed: the first measurement wasn't better than current (${numbers}).`,
        }
      }
      const confirmed = confidence >= CONFIRM_AT
      return {
        ...base,
        confirmed,
        se,
        confidence,
        exact: false,
        reason: confirmed
          ? `Confirmed: ${numbers}, ${confidence.toFixed(1)} standard errors above the noise.`
          : `Not confirmed: ${numbers} is ${confidence.toFixed(1)} standard errors; a keep needs ${CONFIRM_AT}. ` +
            "The first measurement was probably a lucky draw.",
      }
    }
    // se === 0 but the samples differ: fall through to the fixed threshold.
  }

  const threshold = `${(minImprovement * 100).toFixed(2).replace(/\.?0+$/, "")}%`
  if (neutral) {
    const confirmed = relGain >= -minImprovement
    return {
      ...base,
      confirmed,
      se: null,
      confidence: null,
      exact: false,
      reason: confirmed
        ? `Confirmed as a simplification: not worse than current by more than ${threshold} (${numbers}).`
        : `Not confirmed: worse than current by more than ${threshold} (${numbers}).`,
    }
  }
  const confirmed = relGain >= minImprovement && (firstRel === undefined || firstRel >= minImprovement)
  return {
    ...base,
    confirmed,
    se: null,
    confidence: null,
    exact: false,
    reason: confirmed
      ? `Confirmed: at least ${threshold} better in both measurements (${numbers}). No noise estimate with fewer than 3 usable samples.`
      : `Not confirmed: without a noise estimate a keep needs at least ${threshold} in both the first measurement and the confirmation (${numbers}).`,
  }
}

// ── Settings ──────────────────────────────────────────────

export interface Settings {
  /** Most logged runs in total (all segments). */
  maxIterations: number
  /** Pause after this many runs in a row without a (non-baseline) keep. */
  maxNoImprovement: number
  /** Relative gain needed when there are fewer than 3 samples. */
  minImprovement: number
  /** Problems found in .auto/config.json; shown to the user instead of silently ignored. */
  warnings: string[]
}

export const DEFAULT_SETTINGS = { maxIterations: 50, maxNoImprovement: 10, minImprovement: 0.01 } as const

/**
 * Settings from .auto/config.json. There is always a budget: a missing or invalid value
 * falls back to the default (and says so), it never means "no limit".
 */
export async function readSettings(cwd: string): Promise<Settings> {
  const settings: Settings = { ...DEFAULT_SETTINGS, warnings: [] }
  if (!existsSync(settingsPath(cwd))) return settings
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(settingsPath(cwd), "utf8"))
  } catch {
    settings.warnings.push(".auto/config.json isn't valid JSON; using the defaults.")
    return settings
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    settings.warnings.push(".auto/config.json must be a JSON object; using the defaults.")
    return settings
  }
  const obj = raw as Record<string, unknown>
  // Numbers also as numeric strings ("50"): a common way to write them by hand.
  const read = (key: keyof typeof DEFAULT_SETTINGS, valid: (n: number) => boolean, rule: string, integer: boolean) => {
    const value = obj[key]
    if (value === undefined) return
    const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN
    if (!Number.isFinite(n) || !valid(n)) {
      settings.warnings.push(`${key} must be ${rule} (got ${JSON.stringify(value)}); using the default ${DEFAULT_SETTINGS[key]}.`)
      return
    }
    settings[key] = integer ? Math.floor(n) : n
  }
  read("maxIterations", (n) => n >= 1, "a number ≥ 1", true)
  read("maxNoImprovement", (n) => n >= 1, "a number ≥ 1", true)
  read("minImprovement", (n) => n >= 0 && n < 1, "a fraction from 0 up to 1 (0.01 = 1 %)", false)
  for (const key of Object.keys(obj)) {
    if (!(key in DEFAULT_SETTINGS)) settings.warnings.push(`Unknown key "${key}" in .auto/config.json is ignored.`)
  }
  return settings
}
