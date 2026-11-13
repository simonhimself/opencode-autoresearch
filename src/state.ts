// Session state for autoresearch. Everything durable lives in `<cwd>/.auto/`,
// so a fresh agent (or a new OpenCode session) can resume from files alone.
// Same layout as pi-autoresearch, so sessions are portable between the two.

import { appendFile, mkdir, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"

export type Direction = "lower" | "higher"
export type RunStatus = "keep" | "discard" | "crash" | "checks_failed"

/** Written by init_experiment. Each one starts a new "segment" of comparable runs. */
export interface ConfigEntry {
  type: "config"
  segment: number
  name: string
  metric_name: string
  metric_unit: string
  direction: Direction
  timestamp: string
}

/** Written by log_experiment, one per experiment. */
export interface RunEntry {
  type: "run"
  segment: number
  run: number
  status: RunStatus
  metric: number
  metrics: Record<string, number>
  description: string
  asi: Record<string, unknown>
  commit: string | null
  confidence: number | null
  /** Spread (MAD) of the primary metric across this run's repeats; null with fewer than 3. */
  noise?: number | null
  /** How many times the benchmark ran for this result (the metric is their median). */
  samples?: number
  timestamp: string
}

export type LogEntry = ConfigEntry | RunEntry

export const autoDir = (cwd: string) => join(cwd, ".auto")
export const logPath = (cwd: string) => join(autoDir(cwd), "log.jsonl")
export const promptPath = (cwd: string) => join(autoDir(cwd), "prompt.md")
export const checksPath = (cwd: string) => join(autoDir(cwd), "checks.sh")

export async function readLog(cwd: string): Promise<LogEntry[]> {
  if (!existsSync(logPath(cwd))) return []
  const raw = await readFile(logPath(cwd), "utf8")
  const entries: LogEntry[] = []
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line)
      // Ignore entry types we don't know (e.g. pi's "hook" entries).
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

/** The active config is the most recent init_experiment; runs before it belong to older segments. */
export function currentSegment(entries: LogEntry[]) {
  const configs = entries.filter((e): e is ConfigEntry => e.type === "config")
  const config = configs.at(-1)
  const runs = config
    ? entries.filter((e): e is RunEntry => e.type === "run" && e.segment === config.segment)
    : []
  return { config, runs }
}

export const isBetter = (a: number, b: number, direction: Direction) =>
  direction === "lower" ? a < b : a > b

/**
 * Baseline = first KEPT run of the segment; best = best kept run (baseline included).
 * Only kept runs count: a crash's metric is a placeholder (often 0), and a crashed first
 * run used to become an unbeatable "best".
 */
export function summarize(runs: Pick<RunEntry, "status" | "metric">[], direction: Direction) {
  const baseline = runs.find((r) => r.status === "keep")?.metric ?? null
  let best: number | null = baseline
  for (const r of runs) {
    if (r.status !== "keep") continue
    if (best === null || isBetter(r.metric, best, direction)) best = r.metric
  }
  return { baseline, best }
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

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** MAD (median absolute deviation): a spread estimate that one outlier can't skew. */
export function mad(values: number[]): number {
  const center = median(values)
  return median(values.map((v) => Math.abs(v - center)))
}

/**
 * How much bigger the best improvement is than the measurement noise.
 * ≥ 2.0 → likely real, 1.0–2.0 → marginal, < 1.0 → within noise.
 *
 * Noise comes only from repeated measurements of the SAME code: each run made with
 * `repeat` ≥ 3 records the spread (MAD) of its samples, and the median of those is used.
 * (The old estimate took the spread of all results in the segment. That includes the
 * improvements themselves, so after two small gains it always said "likely real".)
 *
 * Conservative: the noise of one sample is compared with a difference of medians.
 * Returns null when no run measured its noise, or there's no improvement.
 */
export function computeConfidence(
  runs: Pick<RunEntry, "noise">[],
  baseline: number | null,
  best: number | null,
): number | null {
  if (baseline === null || best === null) return null
  const gain = Math.abs(best - baseline)
  if (gain === 0) return null
  const noises = runs.map((r) => r.noise).filter((n): n is number => typeof n === "number" && n > 0)
  if (!noises.length) return null
  return gain / median(noises)
}

export { median }
