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
//
// Numbers (v0.2.1): machine speed drifts within minutes, so absolute values logged at
// different times are NOT comparable. Progress is therefore the compounded gain of the
// kept runs, each one's candidate against HEAD measured right alongside it (`samples`
// vs `current_samples`), never current / baseline. dashboard.html uses the same rule;
// keep the two in step (see "Paired results" below).

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

// Don't reword: earlier summaries are parsed by this heading (carriedNotes).
const USER_NOTES_HEADING = "## What the user said in this session"
/** What `/autoresearch <goal>` sends on a fresh start (index.ts); the goal is the user's own text. */
const SETUP_GOAL = /Set up and start an autoresearch session\.\s*Goal:([\s\S]*)/

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
/** With many segments only the latest are listed, one line each. */
const MAX_SEGMENT_LINES = 8
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
  /** The candidate's samples (v0.1 stored a count here: then null). */
  samples: number[] | null
  /** HEAD re-measured right around the candidate (v0.2.1 keeps and unconfirmed keeps). */
  currentSamples: number[] | null
  /** What the run was compared with: the median of `currentSamples` (v0.2.0: current's logged metric). */
  vs: number | null
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
const str = (v: unknown): string => (typeof v === "string" ? v : "")
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
/** A non-empty list of finite numbers, or null. */
const numList = (v: unknown): number[] | null => {
  if (!Array.isArray(v)) return null
  const xs = v.filter((x): x is number => num(x) !== null)
  return xs.length ? xs : null
}
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

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
        samples: numList(p.samples),
        currentSamples: numList(p.current_samples),
        vs: num(p.vs),
      })
    }
    // Other entry types are ignored.
  }
  return { configs, runs }
}

// ── Paired results ───────────────────────────────────────
//
// The same rule as in dashboard.html (analyze()):
//   candidate = the run's metric (else the median of its samples)
//   reference = `vs`, else the median of `current_samples`, else (entries from before
//               v0.2) the metric of the keep before it
//   gain      = how much better the candidate is than the reference, as a fraction,
//               positive = better in the segment's direction
//   level     = product of candidate / reference over the segment's keeps, baseline excluded
// A keep whose two values aren't both positive numbers counts as factor 1.

/** Where a run's reference value comes from, best first. */
type RefKind = "paired" | "logged" | "previous"
const REF_LABEL: Record<RefKind, string> = {
  paired: "HEAD alongside",
  logged: "current as logged",
  previous: "the keep before",
}

interface Paired {
  candidate: number
  reference: number
  kind: RefKind
  /** Fraction better than the reference (negative = worse). */
  gain: number
}

interface SegmentStats {
  segment: number
  config: Config | undefined
  runs: Run[]
  baseline: Run | null
  /** The last keep: it describes HEAD. */
  current: Run | null
  /** Keeps without the baseline. */
  kept: number
  /** Product of candidate / reference over those keeps (1 = unchanged). */
  level: number
  /** How many of them had a usable ratio. */
  measured: number
  /** How many of those were measured against HEAD alongside (v0.2.1 entries). */
  alongside: number
}

const usable = (n: number | null): n is number => n !== null && n > 0
const gainOf = (ratio: number, direction: string) => (direction === "higher" ? ratio - 1 : 1 - ratio)
const valueOf = (r: Run): number | null => r.metric ?? (r.samples ? median(r.samples) : null)

/** Segments in log order (a later config for the same id replaces the earlier one), and each run's paired result. */
function analyze(configs: Config[], runs: Run[]): { segments: SegmentStats[]; paired: Map<Run, Paired> } {
  const byId = new Map<number, SegmentStats>()
  const stats = (segment: number) => {
    let s = byId.get(segment)
    if (!s) byId.set(segment, (s = { segment, config: undefined, runs: [], baseline: null, current: null, kept: 0, level: 1, measured: 0, alongside: 0 }))
    return s
  }
  for (const c of configs) {
    byId.delete(c.segment) // re-insert, so the order follows the latest config
    stats(c.segment).config = c
  }
  for (const r of runs) stats(r.segment).runs.push(r)

  const paired = new Map<Run, Paired>()
  for (const s of byId.values()) {
    const direction = s.config?.direction ?? "lower"
    const keeps = s.runs.filter((r) => r.status === "keep" && r.metric !== null)
    // Baseline: the run marked `baseline`, or (old logs) the segment's first keep.
    s.baseline = keeps.find((r) => r.baseline) ?? keeps[0] ?? null
    s.current = keeps.at(-1) ?? null
    let previous: number | null = null // metric of the last keep seen so far
    for (const r of s.runs) {
      const isKeep = r.status === "keep" && r.metric !== null
      if (r !== s.baseline && r.status !== "crash") {
        const candidate = valueOf(r)
        const reference: [number | null, RefKind] = r.currentSamples
          ? [r.vs ?? median(r.currentSamples), "paired"]
          : r.vs !== null
            ? [r.vs, "logged"]
            : [isKeep ? previous : null, "previous"]
        if (usable(candidate) && usable(reference[0])) {
          paired.set(r, { candidate, reference: reference[0], kind: reference[1], gain: gainOf(candidate / reference[0], direction) })
        }
      }
      if (isKeep) {
        if (r !== s.baseline) {
          s.kept++
          const p = paired.get(r)
          if (p) {
            s.level *= p.candidate / p.reference
            s.measured++
            if (p.kind === "paired") s.alongside++
          }
        }
        previous = r.metric
      }
    }
  }
  return { segments: [...byId.values()], paired }
}

/** "12.5 % better" / "3.1 % worse": the same wording everywhere, no signs to misread. */
function betterWorse(gain: number): string {
  const pct = Math.abs(gain) * 100
  if (pct < 0.00005) return "no change"
  return `${pct >= 0.1 ? pct.toFixed(1) : Number(pct.toPrecision(2))} % ${gain > 0 ? "better" : "worse"}`
}

/** A segment's progress in words. */
function improvement(s: SegmentStats): string {
  if (!s.kept) return "no kept change yet"
  if (!s.measured) return "not known (the kept runs carry no comparison)"
  return betterWorse(gainOf(s.level, s.config?.direction ?? "lower"))
}

// ── Summary ──────────────────────────────────────────────

export async function buildCompactionSummary(cwd: string, userMessages: string[], live?: LiveState): Promise<string> {
  const { configs, runs } = await readLog(cwd)
  const { segments, paired } = analyze(configs, runs)
  const config = configs.at(-1)
  const segment = config ? segments.find((s) => s.segment === config.segment) : undefined
  const segmentRuns = segment?.runs ?? []
  const liveText = liveSection(live)

  const before = [
    [
      SUMMARY_HEADER,
      "",
      "Older conversation was replaced by this summary, built from the persisted session files in `.auto/`.",
      "Those files are the source of truth. Continue the experiment loop from here.",
    ].join("\n"),
    sessionSection(segment, segments, runs.length),
    liveText,
    userSection(userMessages),
    RULES_SECTION,
  ]
  const nextStep = nextStepSection(Boolean(liveText), Boolean(config), segmentRuns.length > 0)

  // With several segments, run numbers repeat; label them s<segment>#<run>.
  // Decided from the whole log (configs too: right after a new init the old runs are the
  // only ones, and that's when their numbers stop being comparable), not from what fits.
  const multi = segments.length > 1
  const runLines = runs.map((r) => runLine(r, multi, paired.get(r))).reverse() // newest first

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

function sessionSection(segment: SegmentStats | undefined, segments: SegmentStats[], totalRuns: number): string {
  const config = segment?.config
  if (!segment || !config) return "## Session\n\nNo `autoresearch_init` yet. Finish setup per `.auto/prompt.md`."
  const unit = config.unit
  const lines = [
    "## Session",
    "",
    `Goal: ${oneLine(config.name, MAX_NAME_CHARS)}`,
    `Metric: ${oneLine(config.metricName, MAX_METRIC_NAME_CHARS)} (${unit || "no unit"}), ${config.direction} is better`,
  ]
  if (config.repeat !== null)
    lines.push(`Repeat: each measurement is the median of ${config.repeat} benchmark run(s), fixed for this segment`)

  const { baseline, current } = segment
  const at = (r: Run) => `${fmt(r.metric!)}${unit} (run #${r.run ?? "?"})`
  if (!baseline || !current) {
    lines.push("Baseline: none yet. The first run of a segment is the baseline, measured on a clean tree.")
  } else {
    lines.push(
      !segment.kept
        ? "Improvement: none yet (no kept change since the baseline)."
        : !segment.measured
          ? `Improvement: ${improvement(segment)}.`
          : `Improvement: ${improvement(segment)} than the baseline. This is the compounded gain of the ${segment.kept} kept change(s), ` +
            (segment.alongside === segment.measured
              ? "each measured against HEAD right alongside it."
              : "each against its own reference (HEAD measured alongside it; older entries: the value logged before it)."),
      current === baseline
        ? `Baseline: ${at(baseline)}, still current = HEAD. As measured at the time.`
        : `Baseline: ${at(baseline)} · current (the last keep = HEAD): ${at(current)}. Each as measured at the time.`,
      "Values measured at different times aren't comparable (machine speed drifts), so don't compute progress from them.",
    )
  }

  const count = (s: string) => segment.runs.filter((r) => r.status === s).length
  const known = ["keep", "discard", "crash", "checks_failed"]
  const other = segment.runs.filter((r) => !known.includes(r.status)).length
  const counts = [`${segment.kept} kept, the baseline not counted`]
    .concat(known.slice(1).map((s) => `${count(s)} ${s}`))
    .concat(other ? [`${other} other`] : [])
  lines.push(
    `Runs in segment ${config.segment}: ${segment.runs.length} (${counts.join(" · ")})`,
    `Total runs, all segments (what maxIterations counts): ${totalRuns}`,
  )

  if (segments.length > 1) {
    const shown = segments.slice(-MAX_SEGMENT_LINES)
    lines.push("", "Segments (each has its own benchmark and baseline; numbers of different segments aren't comparable):")
    if (shown.length < segments.length) lines.push(`- ${segments.length - shown.length} earlier segment(s) not listed`)
    for (const s of shown) {
      const name = s.config ? oneLine(s.config.name, 80) : "no config entry"
      lines.push(
        `- segment ${s.segment}${s === segment ? " (current)" : ""}: ${name} · ${s.runs.length} run(s) · ${s.kept} kept · ${improvement(s)}`,
      )
    }
  }
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

/**
 * Remove attached skills. With a skill attached, a user message arrives as
 * `<skill_content name="…">…</skill_content>` followed by the real text; left in, the
 * skill's text was listed as the user's note and pushed the real notes out.
 *
 * A block without its end tag (text cut somewhere) has no known end: then only text that
 * certainly isn't the skill's is kept, i.e. from the plugin prefix or the setup sentence
 * on; without either, everything from the tag on is dropped.
 */
function stripSkillBlocks(text: string): string {
  const t = text.replace(/<skill_content\b[^>]*>[\s\S]*?<\/skill_content\s*>/gi, "\n")
  const open = t.search(/<skill_content\b/i)
  if (open === -1) return t
  const rest = t.slice(open)
  const marks = [rest.indexOf(PLUGIN_PROMPT_PREFIX), rest.search(SETUP_GOAL)].filter((i) => i !== -1)
  return t.slice(0, open) + (marks.length ? "\n" + rest.slice(Math.min(...marks)) : "")
}

/** The user's own words in a message: nothing for a plain plugin prompt, the carried notes for an earlier summary. */
function userNotes(message: string): string[] {
  // An earlier compaction summary isn't something the user said. But the notes it carried
  // are, and the messages they came from may be gone by now, so take those over.
  // (Checked before and after stripping: a summary can quote a skill tag in its own text.)
  if (message.trim().startsWith(SUMMARY_HEADER)) return carriedNotes(message.trim())
  const m = stripSkillBlocks(message).trim()
  if (m.startsWith(SUMMARY_HEADER)) return carriedNotes(m)

  const notes: string[] = []
  // Our own prompts can sit anywhere (after a skill block, after other text). What comes
  // before the prefix isn't ours, so it stays; of the prompt itself only the text the
  // user gave with `/autoresearch <text>` is theirs.
  const prefix = m.indexOf(PLUGIN_PROMPT_PREFIX)
  const own = prefix === -1 ? m : m.slice(0, prefix)
  const goal = SETUP_GOAL.exec(own)
  if (goal) {
    notes.push(own.slice(0, goal.index))
    // "(ask me)" is what the plugin fills in when the user gave no goal.
    const text = goal[1]!.trim()
    if (text && text !== "(ask me)") notes.push(`Goal given at the start: ${text}`)
  } else {
    notes.push(own)
  }
  if (prefix !== -1) {
    const label = m.indexOf(USER_CONTEXT_LABEL, prefix)
    if (label !== -1) notes.push(m.slice(label + USER_CONTEXT_LABEL.length))
  }
  return notes
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
  // Summaries written before v0.2.1 could carry an attached skill's text as a note
  // (cut short, so without its end tag): don't carry that on forever.
  return notes.map(stripSkillBlocks)
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
  "- You propose a keep; the plugin decides. It re-measures HEAD and your candidate back to back and commits only if the gain is confirmed against that fresh HEAD measurement; otherwise it reverts and logs a discard.",
  "- `simplification: true` is only for a change that removes more lines than it adds; it is kept when it isn't worse than HEAD.",
  "- Every file under `.auto/` except `log.jsonl`, `ideas.md`, `config.json` and `prompt.md` is frozen for the segment (`measure.sh`, `checks.sh` and whatever they read). Changing one needs a commit and `autoresearch_init`, which starts a new segment with a new baseline.",
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

function runLine(r: Run, multi: boolean, paired: Paired | undefined): string {
  const label = `${multi ? `s${r.segment}` : ""}#${r.run ?? "?"}`
  // A crash's metric is a placeholder, not a measurement.
  const value = r.status === "crash" || r.metric === null ? "—" : fmt(r.metric)
  const head = [label, oneLine(r.status, 20), value]
  // A keep the plugin re-measured and didn't confirm is logged as a discard with a note.
  const unconfirmed = r.status === "discard" && Boolean(r.note.trim()) && paired?.kind === "paired"
  // Only a result measured against a reference gets a comparison. A rejected run's single
  // measurement is shown bare: set against a baseline from another time it misleads.
  if (paired && (r.status === "keep" || unconfirmed)) {
    head.push(`vs ${REF_LABEL[paired.kind]} ${fmt(paired.reference)}: ${betterWorse(paired.gain)}`)
    if (r.confidence !== null) head[head.length - 1] += `, conf ${fmt(Number(r.confidence.toFixed(1)))}`
  } else if (r.status === "keep" && r.confidence !== null) {
    head.push(`conf ${fmt(Number(r.confidence.toFixed(1)))}`)
  }
  if (r.baseline) head.push("[baseline]")
  if (r.neutral) head.push("[neutral]")
  if (unconfirmed) head.push("[keep not confirmed]")
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

const RUNS_HEADING =
  "## Runs (newest first; a keep shows candidate vs HEAD measured alongside it; other values are single measurements, not comparable over time)"
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
