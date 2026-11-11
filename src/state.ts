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
  await appendFile(logPath(cwd), JSON.stringify(entry) + "\n")
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

/** Baseline = first run of the segment; best = best kept run (baseline counts as kept). */
export function summarize(runs: RunEntry[], direction: Direction) {
  const baseline = runs[0]?.metric ?? null
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

/**
 * How much bigger the best improvement is than the session's noise floor.
 * ≥ 2.0 → likely real, 1.0–2.0 → marginal, < 1.0 → within noise.
 *
 * `values` is every metric value in the current segment (all statuses, so
 * discarded runs still count towards measuring noise). Returns null when
 * there isn't enough data to say anything.
 */
export function computeConfidence(
  values: number[],
  baseline: number | null,
  best: number | null,
): number | null {
  if (values.length < 3 || baseline === null || best === null) return null
  const gain = Math.abs(best - baseline)
  if (gain === 0) return null

  // MAD (median absolute deviation) is a noise estimate that one outlier run can't skew.
  const center = median(values)
  const mad = median(values.map((v) => Math.abs(v - center)))
  // MAD is 0 when most runs gave the identical number: the noise can't be measured yet,
  // so say nothing rather than report an infinite confidence.
  if (mad === 0) return null

  return gain / mad
}

export { median }
