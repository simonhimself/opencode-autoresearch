// Compaction summary for autoresearch sessions, built from the .auto/ files
// instead of asking the model to summarize the chat.
//
// Why: everything that matters between experiments is already on disk. A model-written
// summary can drop which ideas failed or what the current state is, and then the loop
// starts re-trying dead ends. A summary built from the files can't lose that, and it
// costs no model call.
//
// How it is sized: the summary replaces the conversation, so it has a hard cap. It is
// built to a budget, never cut afterwards: the fixed sections (each bounded on its own)
// come first, then prompt.md and ideas.md within their budgets, then as many runs as
// still fit, newest first. So what gets dropped is always the oldest runs, never the
// newest ones or "Next step".
//
// This file reads .auto/log.jsonl itself and validates every field where it is used
// (old entries lack the newer fields; a hand-edited log can hold anything), so it has
// no dependency on state.ts.

import { readFile } from "node:fs/promises"
import { join } from "node:path"

/** Hard cap for the whole summary, in string length (UTF-16 units). */
export const MAX_SUMMARY_CHARS = 40_000

/** First line of every summary. Also how an earlier summary is recognised among the user messages. */
export const SUMMARY_HEADER = "# Autoresearch compaction summary"
/** Our own auto-continue prompts start with this; they aren't the user's instructions. */
export const PLUGIN_PROMPT_PREFIX = "[autoresearch]"
/** Marks the user's text inside a plugin prompt (`/autoresearch <text>` on resume), so it can be kept. */
export const USER_CONTEXT_LABEL = "Additional context from the user:"

const USER_NOTES_HEADING = "## What the user said in this session"

// Budgets. Every piece of the fixed sections is capped, which is what makes the cap hold:
// fixed sections stay under ~14k, prompt + ideas under ~16.5k, the rest goes to runs.
const MAX_USER_NOTES = 10
const MAX_USER_NOTE_CHARS = 600
const MAX_NAME_CHARS = 200
const MAX_METRIC_NAME_CHARS = 80
const MAX_UNIT_CHARS = 20
const MAX_LIVE_CHARS = 2_000
const MAX_LIVE_LINE_CHARS = 200
const MAX_DESCRIPTION_CHARS = 300
const MAX_NOTE_CHARS = 300
const MAX_ASI_KEY_CHARS = 40
const MAX_ASI_VALUE_CHARS = 200
const MAX_ASI_CHARS = 600
const MAX_RUN_LINE_CHARS = 1_400
/** prompt.md / ideas.md budgets, tried in order; the smaller ones are only a safety net. */
const FILE_BUDGETS: [prompt: number, ideas: number][] = [
  [12_000, 4_000],
  [4_000, 1_000],
  [0, 0],
]

export interface LiveState {
  /** Uncommitted changes in the scope (`git status --short`). */
  workingTree?: string
  /** A measured run that hasn't been logged yet. */
  pendingRun?: string
}

// ── Log reading (local, tolerant) ────────────────────────

interface Config {
  segment: number
  name: string
  metricName: string
  unit: string
  direction: string
  repeat: number | null
}

interface Run {
  segment: number
  run: number | null
  status: string
  metric: number | null
  description: string
  asi: Record<string, unknown>
  confidence: number | null
  baseline: boolean
  neutral: boolean
  note: string
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
const str = (v: unknown): string => (typeof v === "string" ? v : "")
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

async function readLog(cwd: string): Promise<{ configs: Config[]; runs: Run[] }> {
  const raw = await readFile(join(cwd, ".auto", "log.jsonl"), "utf8").catch(() => "")
  const configs: Config[] = []
  const runs: Run[] = []
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    let p: unknown
    try {
      p = JSON.parse(line)
    } catch {
      continue // a torn line from a crash shouldn't break the summary
    }
    if (!isRecord(p)) continue
    const segment = num(p.segment) ?? 1
    if (p.type === "config") {
      configs.push({
        segment,
        name: str(p.name),
        metricName: str(p.metric_name),
        unit: oneLine(str(p.metric_unit), MAX_UNIT_CHARS),
        direction: p.direction === "higher" ? "higher" : "lower",
        repeat: num(p.repeat),
      })
    } else if (p.type === "run") {
      runs.push({
        segment,
        run: num(p.run),
        status: str(p.status) || "unknown",
        metric: num(p.metric),
        description: str(p.description),
        asi: isRecord(p.asi) ? p.asi : {},
        confidence: num(p.confidence),
        baseline: p.baseline === true,
        neutral: p.neutral === true,
        note: str(p.note),
      })
    }
    // Other entry types are ignored.
  }
  return { configs, runs }
}

/** Baseline of a segment: the run marked `baseline`, or (old logs) its first keep. */
function baselineOf(runs: Run[], segment: number): number | null {
  const inSegment = runs.filter((r) => r.segment === segment && r.status === "keep" && r.metric !== null)
  return (inSegment.find((r) => r.baseline) ?? inSegment[0])?.metric ?? null
}

// ── Summary ──────────────────────────────────────────────

export async function buildCompactionSummary(cwd: string, userMessages: string[], live?: LiveState): Promise<string> {
  const { configs, runs } = await readLog(cwd)
  const config = configs.at(-1)
  const segmentRuns = config ? runs.filter((r) => r.segment === config.segment) : []
  const liveText = liveSection(live)

  const before = [
    [
      SUMMARY_HEADER,
      "",
      "Older conversation was replaced by this summary, built from the persisted session files in `.auto/`.",
      "Those files are the source of truth. Continue the experiment loop from here.",
    ].join("\n"),
    sessionSection(config, segmentRuns, runs),
    liveText,
    userSection(userMessages),
    RULES_SECTION,
  ]
  const nextStep = nextStepSection(Boolean(liveText), Boolean(config), segmentRuns.length > 0)

  // With several segments, run numbers repeat; label them s<segment>#<run>.
  // Decided from the whole log (configs too: right after a new init the old runs are the
  // only ones, and that's when their numbers stop being comparable), not from what fits.
  const multi = new Set([...configs, ...runs].map((e) => e.segment)).size > 1
  const baselines = new Map<number, number | null>()
  for (const r of runs) if (!baselines.has(r.segment)) baselines.set(r.segment, baselineOf(runs, r.segment))
  const runLines = runs.map((r) => runLine(r, multi, baselines.get(r.segment) ?? null)).reverse() // newest first

  const promptRaw = await readAutoFile(cwd, "prompt.md")
  const ideasRaw = await readAutoFile(cwd, "ideas.md")

  let summary = ""
  for (const [promptMax, ideasMax] of FILE_BUDGETS) {
    const head = [
      ...before,
      fileSection("Experiment rules", "prompt.md", promptRaw, promptMax),
      fileSection("Ideas backlog", "ideas.md", ideasRaw, ideasMax),
    ].filter(Boolean)
    // Try with as many runs as the budget allows; if the arithmetic were ever off,
    // drop more runs rather than cut the end of the summary.
    const used = join2(head).length + 2 + nextStep.length + 2
    let take = fitRuns(runLines, MAX_SUMMARY_CHARS - used)
    for (;;) {
      summary = join2([...head, runsSection(runLines, take), nextStep])
      if (summary.length <= MAX_SUMMARY_CHARS || take === 0) break
      take--
    }
    // Prefer smaller file budgets over a summary without its newest run.
    if (summary.length <= MAX_SUMMARY_CHARS && (take > 0 || !runLines.length)) return summary
  }
  if (summary.length <= MAX_SUMMARY_CHARS) return summary
  // Not reachable while every fixed piece is capped; kept so the cap holds no matter what.
  return join2([SUMMARY_HEADER, nextStep])
}

const join2 = (sections: string[]) => sections.filter(Boolean).join("\n\n")

function sessionSection(config: Config | undefined, segmentRuns: Run[], allRuns: Run[]): string {
  if (!config) return "## Session\n\nNo `autoresearch_init` yet. Finish setup per `.auto/prompt.md`."
  const unit = config.unit
  const lines = [
    "## Session",
    "",
    `Goal: ${oneLine(config.name, MAX_NAME_CHARS)}`,
    `Metric: ${oneLine(config.metricName, MAX_METRIC_NAME_CHARS)} (${unit || "no unit"}), ${config.direction} is better`,
  ]
  if (config.repeat !== null)
    lines.push(`Repeat: each measurement is the median of ${config.repeat} benchmark run(s), fixed for this segment`)

  const keeps = segmentRuns.filter((r) => r.status === "keep" && r.metric !== null)
  const baseline = baselineOf(segmentRuns, config.segment)
  const current = keeps.at(-1)?.metric ?? null
  if (baseline === null || current === null) {
    lines.push("Baseline: none yet. The first run of a segment is the baseline, measured on a clean tree.")
  } else if (keeps.length === 1) {
    lines.push(`Baseline → current: ${fmt(baseline)}${unit} (the baseline is still current: no other keep yet)`)
  } else {
    lines.push(
      `Baseline → current: ${fmt(baseline)}${unit} → ${fmt(current)}${unit}${delta(current, baseline)}` +
        " (current = the last keep = HEAD; candidates are compared with it)",
    )
  }

  const count = (s: string) => segmentRuns.filter((r) => r.status === s).length
  const known = ["keep", "discard", "crash", "checks_failed"]
  const other = segmentRuns.filter((r) => !known.includes(r.status)).length
  const counts = known.map((s) => `${count(s)} ${s}`).concat(other ? [`${other} other`] : [])
  lines.push(
    `Total runs, all segments (what maxIterations counts): ${allRuns.length}`,
    `Runs in segment ${config.segment}: ${segmentRuns.length} (${counts.join(" · ")})`,
  )
  return lines.join("\n")
}

/** What is in flight right now. Lines are indented so the text can't add headings. */
function liveSection(live: LiveState | undefined): string {
  const block = (text: string | undefined) => {
    const lines = (text ?? "")
      .split(/[\n\u2028\u2029]/)
      .map((l) => l.trimEnd())
      .filter((l) => l.trim())
    if (!lines.length) return ""
    const out: string[] = []
    let used = 0
    for (const l of lines) {
      const line = "    " + truncate(l.replace(/[\r\t]/g, " "), MAX_LIVE_LINE_CHARS)
      if (used + line.length + 1 > MAX_LIVE_CHARS) {
        out.push(`    … (${lines.length - out.length} more lines)`)
        break
      }
      out.push(line)
      used += line.length + 1
    }
    return out.join("\n")
  }
  const tree = block(live?.workingTree)
  const pending = block(live?.pendingRun)
  if (!tree && !pending) return ""
  const parts = ["## Live state (an experiment is in flight)"]
  if (pending) parts.push("A run was measured but not logged yet:\n\n" + pending)
  if (tree) parts.push("Uncommitted changes in the scope (`git status --short`):\n\n" + tree)
  return parts.join("\n\n")
}

/** The user's own words in a message: [] for a plugin prompt, the carried notes for an earlier summary. */
function userNotes(message: string): string[] {
  const m = message.trim()
  // An earlier compaction summary isn't something the user said. But the notes it carried
  // are, and the messages they came from may be gone by now, so take those over.
  if (m.startsWith(SUMMARY_HEADER)) return carriedNotes(m)
  if (!m.startsWith(PLUGIN_PROMPT_PREFIX)) return [m]
  const i = m.indexOf(USER_CONTEXT_LABEL)
  return i === -1 ? [] : [m.slice(i + USER_CONTEXT_LABEL.length)]
}

function carriedNotes(summary: string): string[] {
  const lines = summary.split("\n")
  const start = lines.findIndex((l) => l.startsWith(USER_NOTES_HEADING))
  if (start === -1) return []
  const notes: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("- ")) notes.push(line.slice(2))
    else if (line.trim()) break // the next section
  }
  return notes
}

/** The user's own messages: steering like "focus on X" or "don't touch Y" must survive compaction. */
function userSection(messages: string[]): string {
  const all = messages
    .flatMap(userNotes)
    .map((m) => oneLine(m, MAX_USER_NOTE_CHARS))
    .filter(Boolean)
  // A note can arrive twice (the original message and a summary that carried it): keep the last.
  const notes = all.filter((n, i) => all.lastIndexOf(n) === i).slice(-MAX_USER_NOTES)
  if (!notes.length) return ""
  return [`${USER_NOTES_HEADING} (oldest first; later messages override earlier ones)`, "", ...notes.map((n) => `- ${n}`)].join(
    "\n",
  )
}

const RULES_SECTION = [
  "## Loop rules (enforced by the plugin)",
  "",
  "- Tools: `autoresearch_init`, `autoresearch_run`, `autoresearch_log`, `autoresearch_pause` (in Code Mode: `tools.autoresearch.*`).",
  "- One experiment = edit, `autoresearch_run`, then `autoresearch_log` with `keep`, `discard`, `crash` or `checks_failed`.",
  "- You propose a keep; the plugin decides. It measures again and commits only if the gain is confirmed, otherwise it reverts and logs a discard.",
  "- The benchmark (`.auto/measure.sh`) and the checks (`.auto/checks.sh`) are frozen for the segment. Changing either needs `autoresearch_init`, which starts a new segment with a new baseline.",
  "- Don't game the metric: no special-casing the benchmark's input, no skipping the work it measures, no weakening the checks.",
  "- Out of ideas, blocked, or need the user: call `autoresearch_pause` with the reason. No filler experiments.",
].join("\n")

async function readAutoFile(cwd: string, file: string): Promise<string> {
  return readFile(join(cwd, ".auto", file), "utf8").then(
    (s) => s.trim(),
    () => "",
  )
}

function fileSection(title: string, file: string, content: string, max: number): string {
  if (!content || max <= 0) return ""
  return `## ${title} (.auto/${file})\n\n${headAndTail(content, max, file)}`
}

/** Too long: keep the start and the end (Off Limits / What's Been Tried sit last in prompt.md). */
function headAndTail(content: string, max: number, file: string): string {
  if (content.length <= max) return content
  const marker = `\n\n… (middle left out to save space; read .auto/${file} for the full text) …\n\n`
  const half = Math.max(0, Math.floor((max - marker.length) / 2))
  // Don't cut through a surrogate pair at either edge.
  let headEnd = half
  if (isHigh(content.charCodeAt(headEnd - 1))) headEnd--
  let tailStart = content.length - half
  if (isLow(content.charCodeAt(tailStart))) tailStart++
  return content.slice(0, headEnd).trimEnd() + marker + content.slice(tailStart).trimStart()
}

function runLine(r: Run, multi: boolean, baseline: number | null): string {
  const label = `${multi ? `s${r.segment}` : ""}#${r.run ?? "?"}`
  // A crash's metric is a placeholder, not a measurement.
  const value = r.status === "crash" || r.metric === null ? "—" : fmt(r.metric) + delta(r.metric, baseline)
  const head = [label, oneLine(r.status, 20), value]
  if (r.baseline) head.push("[baseline]")
  if (r.neutral) head.push("[neutral]")
  if (r.confidence !== null) head.push(`conf ${fmt(Number(r.confidence.toFixed(1)))}`)
  const parts = [
    head.join(" "),
    // e.g. a keep the plugin didn't confirm, logged as a discard.
    r.note.trim() ? `note: ${oneLine(r.note, MAX_NOTE_CHARS)}` : "",
    // One line, capped: a description can't add headings or blow up the summary.
    r.description.trim() ? `desc: ${oneLine(r.description, MAX_DESCRIPTION_CHARS)}` : "",
    asiText(r.asi),
  ]
  return truncate(parts.filter(Boolean).join(" | "), MAX_RUN_LINE_CHARS)
}

/** Every short scalar in asi (arrays of scalars joined), as `key: value | key: value`. */
function asiText(asi: Record<string, unknown>): string {
  const scalar = (v: unknown): string => {
    if (typeof v === "string") return v.trim()
    if (typeof v === "number" && Number.isFinite(v)) return String(v)
    if (typeof v === "boolean") return String(v)
    return ""
  }
  const parts: string[] = []
  for (const [key, v] of Object.entries(asi)) {
    const text = Array.isArray(v) ? v.map(scalar).filter(Boolean).join(", ") : scalar(v)
    if (!text) continue
    parts.push(`${oneLine(key, MAX_ASI_KEY_CHARS)}: ${oneLine(text, MAX_ASI_VALUE_CHARS)}`)
  }
  return truncate(parts.join(" | "), MAX_ASI_CHARS)
}

const RUNS_HEADING = "## Runs (newest first; deltas are vs the baseline of the run's segment)"
const runsFooter = (omitted: number) =>
  omitted > 0
    ? `${omitted} older run(s) left out to fit (the oldest were dropped first). All runs are in .auto/log.jsonl.`
    : "Full details are in .auto/log.jsonl."

/** How many of the newest run lines fit in `budget` characters, heading and footer included. */
function fitRuns(lines: string[], budget: number): number {
  // Reserve the longest footer (with the largest possible count).
  let used = RUNS_HEADING.length + 2 + 1 + runsFooter(lines.length).length
  let take = 0
  for (const line of lines) {
    if (used + line.length + 1 > budget) break
    used += line.length + 1
    take++
  }
  return take
}

function runsSection(lines: string[], take: number): string {
  if (!lines.length) return "## Runs\n\nNo runs yet."
  return [RUNS_HEADING, "", ...lines.slice(0, take), "", runsFooter(lines.length - take)].join("\n")
}

function nextStepSection(inFlight: boolean, hasConfig: boolean, hasRuns: boolean): string {
  const body = inFlight
    ? [
        "An experiment is in flight (see \"Live state\" above). Deal with it before anything else:",
        "- A run is pending: log it with `autoresearch_log` (propose `keep`, or `discard` / `crash` / `checks_failed`).",
        "- Uncommitted changes without a pending run: either measure them (`autoresearch_run`, then `autoresearch_log`) or revert the scope to HEAD.",
        "Don't begin a new experiment on top of these changes. Afterwards keep looping until stopped.",
      ]
    : !hasConfig
      ? [
          "Finish setup: write `.auto/prompt.md` and `.auto/measure.sh`, then call `autoresearch_init`,",
          "and measure the baseline on a clean tree (`autoresearch_run`, then `autoresearch_log` with `keep`).",
        ]
      : !hasRuns
        ? [
            "Measure the baseline of this segment on a clean tree: `autoresearch_run`, then `autoresearch_log` with `keep`.",
            "Then start experimenting. Keep looping until stopped.",
          ]
        : [
            "Pick the most promising hypothesis (from the ideas backlog or the notes of the latest runs above)",
            "and run the next experiment. Keep looping until stopped.",
          ]
  return ["## Next step", "", ...body].join("\n")
}

// ── Formatting ───────────────────────────────────────────

// Exact for integers and short decimals; long ones cut to 8 significant digits.
const fmt = (n: number) => (Number.isInteger(n) || String(n).length <= 12 ? String(n) : String(Number(n.toPrecision(8))))

function delta(value: number, baseline: number | null): string {
  if (baseline === null || baseline === 0 || value === baseline) return ""
  const pct = ((value - baseline) / Math.abs(baseline)) * 100
  return ` (${pct > 0 ? "+" : ""}${Math.abs(pct) >= 0.1 ? pct.toFixed(1) : Number(pct.toPrecision(2))}%)`
}

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff

/**
 * Cut to at most n in string length (what the cap counts), without splitting a
 * surrogate pair, so emoji survive whole or not at all.
 */
function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  let end = Math.max(0, n - 1)
  if (isHigh(s.charCodeAt(end - 1))) end--
  return s.slice(0, end) + "…"
}
const oneLine = (s: string, n: number) => truncate(String(s).trim().replace(/\s+/g, " "), n)
