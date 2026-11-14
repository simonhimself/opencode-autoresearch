// Session state for autoresearch. Everything durable lives in `<cwd>/.auto/`,
// so a fresh agent (or a new OpenCode session) can resume from files alone.
//
// This file also holds the pure rules: what "baseline" and "current" mean (summarize) and
// when a candidate counts as better than HEAD (judge), and how progress is counted
// (compoundedGain). They are pure on purpose: the
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
  /**
   * Hash over every other file under .auto/ except log.jsonl, ideas.md, config.json and
   * prompt.md: helper files the benchmark may read. Missing in segments started before
   * v0.2.1; those aren't checked for it.
   */
  inputs_hash?: string
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
   * The measured values. For a proposed keep (confirmed or not) these are the candidate's
   * samples from the paired confirmation (the first measurement was selected for looking
   * good, so it's biased); the baseline's are its only measurement.
   */
  samples: number[]
  /**
   * Proposed keeps only: HEAD's samples from the same paired confirmation, measured right
   * before and right after the candidate. The decision compares `samples` with these and
   * with nothing else: numbers logged at other times aren't comparable (machine speed drifts).
   */
  current_samples?: number[]
  /** Spread (MAD) of `samples`; null with fewer than 3. */
  noise: number | null
  description: string
  asi: Record<string, unknown>
  commit: string | null
  /**
   * gain / standard error of THIS proposed keep vs HEAD in its paired confirmation. Also
   * recorded for keeps that weren't confirmed (logged as discard), for auditing. Null for
   * other runs, for "exact" and when there's no noise estimate.
   */
  confidence: number | null
  /** The segment's first keep: the unchanged code, measured on a clean tree. */
  baseline?: true
  /** A simplification kept at equal performance (not an improvement). */
  neutral?: true
  /** Median of the first (pre-confirmation) measurement, for keeps and unconfirmed keeps. */
  first_metric?: number
  /**
   * What this run was compared with. Proposed keeps: the median of `current_samples`.
   * Other runs: current's logged metric (a rough reference from another time).
   */
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

/** Keeps that are experiments: the baseline is the unchanged code and never counts as "kept". */
export const keptRuns = <R extends Pick<RunEntry, "status" | "baseline">>(runs: R[]) =>
  runs.filter((r) => r.status === "keep" && !r.baseline)

/**
 * How much better the code got over a segment: the compounded gain of its confirmed keeps.
 *
 * Each keep was decided by measuring candidate and HEAD back to back, and that ratio
 * (`metric` / `vs`) is the only trustworthy number about it. `current / baseline` is not:
 * the two were measured at different times, and the same code measured 13 % apart within
 * minutes on a busy machine. So progress = the product of the keeps' ratios.
 *
 * All non-baseline keeps count, simplifications too (their ratio is near 1). Keeps without
 * a usable ratio (no `vs`, a zero or a sign change) are left out and counted in `skipped`.
 * `gain` is relative and positive when better: 0.1 = "10 % better" in the segment's direction.
 */
export function compoundedGain(runs: Pick<RunEntry, "status" | "baseline" | "metric" | "vs">[], direction: Direction) {
  let ratio = 1
  let keeps = 0
  let skipped = 0
  for (const run of keptRuns(runs)) {
    const r = typeof run.metric === "number" && typeof run.vs === "number" && run.vs !== 0 ? run.metric / run.vs : NaN
    if (!Number.isFinite(r) || r <= 0) {
      skipped++
      continue
    }
    ratio *= r
    keeps++
  }
  return { ratio, gain: direction === "lower" ? 1 - ratio : ratio - 1, keeps, skipped }
}

/**
 * A relative gain in words. The one way improvements are worded everywhere: "+69.9%" next
 * to "(-69.9%)" for the same result (gain vs change of a lower-is-better metric) confused
 * both the agent and the user. Never a sign, always "better" or "worse".
 */
export function gainText(rel: number): string {
  if (!Number.isFinite(rel)) return rel > 0 ? "better (from zero)" : "worse (from zero)"
  if (rel === 0) return "no change"
  const pct = Math.abs(rel) * 100
  const digits = pct >= 0.1 ? pct.toFixed(1) : String(Number(pct.toPrecision(2)))
  return `${digits}% ${rel > 0 ? "better" : "worse"}`
}

/** Relative gain of `value` over `reference` in the given direction; positive = better. */
export function relativeGain(value: number, reference: number, direction: Direction): number {
  return relative(signedGain(value, reference, direction), reference)
}

export interface SegmentSummary {
  config: ConfigEntry
  /** Logged runs in the segment, the baseline included. */
  runs: number
  /** Kept experiments (never the baseline). */
  kept: number
  /** Absolute values as measured at the time; not comparable with each other. */
  baseline: number | null
  current: number | null
  /** compoundedGain() of the segment. */
  gain: number
  /** Keeps left out of `gain` because they have no usable ratio. */
  skipped: number
}

/** One summary per segment, oldest first: what `/autoresearch status` shows for the whole session. */
export function segmentSummaries(entries: LogEntry[]): SegmentSummary[] {
  return entries
    .filter((e): e is ConfigEntry => e.type === "config")
    .map((config) => {
      const runs = entries.filter((e): e is RunEntry => e.type === "run" && e.segment === config.segment)
      const { baseline, current } = summarize(runs)
      const { gain, skipped } = compoundedGain(runs, config.direction)
      return { config, runs: runs.length, kept: keptRuns(runs).length, baseline, current, gain, skipped }
    })
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

/**
 * Benchmark runs on HEAD before the candidate's runs of a paired confirmation, and again
 * after them. Equal halves, so HEAD's runs sit symmetrically around the candidate's and a
 * steady drift of the machine's speed cancels. At least 3 per half once repeat ≥ 3: every
 * swap gives the changed files new timestamps, so the first run after it often pays for a
 * rebuild or cold caches; with 2 + 2 half of HEAD's samples would be such runs and the
 * median would land between "cold" and "warm" (a real 10 % gain then read as 14 %).
 */
export const halfRuns = (repeat: number) => (repeat >= 3 ? Math.max(3, Math.ceil(repeat / 2)) : Math.ceil(repeat / 2))

/** Benchmark runs a proposed keep costs on top of the first measurement. */
export const confirmationRuns = (repeat: number) => 2 * halfRuns(repeat) + repeat

export interface JudgeInput {
  /** HEAD's samples from the paired confirmation (measured right before and after the candidate). */
  current: number[]
  /** The candidate's samples from the same paired confirmation. */
  candidate: number[]
  direction: Direction
  /** Relative gain needed when there's no noise estimate (settings.minImprovement). */
  minImprovement: number
  /** A simplification: "not worse" is enough. */
  neutral?: boolean
  /** Standard errors a gain must clear. Only the simulation test sets it; the tools use CONFIRM_AT. */
  confirmAt?: number
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
/**
 * Standard errors a gain must clear. The design's rule: 2, unless a simulation of the
 * paired procedure (no-op experiments, uniform ±2 % noise, repeat 5, a keep proposed
 * whenever the first measurement looks better) gives more than 3 % false keeps per no-op;
 * then 2.5. It gives 4.9 % at 2 and 3.2 % at 2.5 (state.test.ts runs it), so: 2.5.
 * (The spread is estimated from only 5–6 samples per side, which is why "2 standard
 * errors" lets through more than the 2.3 % a known spread would.)
 */
export const CONFIRM_AT = 2.5

const signedGain = (candidate: number, current: number, direction: Direction) =>
  direction === "lower" ? current - candidate : candidate - current
const relative = (gain: number, base: number) =>
  base !== 0 ? gain / Math.abs(base) : gain === 0 ? 0 : gain > 0 ? Infinity : -Infinity
const num = (n: number) => (Number.isInteger(n) || String(n).length <= 12 ? String(n) : String(Number(n.toPrecision(8))))
const percent = (fraction: number) => `${(fraction * 100).toFixed(2).replace(/\.?0+$/, "")}%`

/**
 * Is the candidate better than HEAD (or, for a simplification, not worse)?
 *
 * Both sample sets must come from one paired confirmation: HEAD and the candidate measured
 * back to back, HEAD before and after. Samples logged at another time must never be passed
 * in: the machine's speed drifts by more than most gains within minutes, which rejected
 * sound changes and let no-ops through. The first measurement (the one that made the agent
 * propose the keep) plays no part here either; it was selected for looking good.
 *
 * Confidence is per keep: this candidate against the state before it, never cumulative,
 * so one real win can't make later noise look significant.
 *
 * - With ≥ 3 samples on both sides the noise is estimated from the samples themselves and
 *   the gain must clear CONFIRM_AT standard errors.
 * - Without a noise estimate (repeat 1–2), or when the estimate is zero although the
 *   samples differ (a coarse metric with ties), the gain must reach `minImprovement`.
 * - A simplification must not be worse beyond the noise AND not worse by more than
 *   `minImprovement`: with a noisy benchmark "within the noise" alone would wave through
 *   a real slowdown of several percent.
 */
export function judge(input: JudgeInput): Verdict {
  const { current, candidate, direction, minImprovement, neutral = false, confirmAt = CONFIRM_AT } = input
  if (!current.length || !candidate.length) {
    return { confirmed: false, gain: 0, relGain: 0, se: null, confidence: null, exact: false, reason: "No samples to compare." }
  }
  const cur = median(current)
  const cand = median(candidate)
  const gain = signedGain(cand, cur, direction)
  const relGain = relative(gain, cur)
  const numbers = `candidate ${num(cand)} vs HEAD ${num(cur)}, measured back to back: ${gainText(relGain)}`
  const base = { gain, relGain }
  const tolerance = percent(minImprovement)

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
      const errors = `${Math.abs(confidence).toFixed(1)} standard errors ${confidence >= 0 ? "above" : "below"} HEAD`
      if (neutral) {
        const withinNoise = confidence >= -confirmAt
        const withinTolerance = relGain >= -minImprovement
        const confirmed = withinNoise && withinTolerance
        return {
          ...base,
          confirmed,
          se,
          confidence,
          exact: false,
          reason: confirmed
            ? `Confirmed as a simplification: not worse than HEAD beyond the noise or by more than ${tolerance} (${numbers}).`
            : !withinNoise
              ? `Not confirmed: worse than HEAD beyond the noise (${numbers}, ${errors}).`
              : `Not confirmed: a simplification may not cost more than ${tolerance} (${numbers}).`,
        }
      }
      const confirmed = confidence >= confirmAt
      return {
        ...base,
        confirmed,
        se,
        confidence,
        exact: false,
        reason: confirmed
          ? `Confirmed: ${numbers}, ${errors} (a keep needs ${confirmAt}).`
          : `Not confirmed: ${numbers}, ${errors}; a keep needs ${confirmAt} above. ` +
            (gain > 0 ? "The gain doesn't stand out from the noise." : "The first measurement was a lucky draw, or the machine was faster then."),
      }
    }
    // se === 0 but the samples differ: fall through to the fixed threshold.
  }

  if (neutral) {
    const confirmed = relGain >= -minImprovement
    return {
      ...base,
      confirmed,
      se: null,
      confidence: null,
      exact: false,
      reason: confirmed
        ? `Confirmed as a simplification: not worse than HEAD by more than ${tolerance} (${numbers}).`
        : `Not confirmed: worse than HEAD by more than ${tolerance} (${numbers}).`,
    }
  }
  const confirmed = relGain >= minImprovement
  return {
    ...base,
    confirmed,
    se: null,
    confidence: null,
    exact: false,
    reason: confirmed
      ? `Confirmed: at least ${tolerance} better (${numbers}). No noise estimate with fewer than 3 usable samples.`
      : `Not confirmed: without a noise estimate a keep needs at least ${tolerance} (${numbers}).`,
  }
}

// ── Settings ──────────────────────────────────────────────

export interface Settings {
  /** Most logged runs in total (all segments). */
  maxIterations: number
  /** Pause after this many runs in a row without a (non-baseline) keep. */
  maxNoImprovement: number
  /**
   * Relative gain needed when there are fewer than 3 samples, and the most a
   * simplification may cost.
   */
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
