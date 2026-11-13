// Compaction summary for autoresearch sessions, built from the .auto/ files
// instead of asking the model to summarize the chat. (Same idea as pi-autoresearch.)
//
// Why: everything that matters between experiments is already on disk. A model-written
// summary can drop which ideas failed or what the current best is, and then the loop
// starts re-trying dead ends. A summary built from the files can't lose that, and it
// costs no model call.
//
// OpenCode v2 also keeps ~15k tokens of the most recent conversation next to the
// summary (compaction.keep.tokens), so the latest turns survive either way.

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { autoDir, currentSegment, readLog, summarize, type RunEntry } from "./state.ts"

const RECENT_RUNS = 50
const MAX_PROMPT_CHARS = 12_000
const MAX_IDEAS_CHARS = 4_000
const MAX_USER_NOTES = 10
const MAX_USER_NOTE_CHARS = 600
const MAX_DESCRIPTION_CHARS = 300
const MAX_NAME_CHARS = 200
/** Hard cap for the whole summary (it replaces the conversation, so it must stay small). */
const MAX_SUMMARY_CHARS = 40_000

/** asi keys worth carrying forward, in display order, with short labels. */
const ASI_FIELDS: [key: string, label: string][] = [
  ["hypothesis", "hyp"],
  ["learned", "learned"],
  ["next_focus", "next"],
  ["next_action_hint", "next"],
  ["rollback_reason", "rollback"],
]

/** Our own auto-continue prompts start with this; they aren't the user's instructions. */
export const PLUGIN_PROMPT_PREFIX = "[autoresearch]"
/** Marks the user's text inside a plugin prompt (`/autoresearch <text>` on resume), so it can be kept. */
export const USER_CONTEXT_LABEL = "Additional context from the user:"

/** The user's own words in a message, or "" if it's purely one of the plugin's prompts. */
function userText(message: string): string {
  const m = message.trim()
  if (!m.startsWith(PLUGIN_PROMPT_PREFIX)) return m
  const i = m.indexOf(USER_CONTEXT_LABEL)
  return i === -1 ? "" : m.slice(i + USER_CONTEXT_LABEL.length).trim()
}

export async function buildCompactionSummary(cwd: string, userMessages: string[]): Promise<string> {
  const entries = await readLog(cwd)
  const { config, runs } = currentSegment(entries)
  const allRuns = entries.filter((e): e is RunEntry => e.type === "run")

  const sections = [
    [
      "# Autoresearch compaction summary",
      "",
      "Older conversation was replaced by this summary, built from the persisted session files in `.auto/`.",
      "Those files are the source of truth. Continue the experiment loop from here.",
    ].join("\n"),
    sessionSection(config, runs),
    userSection(userMessages),
    await fileSection("Experiment rules", "prompt.md", cwd, MAX_PROMPT_CHARS),
    await fileSection("Ideas backlog", "ideas.md", cwd, MAX_IDEAS_CHARS),
    recentRunsSection(allRuns),
    [
      "## Next step",
      "",
      "Pick the most promising hypothesis (from the ideas backlog or the latest `next:` hints above)",
      "and run the next experiment. Keep looping until stopped.",
    ].join("\n"),
  ]
  const summary = sections.filter(Boolean).join("\n\n")
  return summary.length > MAX_SUMMARY_CHARS
    ? truncate(summary, MAX_SUMMARY_CHARS) + "\n\n(Summary cut to size; .auto/ has the full details.)"
    : summary
}

function sessionSection(config: ReturnType<typeof currentSegment>["config"], runs: RunEntry[]): string {
  if (!config) return "## Session\n\nNo `autoresearch_init` yet. Finish setup per `.auto/prompt.md`."
  const { baseline, best } = summarize(runs, config.direction)
  const count = (s: RunEntry["status"]) => runs.filter((r) => r.status === s).length
  const lines = [
    "## Session",
    "",
    `Goal: ${oneLine(config.name, MAX_NAME_CHARS)}`,
    `Metric: ${config.metric_name} (${config.metric_unit || "no unit"}), ${config.direction} is better`,
    `Runs so far: ${runs.length} (${count("keep")} keep · ${count("discard")} discard · ${count("crash")} crash · ${count("checks_failed")} checks_failed)`,
  ]
  if (baseline !== null) lines.push(`Baseline: ${fmt(baseline)}${config.metric_unit}`)
  if (best !== null && best !== baseline) lines.push(`Best: ${fmt(best)}${config.metric_unit}${delta(best, baseline)}`)
  return lines.join("\n")
}

/** The user's own messages: steering like "focus on X" or "don't touch Y" must survive compaction. */
function userSection(messages: string[]): string {
  const notes = messages.map(userText).filter(Boolean).slice(-MAX_USER_NOTES)
  if (!notes.length) return ""
  const lines = notes.map((m) => `- ${oneLine(m, MAX_USER_NOTE_CHARS)}`)
  return [
    "## What the user said in this session (oldest first; later messages override earlier ones)",
    "",
    ...lines,
  ].join("\n")
}

async function fileSection(title: string, file: string, cwd: string, max: number): Promise<string> {
  const content = await readFile(join(autoDir(cwd), file), "utf8").then(
    (s) => s.trim(),
    () => "",
  )
  if (!content) return ""
  const body =
    content.length > max ? `${content.slice(0, max)}\n\n… (truncated; read .auto/${file} for the rest)` : content
  return `## ${title} (.auto/${file})\n\n${body}`
}

function recentRunsSection(allRuns: RunEntry[]): string {
  if (!allRuns.length) return "## Recent runs\n\nNo runs yet. Start with the baseline."
  const recent = allRuns.slice(-RECENT_RUNS)
  const baselineOf = (segment: number) =>
    allRuns.find((r) => r.segment === segment && r.status === "keep")?.metric ?? null
  const lines = recent.map((r) => {
    const parts = [
      `#${r.run} ${r.status.padEnd("checks_failed".length)} ${r.status === "crash" ? "—" : fmt(r.metric) + delta(r.metric, baselineOf(r.segment))}`,
      // One line, capped: a description can't add headings or blow up the summary.
      r.description ? `desc: ${oneLine(r.description, MAX_DESCRIPTION_CHARS)}` : "",
      ...asiParts(r.asi),
    ]
    return parts.filter(Boolean).join(" | ")
  })
  return [
    `## Recent runs (last ${recent.length})`,
    "",
    ...lines,
    "",
    "Older runs and full notes are in .auto/log.jsonl.",
  ].join("\n")
}

function asiParts(asi: Record<string, unknown> | undefined): string[] {
  if (!asi) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const [key, label] of ASI_FIELDS) {
    const v = asi[key]
    if (typeof v !== "string" || !v.trim() || seen.has(label)) continue
    seen.add(label)
    out.push(`${label}: ${oneLine(v, 200)}`)
  }
  return out
}

// Exact for integers and short decimals; long ones cut to 8 significant digits.
const fmt = (n: number) => (Number.isInteger(n) || String(n).length <= 12 ? String(n) : String(Number(n.toPrecision(8))))

function delta(value: number, baseline: number | null): string {
  if (baseline === null || baseline === 0 || value === baseline) return ""
  const pct = ((value - baseline) / Math.abs(baseline)) * 100
  return ` (${pct > 0 ? "+" : ""}${pct.toFixed(1)}%)`
}

/** Cut to n characters by code point, so emoji and other surrogate pairs aren't split. */
function truncate(s: string, n: number): string {
  const chars = Array.from(s)
  return chars.length > n ? chars.slice(0, n - 1).join("") + "…" : s
}
const oneLine = (s: string, n: number) => truncate(String(s).trim().replace(/\s+/g, " "), n)
