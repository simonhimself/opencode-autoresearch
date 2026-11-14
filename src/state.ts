// Session state for autoresearch. Everything durable lives in `<cwd>/.auto/`,
// so a fresh agent (or a new OpenCode session) can resume from files alone.
//
// This file also holds the pure rules about the log: what "baseline" and "current" mean
// (summarize), what one HEAD/candidate pair says (pairGain) and how progress is counted
// (compoundedLevel). The keep decision itself is in stats.ts. All of it is pure on purpose:
// it must be testable without git or OpenCode.

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
  /**
   * Fixed for the segment. It sets the mode: 3 or more = standard (keeps are decided by an
   * exact test on HEAD/candidate pairs), 1–2 = slow (a few pairs, no statistical guarantee).
   * Also the number of benchmark runs of the baseline measurement.
   */
  repeat: number
  /** Written when `repeat` < 3, so readers needn't know the rule. */
  mode?: "slow"
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

/** One HEAD run and one candidate run measured back to back: `[head, candidate]`. */
export type Pair = [head: number, candidate: number]

/** Written by autoresearch_log, one per measured experiment. */
export interface RunEntry {
  type: "run"
  segment: number
  run: number
  status: RunStatus
  /**
   * Median of `samples`; null when the run produced no value (crash, missing METRIC line).
   * An absolute number as measured at the time: comparable only with `vs` of the same entry.
   */
  metric: number | null
  /** Secondary metrics as measured (medians), never typed in by the agent. */
  metrics: Record<string, number>
  /**
   * The candidate's measured values. Proposed keeps (confirmed or not): from the decision
   * pairs. Other experiments: from the first look's pairs. Baseline: its only measurement.
   */
  samples: number[]
  /** Proposed keeps only: HEAD's values from the decision pairs (same order as `samples`). */
  current_samples?: number[]
  /**
   * Proposed keeps only: the pairs the decision was made on, in measurement order. The
   * order INSIDE a pair alternated (HEAD first in pairs 1, 3, …; the candidate first in
   * pairs 2, 4, …), whatever the order of the two values here.
   */
  pairs?: Pair[]
  /** The first look's pairs (autoresearch_run). Never part of a decision: the proposal was selected on them. */
  look_pairs?: Pair[]
  /**
   * Proposed keeps only: the median relative difference of `pairs`, positive = better
   * (0.05 = the candidate was 5 % better than HEAD measured next to it). Null when the
   * candidate failed while being measured.
   */
  gain?: number | null
  /**
   * Proposed keeps only: exact one-sided p-value (Wilcoxon signed-rank on `pairs`) for
   * "the candidate is better". Null in slow mode and when the candidate failed.
   */
  p?: number | null
  /** Simplification proposals: the same test in the other direction ("the candidate is worse"). */
  p_worse?: number | null
  description: string
  asi: Record<string, unknown>
  commit: string | null
  /** The segment's first keep: the unchanged code, measured on a clean tree. */
  baseline?: true
  /** A simplification kept at equal performance (not an improvement; no part of the progress). */
  neutral?: true
  /** Proposed keeps: the candidate's median in the first look. */
  first_metric?: number
  /**
   * What `metric` was measured next to: the median of HEAD's values in `pairs` (proposed
   * keeps) or in `look_pairs` (other experiments).
   */
  vs?: number
  /** E.g. "keep not confirmed: median 0.5% worse over 8 pairs (p = 0.63)". */
  note?: string
  timestamp: string
  // Entries written before v0.2.2 (still read, no longer written):
  /** v0.2.0–v0.2.1: gain / standard error of the keep. */
  confidence?: number | null
  /** v0.2.0–v0.2.1: spread (MAD) of `samples`. */
  noise?: number | null
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

const signedGain = (candidate: number, current: number, direction: Direction) =>
  direction === "lower" ? current - candidate : candidate - current
const relative = (gain: number, base: number) =>
  base !== 0 ? gain / Math.abs(base) : gain === 0 ? 0 : gain > 0 ? Infinity : -Infinity

/** Relative gain of `value` over `reference` in the given direction; positive = better. */
export function relativeGain(value: number, reference: number, direction: Direction): number {
  return relative(signedGain(value, reference, direction), reference)
}

/** One pair's result: how much better the candidate run was than the HEAD run next to it. */
export const pairGain = ([head, candidate]: Pair, direction: Direction) => relativeGain(candidate, head, direction)

/** The median of the pairs' results: the `gain` of a look or of a decision. */
export const medianPairGain = (pairs: Pair[], direction: Direction) => median(pairs.map((p) => pairGain(p, direction)))

const isPairList = (v: unknown): v is Pair[] =>
  Array.isArray(v) && v.length > 0 && v.every((p) => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === "number"))

/**
 * A keep's ratio r = candidate / HEAD, from its own pairs; undefined when it carries no
 * usable number. `gain` is the relative pair difference, positive = better, so for a
 * lower-is-better metric r = 1 - gain (gain IS the reduction) and for a higher-is-better
 * one r = 1 + gain. Keeps written before v0.2.2 have no `gain`: r = `metric` / `vs`.
 */
export function keepRatio(run: Pick<RunEntry, "metric" | "vs" | "gain" | "pairs">, direction: Direction): number | undefined {
  const gain = typeof run.gain === "number" ? run.gain : isPairList(run.pairs) ? medianPairGain(run.pairs, direction) : undefined
  const r =
    gain !== undefined
      ? direction === "lower"
        ? 1 - gain
        : 1 + gain
      : typeof run.metric === "number" && typeof run.vs === "number" && run.vs !== 0
        ? run.metric / run.vs
        : NaN
  return Number.isFinite(r) && r > 0 ? r : undefined
}

/**
 * Where the code stands against the baseline of its segment: the compounded level.
 *
 * Each keep was decided on HEAD/candidate pairs measured back to back, and its ratio
 * r = candidate / HEAD (keepRatio) is the only trustworthy number about it.
 * `current / baseline` is not: the two were measured at different times, and the same code
 * measured 13 % apart within minutes on a busy machine. So level = product of r over the
 * keeps, with the baseline = 1 (docs/design.md, and the same rule as in compaction.ts and
 * the dashboard, so all three show one number). The level is in the metric's own terms:
 * two 10 % reductions give 0.81 ("19 % lower"), two 10 % increases 1.21 ("21 % higher").
 * (Multiplying 1 + gain instead overstated lower-is-better metrics: 21 % for 100 -> 81.)
 *
 * - The baseline isn't a change. A simplification keep (`neutral`) counts as no change: it
 *   was kept for being simpler, and its measured difference is noise that would otherwise
 *   pile up in the product.
 * - Keeps without a usable number are left out and counted in `skipped`.
 */
export function compoundedLevel(
  runs: Pick<RunEntry, "status" | "baseline" | "neutral" | "metric" | "vs" | "gain" | "pairs">[],
  direction: Direction,
) {
  let level = 1
  let keeps = 0
  let skipped = 0
  let simplifications = 0
  for (const run of keptRuns(runs)) {
    if (run.neutral) {
      simplifications++
      continue
    }
    const r = keepRatio(run, direction)
    if (r === undefined) {
      skipped++
      continue
    }
    level *= r
    keeps++
  }
  return { level, keeps, skipped, simplifications }
}

/** "12.4%", "0.04%": one decimal, more only when that would read as zero. Takes a fraction. */
const percentText = (fraction: number) => {
  const pct = Math.abs(fraction) * 100
  return `${pct >= 0.1 ? pct.toFixed(1) : String(Number(pct.toPrecision(2)))}%`
}

/**
 * A relative gain in words. The one way improvements are worded everywhere: "+69.9%" next
 * to "(-69.9%)" for the same result (gain vs change of a lower-is-better metric) confused
 * both the agent and the user. Never a sign, always "better" or "worse".
 * For ONE comparison (a pair, a look, a keep against HEAD): "better" is the reduction of a
 * lower-is-better metric (1 - r) or the increase of a higher-is-better one (r - 1).
 */
export function gainText(rel: number): string {
  if (!Number.isFinite(rel)) return rel > 0 ? "better (from zero)" : "worse (from zero)"
  if (rel === 0) return "no change"
  return `${percentText(rel)} ${rel > 0 ? "better" : "worse"}`
}

/**
 * A compounded level in words, in the metric's own direction: "19.0% lower than the
 * baseline" (level 0.81), "21.0% higher than the baseline" (1.21). A level on the wrong
 * side for the direction (the keeps net out worse) gets "(worse)".
 */
export function levelText(level: number, direction: Direction): string {
  if (Math.abs(level - 1) < 5e-7) return "no change from the baseline"
  const lower = level < 1
  const worse = lower !== (direction === "lower")
  return `${percentText(level - 1)} ${lower ? "lower" : "higher"} than the baseline${worse ? " (worse)" : ""}`
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
  /** compoundedLevel() of the segment: 1 = the baseline, 0.81 = 19 % lower, 1.21 = 21 % higher. */
  level: number
  /** Keeps that went into `level`. */
  gains: number
  /** Kept simplifications: counted in `kept`, no part of `level`. */
  simplifications: number
  /** Keeps left out of `level` because they carry no usable number. */
  skipped: number
  /** The last kept experiment (never the baseline), for "last keep: … (p = …)". */
  lastKeep: RunEntry | undefined
}

/** One summary per segment, oldest first: what `/autoresearch status` shows for the whole session. */
export function segmentSummaries(entries: LogEntry[]): SegmentSummary[] {
  return entries
    .filter((e): e is ConfigEntry => e.type === "config")
    .map((config) => {
      const runs = entries.filter((e): e is RunEntry => e.type === "run" && e.segment === config.segment)
      const { baseline, current } = summarize(runs)
      const { level, keeps, skipped, simplifications } = compoundedLevel(runs, config.direction)
      const kept = keptRuns(runs)
      return { config, runs: runs.length, kept: kept.length, baseline, current, level, gains: keeps, simplifications, skipped, lastKeep: kept.at(-1) }
    })
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

/** "p = 0.004", "p = 0.21", "p < 0.001": the same wording as in compaction.ts. */
export function pText(p: number): string {
  if (p < 0.001) return "p < 0.001"
  return `p = ${p >= 0.1 ? p.toFixed(2) : p.toFixed(3)}`
}

// ── Settings ──────────────────────────────────────────────

export interface Settings {
  /** Most logged runs in total (all segments). */
  maxIterations: number
  /** Pause after this many runs in a row without a (non-baseline) keep. */
  maxNoImprovement: number
  /**
   * Relative gain a keep needs in slow mode (`repeat` 1–2), and the most a simplification
   * may cost in any mode.
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
