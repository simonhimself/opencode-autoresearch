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
  return sections.filter(Boolean).join("\n\n")
}

function sessionSection(config: ReturnType<typeof currentSegment>["config"], runs: RunEntry[]): string {
  if (!config) return "## Session\n\nNo `init_experiment` yet. Finish setup per `.auto/prompt.md`."
  const { baseline, best } = summarize(runs, config.direction)
  const count = (s: RunEntry["status"]) => runs.filter((r) => r.status === s).length
  const lines = [
    "## Session",
    "",
    `Goal: ${config.name}`,
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
  const lines = notes.map((m) => `- ${truncate(m.replace(/\s+/g, " "), MAX_USER_NOTE_CHARS)}`)
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
      r.description ? `desc: ${r.description}` : "",
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
    out.push(`${label}: ${truncate(v.trim().replace(/\s+/g, " "), 200)}`)
  }
  return out
}

// Up to 5 significant digits, without trailing zeros.
const fmt = (n: number) => String(Number(n.toPrecision(5)))

function delta(value: number, baseline: number | null): string {
  if (baseline === null || baseline === 0 || value === baseline) return ""
  const pct = ((value - baseline) / Math.abs(baseline)) * 100
  return ` (${pct > 0 ? "+" : ""}${pct.toFixed(1)}%)`
}

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s)
