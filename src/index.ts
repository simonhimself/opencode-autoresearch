// opencode-autoresearch: try an idea, measure it, keep what works, revert what
// doesn't, repeat. A minimal OpenCode v2 port of pi-autoresearch
// (https://github.com/davebcn87/pi-autoresearch).
//
// Split of responsibilities (same as the pi original):
//   - this plugin  = domain-agnostic machinery (run, time, log, commit/revert, keep looping)
//   - the skill    = how to set up a session for a specific goal
//   - .auto/ files = the durable state, so any fresh agent can resume

import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin, Skill } from "@opencode/plugin"
import { buildCompactionSummary, PLUGIN_PROMPT_PREFIX, USER_CONTEXT_LABEL } from "./compaction.ts"
import { Dashboards, logExists, openInBrowser } from "./dashboard.ts"
import { bash, commitKeep, revertToHead, type ShellResult } from "./shell.ts"
import {
  appendLog,
  checksPath,
  computeConfidence,
  currentSegment,
  isBetter,
  mad,
  median,
  parseMetrics,
  promptPath,
  readLog,
  summarize,
  type Direction,
  type RunStatus,
} from "./state.ts"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SKILL_ID = "autoresearch-create"
const FINALIZE_SKILL_ID = "autoresearch-finalize"
const OUTPUT_TAIL_LINES = 80

const tail = (text: string, n = OUTPUT_TAIL_LINES) => text.trimEnd().split("\n").slice(-n).join("\n")

/**
 * Numbers as measured: exact for integers and short decimals, so what the tools show is what
 * autoresearch_log accepts. Long decimals are cut to 8 significant digits, trailing zeros dropped.
 */
const fmt = (n: number | null | undefined) =>
  n === null || n === undefined
    ? "–"
    : Number.isInteger(n) || String(n).length <= 12
      ? String(n)
      : String(Number(n.toPrecision(8)))

/** A percentage with enough digits that a tiny change doesn't read as "-0.0%". */
const pctText = (pct: number) =>
  `${pct > 0 ? "+" : ""}${Math.abs(pct) >= 0.1 ? pct.toFixed(1) : Number(pct.toPrecision(2))}%`

/** The parts of a tool call's context the permission check needs. */
type ToolCtx = { sessionID: string; agent: string; messageID: string; id: string }

/** Run tasks for the same key one after another (e.g. logging runs in one project). */
const locks = new Map<string, Promise<unknown>>()
function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const next = (locks.get(key) ?? Promise.resolve()).then(task, task)
  locks.set(key, next.catch(() => {}))
  return next
}

// ── Per-session runtime state ─────────────────────────────

/** Persisted in plugin storage under `active/<sessionID>` while the loop is on. */
interface ActiveState {
  directory: string
  /**
   * True when the loop was started without .auto/prompt.md: the agent is setting up and may
   * be waiting for the user's answers, so no nudges until the first experiment is logged.
   */
  setup?: boolean
  /** Number of logged runs when the loop was turned on. */
  startRunCount: number
  /** Number of logged runs when we last auto-continued; detects a stalled agent. */
  lastRunCount: number
  /** Consecutive auto-continues with no new logged run. */
  stalls: number
}

/**
 * Persisted under `run/<sessionID>` by autoresearch_run and consumed by autoresearch_log, so each
 * logged result is tied to an actual measurement (and survives a plugin reload in between).
 */
interface PendingRun {
  exitCode: number | null
  timedOut: boolean
  checksFailed: boolean
  /** Measured value of the primary metric (median with repeat > 1); undefined if missing or failed. */
  primary?: number
  /** Spread (MAD) of the primary metric across repeats; null with fewer than 3 samples. */
  noise?: number | null
  samples?: number
}

const MAX_STALLS = 3

/**
 * Settings from .auto/config.json. `maxIterations` is the most runs in the whole log (all
 * segments), also as a numeric string; null = no limit. Problems come back as a warning
 * instead of silently meaning "no limit".
 */
async function readConfig(cwd: string): Promise<{ max: number | null; warning?: string }> {
  const file = join(cwd, ".auto", "config.json")
  if (!existsSync(file)) return { max: null }
  let raw: any
  try {
    raw = JSON.parse(await readFile(file, "utf8"))
  } catch {
    return { max: null, warning: ".auto/config.json isn't valid JSON, so maxIterations is ignored (no limit)." }
  }
  if (raw?.maxIterations === undefined || raw.maxIterations === null) return { max: null }
  const n = Number(raw.maxIterations)
  if (!Number.isFinite(n) || n < 1) {
    return { max: null, warning: `maxIterations must be a number ≥ 1 (got ${JSON.stringify(raw.maxIterations)}); ignored, so there's no limit.` }
  }
  return { max: Math.floor(n) }
}

const HELP_TEXT = [
  "[autoresearch] Commands:",
  "  /autoresearch <goal>          start a session (or resume it if .auto/prompt.md exists)",
  "  /autoresearch status          is the loop on? runs so far, best result, dashboard link",
  "  /autoresearch off             stop the loop; the log is kept (also: stop, pause)",
  "  /autoresearch dashboard       open the live results page in your browser",
  "  /autoresearch dashboard off   close the dashboard's local web server",
  "  /autoresearch finalize        stop the loop and split kept experiments into reviewable branches",
  "  /autoresearch help            this list",
].join("\n")

const OFF_WORDS = new Set(["off", "stop", "pause", "end", "quit", "cancel", "exit"])

const INSTRUCTION_KEY = "autoresearch"
const ACTIVE_INSTRUCTION = [
  "Autoresearch mode is ON in this session: you are running an autonomous experiment loop.",
  "Use autoresearch_init, autoresearch_run and autoresearch_log (in Code Mode:",
  "tools.autoresearch.init / .run / .log). Session state lives in .auto/:",
  "prompt.md (goal and rules), log.jsonl (every run), ideas.md (backlog).",
  "Don't ask whether to continue; keep running experiments until the user stops the loop.",
  "If a tool fails with \"Permission denied\", a permission rule in opencode.json blocks that",
  "command: tell the user which command, and stop instead of retrying.",
].join(" ")

// Must start with PLUGIN_PROMPT_PREFIX so the compaction summary can tell it apart from the user's messages.
const CONTINUE_PROMPT = [
  `${PLUGIN_PROMPT_PREFIX} Continue the experiment loop. The loop is ON now; earlier`,
  "[autoresearch] notices saying it was stopped, paused or off are out of date.",
  "If you've lost context, re-read .auto/prompt.md, the last ~20 lines of .auto/log.jsonl,",
  ".auto/ideas.md (if present) and `git log --oneline -20` first. Then run the next experiment.",
].join(" ")

// ── Plugin ────────────────────────────────────────────────

export default Plugin.define({
  id: "autoresearch",
  async setup(ctx) {
    const cwdOf = async (sessionID: string) => {
      const session = await ctx.session.get({ sessionID: sessionID as never })
      return session.location.directory as string
    }
    const activeKey = (sessionID: string) => `active/${sessionID}`
    const runKey = (sessionID: string) => `run/${sessionID}`

    // OpenCode runs one copy of this plugin per project (location). Every copy receives every
    // session's events, and plugin storage is shared between them (both verified live). So each
    // copy only acts on loops started in its own project; otherwise, with several projects
    // open, each turn would get one "continue" prompt per project.
    const ownsSession = (state: ActiveState) => state.directory === ctx.location.directory

    // Loop on/off. Besides the storage flag, "on" pins a short note into the session's
    // instructions. Instructions aren't part of the conversation, so compaction can't
    // drop it: the agent always knows it's in autoresearch mode and where its state lives.
    // (Instruction entries are an experimental OpenCode API, so failures are only logged.)
    const activate = async (sessionID: string, state: ActiveState) => {
      await ctx.storage.set(activeKey(sessionID), state as never)
      await ctx.session.instructions.entry
        .put({ sessionID: sessionID as never, key: INSTRUCTION_KEY as never, value: ACTIVE_INSTRUCTION })
        .catch((err) => console.error("[autoresearch] couldn't pin instructions:", err))
    }
    const deactivate = async (sessionID: string) => {
      await ctx.storage.remove(activeKey(sessionID))
      await ctx.session.instructions.entry
        .remove({ sessionID: sessionID as never, key: INSTRUCTION_KEY as never })
        .catch(() => {}) // fine if it was never pinned
    }

    /**
     * Two ways to post a notice (both are session input that the model also sees):
     * - notify: loop-state changes (stopped, paused, taken over…). resume: false, so no model
     *   turn is spent; it's delivered with the next turn. Because it can arrive late, the
     *   continue prompt says that older "loop off" notices are out of date.
     * - tell: the answer to a command the user just typed (status, help…). It must show up
     *   now, so it starts a turn; the model only needs to acknowledge it.
     */
    const notify = (sessionID: string, text: string) =>
      ctx.session
        .synthetic({ sessionID: sessionID as never, text: `${PLUGIN_PROMPT_PREFIX} ${text}`, resume: false })
        .catch((err) => console.error("[autoresearch] notice failed:", err))
    const tell = (sessionID: string, text: string, delivery?: "steer" | "queue") =>
      ctx.session
        .synthetic({
          sessionID: sessionID as never,
          text: `${PLUGIN_PROMPT_PREFIX} ${text}\n\n(Shown to the user. No action needed; at most acknowledge it in one line.)`,
          delivery,
        })
        .catch((err) => console.error("[autoresearch] notice failed:", err))

    /** Other sessions with a loop on in this project. Only one loop per project is allowed. */
    const otherLoopsHere = async (sessionID: string, directory: string) => {
      const found: string[] = []
      let after: string | undefined
      do {
        const page = await ctx.storage.scan({ prefix: "active/", after, limit: 100 })
        for (const { key, value } of page.entries) {
          const sid = key.slice("active/".length)
          if (sid !== sessionID && (value as unknown as ActiveState)?.directory === directory) found.push(sid)
        }
        after = page.next
      } while (after)
      return found
    }

    const dashboards = new Dashboards(join(ROOT, "src", "dashboard.html"))

    // ── Skills ─────────────────────────────────────────────
    // Every skills/<id>/SKILL.md is registered. Files are read before the
    // (synchronous) transform, as the docs require. `<SKILL_DIR>` in a skill is
    // replaced with its absolute folder, so it can point at bundled scripts.
    const skillsRoot = join(ROOT, "skills")
    const skills = await Promise.all(
      (await readdir(skillsRoot, { withFileTypes: true }))
        .filter((d) => d.isDirectory() && existsSync(join(skillsRoot, d.name, "SKILL.md")))
        .map(async (d) => {
          const dir = join(skillsRoot, d.name)
          const file = join(dir, "SKILL.md")
          const raw = await readFile(file, "utf8")
          const fm = raw.match(/^---\n([\s\S]*?)\n---\n/)
          return {
            id: d.name,
            file,
            description: fm?.[1].match(/^description:\s*(.+)$/m)?.[1].trim(),
            content: (fm ? raw.slice(fm[0].length) : raw).replaceAll("<SKILL_DIR>", dir),
          }
        }),
    )

    await ctx.skill.transform((editor) => {
      for (const s of skills) {
        editor.add({
          id: Skill.ID.make(s.id),
          name: Skill.Name.make(s.id),
          description: s.description,
          path: Skill.Info.fields.path.make(s.file),
          content: s.content,
        })
      }
    })

    // ── Tools ──────────────────────────────────────────────
    // Namespaced (autoresearch_init / _run / _log), as the plugin docs recommend, so they
    // can't collide with another plugin's tools. Commands and git changes are checked with
    // OpenCode's permission system first ("plugin tools enforce the permissions they assert").
    const assertShell = (context: ToolCtx, commands: string[]) =>
      ctx.permission.assert({
        sessionID: context.sessionID as never,
        agent: context.agent as never,
        source: { type: "tool", messageID: context.messageID, id: context.id },
        action: "shell",
        resources: commands,
        save: commands,
      })

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "autoresearch",
        description: "Autonomous experiment loop: set up a session, run the benchmark, log and keep/revert results.",
      })

      editor.add({
        name: "init",
        options: { namespace: "autoresearch" },
        description:
          "Start (or restart) an autoresearch session: name, primary metric, unit and direction. " +
          "Call again when the goal or the way of measuring changes; this starts a new segment with a fresh baseline.",
        input: {
          type: "object",
          properties: {
            name: { type: "string", description: "Short session name, e.g. 'unit test runtime'" },
            metric_name: { type: "string", description: "Primary metric name as printed by measure.sh (METRIC <name>=...)" },
            metric_unit: { type: "string", description: "Unit, e.g. 's', 'ms', 'KB'" },
            direction: { type: "string", enum: ["lower", "higher"], description: "Which direction is better" },
          },
          required: ["name", "metric_name", "direction"],
          additionalProperties: false,
        },
        async execute(input, { sessionID }) {
          const { name, metric_name, metric_unit = "", direction } = input as {
            name: string
            metric_name: string
            metric_unit?: string
            direction: Direction
          }
          const cwd = await cwdOf(sessionID)
          const entries = await readLog(cwd)
          const { config } = currentSegment(entries)
          const segment = (config?.segment ?? 0) + 1
          await appendLog(cwd, {
            type: "config",
            segment,
            name,
            metric_name,
            metric_unit,
            direction,
            timestamp: new Date().toISOString(),
          })
          const { max } = await readConfig(cwd)
          const total = entries.filter((e) => e.type === "run").length
          return {
            content:
              `Initialized "${name}" (segment ${segment}): ${metric_name} in ${metric_unit || "units"}, ${direction} is better.\n` +
              (max !== null
                ? `Runs used so far: ${total}/${max} (maxIterations counts all runs, across segments).\n`
                : "") +
              `Next: autoresearch_run for the baseline, then autoresearch_log with status "keep".`,
          }
        },
      })

      editor.add({
        name: "run",
        options: { namespace: "autoresearch" },
        description:
          "Run the benchmark (default ./.auto/measure.sh) and parse `METRIC name=value` lines. With repeat ≥ 3 it runs " +
          "that many times, uses the median and measures the noise (needed for the confidence score). If " +
          ".auto/checks.sh exists and the benchmark passed, runs it too. Doesn't log; call autoresearch_log next.",
        input: {
          type: "object",
          properties: {
            command: { type: "string", description: "Command to run. Default: ./.auto/measure.sh" },
            repeat: {
              type: "integer",
              minimum: 1,
              maximum: 50,
              description: "Times to run the benchmark (default 1). Use 3–7 for benchmarks under ~10 s.",
            },
            timeout_seconds: { type: "number", description: "Timeout per benchmark run (default 600)" },
            checks_timeout_seconds: { type: "number", description: "checks.sh timeout (default 300)" },
          },
          additionalProperties: false,
        },
        async execute(input, context) {
          const { sessionID, signal, progress } = context
          const {
            command = "./.auto/measure.sh",
            repeat: rawRepeat = 1,
            timeout_seconds = 600,
            checks_timeout_seconds = 300,
          } = input as { command?: string; repeat?: number; timeout_seconds?: number; checks_timeout_seconds?: number }
          const repeat = Math.min(50, Math.max(1, Math.floor(Number(rawRepeat)) || 1))
          const cwd = await cwdOf(sessionID)
          const entries = await readLog(cwd)
          const { config } = currentSegment(entries)
          if (!config) return { content: "ERROR: No session. Call autoresearch_init first." }

          const { max, warning } = await readConfig(cwd)
          const total = entries.filter((e) => e.type === "run").length
          if (max !== null && total >= max) {
            return {
              content: `STOP: maxIterations (${max}) reached (${total} runs logged). Summarize the results for the user instead of running more.`,
            }
          }

          const hasChecks = existsSync(checksPath(cwd))
          // Rejections propagate (the docs: rethrow, don't return them as tool output).
          await assertShell(context, hasChecks ? [command, "./.auto/checks.sh"] : [command])

          // Mark the run as in progress, so `/autoresearch off` during it can say so.
          await ctx.storage.set(runKey(sessionID), { running: true } as never)
          const samples: number[] = []
          const outputs: ShellResult[] = []
          let checks: ShellResult | null = null
          const startedAt = Date.now()
          try {
            for (let i = 1; i <= repeat; i++) {
              await progress({ status: repeat > 1 ? `running ${command} (${i}/${repeat})` : `running ${command}` })
              dashboards.setStatus(cwd, { running: true, command: repeat > 1 ? `${command} (${i}/${repeat})` : command, startedAt })
              const res = await bash(command, cwd, timeout_seconds * 1000, signal)
              outputs.push(res)
              const value = parseMetrics(res.output)[config.metric_name]
              if (res.code !== 0 || res.timedOut || value === undefined) break
              samples.push(value)
            }
            const last = outputs.at(-1)!
            if (last.code === 0 && !last.timedOut && samples.length === repeat && hasChecks) {
              await progress({ status: "running checks" })
              dashboards.setStatus(cwd, { running: true, command: "checks.sh", startedAt: Date.now() })
              // Relative path: an absolute one breaks when the project path contains spaces.
              checks = await bash("./.auto/checks.sh", cwd, checks_timeout_seconds * 1000, signal)
            }
          } finally {
            dashboards.setStatus(cwd, { running: false })
          }

          const last = outputs.at(-1)!
          const failed = last.code !== 0 || last.timedOut
          const complete = !failed && samples.length === repeat
          const primary = complete ? median(samples) : undefined
          const noise = complete && samples.length >= 3 ? mad(samples) : null
          // Secondary metrics: median across runs where present.
          const perName = new Map<string, number[]>()
          for (const o of outputs)
            for (const [k, v] of Object.entries(parseMetrics(o.output)))
              if (k !== config.metric_name) perName.set(k, [...(perName.get(k) ?? []), v])
          const secondary = [...perName].map(([k, vs]) => [k, median(vs)] as const)
          const checksFailed = checks !== null && (checks.code !== 0 || checks.timedOut)

          const pending: PendingRun = {
            exitCode: last.code,
            timedOut: last.timedOut,
            checksFailed,
            primary,
            noise,
            samples: samples.length,
          }
          await ctx.storage.set(runKey(sessionID), pending as never)

          const wall = outputs.reduce((s, o) => s + o.durationMs, 0) / 1000
          const lines = [
            `exit: ${last.code}${last.timedOut ? " (TIMED OUT)" : ""} · wall: ${wall.toFixed(2)}s` +
              (repeat > 1 ? ` · ${samples.length}/${repeat} runs` : ""),
            `${config.metric_name}: ${
              primary === undefined
                ? failed
                  ? "– (benchmark failed)"
                  : `MISSING (no METRIC ${config.metric_name}=… line)`
                : `${primary} ${config.metric_unit}`.trim() + (repeat > 1 ? ` (median of ${repeat})` : "")
            }`,
          ]
          if (repeat > 1 && samples.length) lines.push(`samples: ${samples.join(", ")}${noise !== null ? ` · noise (MAD) ${fmt(noise)}` : ""}`)
          if (secondary.length) lines.push(`secondary: ${secondary.map(([k, v]) => `${k}=${v}`).join(", ")}`)
          if (checks) lines.push(`checks: ${checksFailed ? "FAILED, log as checks_failed" : "passed"}`)
          if (warning) lines.push(`config warning: ${warning}`)
          if (primary !== undefined) lines.push(`To keep this result, log metric=${primary} (exact value).`)
          lines.push("", "── output (tail) ──", tail(last.output))
          if (checksFailed) lines.push("", "── checks output (tail) ──", tail(checks!.output))
          return { content: lines.join("\n") }
        },
      })

      editor.add({
        name: "log",
        options: { namespace: "autoresearch" },
        description:
          "Record the result of the last autoresearch_run (each run is logged exactly once). `keep` commits the code " +
          "changes (not .auto/) and needs a successful run with the measured metric; `discard`, `crash` and " +
          "`checks_failed` revert everything to the last commit (.auto/ is preserved). Always include `asi` notes: " +
          "what you learned, so a future agent doesn't repeat dead ends.",
        input: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["keep", "discard", "crash", "checks_failed"] },
            metric: { type: "number", description: "Primary metric value from autoresearch_run (the exact value it shows)" },
            description: { type: "string", description: "One line: what this experiment changed" },
            metrics: {
              type: "object",
              description: "Secondary metrics, e.g. {\"heap_mb\": 120}",
              additionalProperties: { type: "number" },
            },
            asi: {
              type: "object",
              description: "Free-form notes for your future self, e.g. {hypothesis, learned, next_focus}",
              additionalProperties: true,
            },
          },
          required: ["status", "metric", "description"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const { sessionID } = context
          const cwd = await cwdOf(sessionID)
          // One log at a time per project: parallel calls could otherwise share a run
          // number or trip over git's index lock.
          return withLock(cwd, () => logExperiment(input, context, cwd))
        },
      })
    })

    const logExperiment = async (input: unknown, context: ToolCtx, cwd: string) => {
      const { sessionID } = context
      let { status, metric, description, metrics = {}, asi = {} } = input as {
        status: RunStatus
        metric: number
        description: string
        metrics?: Record<string, number>
        asi?: Record<string, unknown>
      }
      const entries = await readLog(cwd)
      const { config, runs } = currentSegment(entries)
      if (!config) return { content: "ERROR: No session. Call autoresearch_init first." }

      // Each logged result must belong to exactly one completed measurement.
      const pending = (await ctx.storage.get(runKey(sessionID))) as (PendingRun & { running?: boolean }) | undefined
      if (!pending || pending.running) {
        return {
          content: pending?.running
            ? "ERROR: The last autoresearch_run didn't finish (interrupted?). Run it again before logging."
            : "ERROR: No unlogged run. Call autoresearch_run first; each run is logged once.",
        }
      }
      if (status === "keep") {
        if (pending.exitCode !== 0 || pending.timedOut) {
          return { content: "ERROR: The benchmark failed or timed out, so this run can't be kept. Log it as crash." }
        }
        if (pending.checksFailed) {
          return { content: "ERROR: checks failed on this run, so it can't be kept. Log it as checks_failed." }
        }
        if (pending.primary === undefined) {
          return { content: `ERROR: The run printed no METRIC ${config.metric_name}=… line, so it can't be kept. Log it as crash.` }
        }
        if (Math.abs(pending.primary - metric) > 1e-6 * Math.max(1, Math.abs(pending.primary))) {
          return {
            content: `ERROR: metric ${metric} doesn't match the measured ${config.metric_name}=${pending.primary}. Log the measured value.`,
          }
        }
        metric = pending.primary
      }

      // For discard/checks_failed, record what was actually measured (agents sometimes pass a
      // placeholder like 0). Crashes keep theirs; it's never used for baseline, best or noise.
      let metricNote = ""
      if (status !== "keep" && status !== "crash" && pending.primary !== undefined && pending.primary !== metric) {
        metricNote = ` (recorded the measured ${config.metric_name}=${pending.primary})`
        metric = pending.primary
      }

      // Permission before touching git (rejections propagate).
      await assertShell(
        context,
        status === "keep"
          ? ["git add -A -- .", "git commit -- ."]
          : ["git restore --source=HEAD --staged --worktree -- .", "git clean -fd -- ."],
      )

      let commit: string | null = null
      let gitNote = ""
      if (status === "keep") {
        // `.auto/` isn't committed (see commitKeep); the message goes to git as data, not through a shell.
        const res = await commitKeep(cwd, `autoresearch: ${description} (${config.metric_name}=${metric})`)
        if (!res.ok) {
          // Don't log a keep that isn't in git: the changes stay in place, unstaged.
          return {
            content:
              `ERROR: Couldn't commit, so the run was NOT logged:\n${tail(res.error, 20)}\n` +
              "Fix the cause and call autoresearch_log again, or log it as discard to revert.",
          }
        }
        commit = res.commit
        if (!commit) gitNote = " (no code change to commit)"
      } else {
        // Back to the last kept state, staged changes included; .auto/ is never touched.
        // This is why the skill insists on a dedicated branch with a clean tree.
        const res = await revertToHead(cwd)
        if (!res.ok) {
          return {
            content:
              `ERROR: Reverting failed, so the run was NOT logged:\n${tail(res.output, 20)}\n` +
              "Fix the cause (e.g. a leftover .git/index.lock) and call autoresearch_log again.",
          }
        }
        gitNote = " (changes reverted)"
      }
      await ctx.storage.remove(runKey(sessionID))

      const noise = status === "crash" ? null : (pending.noise ?? null)
      const withThis = [...runs, { status, metric, noise }]
      const { baseline, best } = summarize(withThis, config.direction)
      const confidence = computeConfidence(withThis, baseline, best)
      const total = entries.filter((e) => e.type === "run").length + 1

      await appendLog(cwd, {
        type: "run",
        segment: config.segment,
        run: runs.length + 1,
        status,
        metric,
        metrics,
        description,
        asi,
        commit,
        confidence,
        noise,
        samples: pending.samples ?? 1,
        timestamp: new Date().toISOString(),
      })

      const improved = baseline !== null && best !== null && isBetter(best, baseline, config.direction)
      const delta =
        improved && baseline ? ` (${pctText(((best! - baseline) / Math.abs(baseline)) * 100)} vs baseline)` : ""
      const conf =
        confidence === null
          ? improved
            ? " · confidence unknown (no noise measured; use repeat ≥ 3 in autoresearch_run)"
            : ""
          : ` · confidence ${confidence.toFixed(2)}× ${confidence >= 2 ? "(likely real)" : confidence >= 1 ? "(marginal)" : "(within noise, consider re-running)"}`
      const { max } = await readConfig(cwd)
      return {
        content:
          `Run #${runs.length + 1} logged as ${status}${commit ? ` @ ${commit}` : ""}${gitNote}${metricNote}.\n` +
          `baseline ${fmt(baseline)} → best ${fmt(best)} ${config.metric_unit}${delta}${conf}` +
          (max !== null ? `\nRuns: ${total}/${max}` : ""),
      }
    }

    // ── /autoresearch command ──────────────────────────────
    await ctx.command.transform((editor) => {
      editor.add({
        name: "autoresearch",
        description:
          "Autoresearch loop: `<goal>` start/resume · `status` · `off` · `dashboard` · `finalize` · `help`",
        execute: async ({ sessionID, prompt, delivery }) => {
          const arg = prompt.text.trim()
          const say = (text: string) => tell(sessionID, text, delivery)
          const sub = arg.toLowerCase().replace(/[.!]+$/, "")

          if (sub === "help" || sub === "--help" || sub === "-h") {
            await say(HELP_TEXT.replace(`${PLUGIN_PROMPT_PREFIX} `, ""))
            return
          }

          // "stop", "pause"… mean off. (They used to be taken as a goal and resumed the loop.)
          if (OFF_WORDS.has(sub)) {
            await deactivate(sessionID)
            const unlogged = (await ctx.storage.get(runKey(sessionID))) as { running?: boolean } | undefined
            await say(
              "Loop turned off. .auto/log.jsonl is kept; `/autoresearch` resumes." +
                (unlogged?.running
                  ? " An experiment is still running; the agent will finish and log it, then stop."
                  : unlogged
                    ? " An experiment was measured but not logged yet: its code changes are still in the working tree " +
                      "and would be part of the next experiment. Log it or revert them before resuming."
                    : ""),
            )
            return
          }

          if (sub === "status") {
            const cwd = await cwdOf(sessionID)
            const on = Boolean(await ctx.storage.get(activeKey(sessionID)))
            const entries = await readLog(cwd)
            const { config, runs } = currentSegment(entries)
            const { max, warning } = await readConfig(cwd)
            const total = entries.filter((e) => e.type === "run").length
            const url = dashboards.isOpen(cwd)
            const lines = [`Loop: ${on ? "ON" : "off"}`]
            if (config) {
              const { baseline, best } = summarize(runs, config.direction)
              lines.push(
                `Session: ${config.name} · ${config.metric_name} (${config.direction} is better)`,
                `Runs: ${total}${max !== null ? `/${max}` : ""} in total (${runs.length} in segment ${config.segment}) · ` +
                  `baseline ${fmt(baseline)} → best ${fmt(best)} ${config.metric_unit}`,
              )
              if (warning) lines.push(`Config warning: ${warning}`)
            } else {
              lines.push(existsSync(promptPath(cwd)) ? "Set up, but no experiments yet." : "No session in this project yet.")
            }
            lines.push(url ? `Dashboard: ${url}` : "Dashboard: closed (`/autoresearch dashboard` opens it)")
            await say(lines.join("\n"))
            return
          }

          if (sub === "dashboard off" || sub === "dashboard close") {
            const closed = dashboards.close(await cwdOf(sessionID))
            await say(closed ? "Dashboard closed." : "No dashboard was open for this project.")
            return
          }

          if (sub === "dashboard" || sub === "export") {
            const cwd = await cwdOf(sessionID)
            const wasOpen = dashboards.isOpen(cwd)
            const url = await dashboards.open(cwd)
            if (!wasOpen) openInBrowser(url) // don't open another tab every time
            const note = (await logExists(cwd)) ? "" : " No experiments yet; it fills in as they run."
            await say(`Live dashboard: ${url}${note}`)
            return
          }

          if (sub === "finalize") {
            // Turn the loop off first so it doesn't keep experimenting while branches are cut.
            // If an experiment is mid-run, the request is delivered when the agent's current step ends.
            await deactivate(sessionID)
            await ctx.session.prompt({
              ...prompt,
              sessionID: sessionID as never,
              text: "Finalize this autoresearch session into clean, reviewable branches.",
              skills: [...(prompt.skills ?? []), { id: Skill.ID.make(FINALIZE_SKILL_ID) }],
              delivery,
            })
            return
          }

          const cwd = await cwdOf(sessionID)
          const entries = await readLog(cwd)
          const setup = !existsSync(promptPath(cwd))

          // Already at the run limit: say so instead of turning on a loop that can't run.
          if (!setup) {
            const { max } = await readConfig(cwd)
            const total = entries.filter((e) => e.type === "run").length
            if (max !== null && total >= max) {
              await say(
                `${total}/${max} runs are already logged (maxIterations). Raise maxIterations in ` +
                  ".auto/config.json to continue, or run `/autoresearch finalize` to turn the results into branches.",
              )
              return
            }
          }

          // One loop per project: two would edit the same files and number runs twice.
          for (const other of await otherLoopsHere(sessionID, cwd)) {
            await deactivate(other)
            await notify(other, "Loop turned off here: another session started autoresearch in this project.")
          }

          const runCount = entries.filter((e) => e.type === "run").length
          const state: ActiveState = { directory: cwd, setup, startRunCount: runCount, lastRunCount: runCount, stalls: 0 }
          await activate(sessionID, state)

          if (!setup) {
            await ctx.session.prompt({
              ...prompt,
              sessionID: sessionID as never,
              text: `${CONTINUE_PROMPT}${arg ? `\n\n${USER_CONTEXT_LABEL} ${arg}` : ""}`,
              delivery,
            })
          } else {
            await ctx.session.prompt({
              ...prompt,
              sessionID: sessionID as never,
              text: `Set up and start an autoresearch session. Goal: ${arg || "(ask me)"}`,
              skills: [...(prompt.skills ?? []), { id: Skill.ID.make(SKILL_ID) }],
              delivery,
            })
          }
        },
      })
    })

    // ── Compaction ─────────────────────────────────────────
    // While the loop is on, write the compaction summary from .auto/ instead of letting
    // the model summarize the chat (see compaction.ts for why). Setting event.result
    // skips the model call. Sessions without an active loop are left untouched.
    await ctx.session.hook("compaction", async (event) => {
      const state = (await ctx.storage.get(activeKey(event.sessionID))) as ActiveState | undefined
      if (!state || !ownsSession(state)) return
      try {
        const userMessages = event.messages.flatMap((m) =>
          m.role === "user"
            ? [m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n")]
            : [],
        )
        const summary = await buildCompactionSummary(state.directory, userMessages)
        event.result = { summary, metadata: { source: "opencode-autoresearch" } }
      } catch (err) {
        // Leave event.result unset: OpenCode then writes its normal summary.
        console.error("[autoresearch] compaction summary failed, using the default:", err)
      }
    })

    // ── Keep looping ───────────────────────────────────────
    // session.execution.succeeded fires when a turn finishes. If autoresearch is active for
    // that session, nudge it to continue. Storage is re-read on every event so
    // `/autoresearch off` takes effect immediately.
    // (Not session.idle: it's in the event list but isn't delivered to plugins, as tested
    // on OpenCode 2.2.5.)
    const controller = new AbortController()
    const inFlight = new Set<string>()

    const onTurnEnd = async (sessionID: string) => {
      if (inFlight.has(sessionID)) return
      inFlight.add(sessionID)
      try {
        const state = (await ctx.storage.get(activeKey(sessionID))) as ActiveState | undefined
        if (!state || !ownsSession(state)) return

        const entries = await readLog(state.directory)
        const runCount = entries.filter((e) => e.type === "run").length
        // While setting up (no prompt.md when the loop started), the agent may be waiting for
        // the user's answers; nudging would push past those questions. Only in that case do we
        // wait for the first logged experiment. (Applying this to resumes too left loops stuck
        // "on" forever when the first turn logged nothing.)
        if (state.setup && runCount <= state.startRunCount) return
        const stalls = runCount > state.lastRunCount ? 0 : state.stalls + 1

        const { max } = await readConfig(state.directory)
        const hitMax = max !== null && runCount >= max

        if (controller.signal.aborted) return // plugin is unloading (e.g. reload); the new copy takes over
        if (stalls >= MAX_STALLS || hitMax) {
          await deactivate(sessionID)
          // Shown right away (the user wants to know why the loop ended); costs one short reply.
          await tell(
            sessionID,
            hitMax
              ? `maxIterations (${max}) reached. Loop stopped. \`/autoresearch finalize\` turns the kept experiments into reviewable branches.`
              : `No new experiments in ${MAX_STALLS} turns. Loop paused; \`/autoresearch\` resumes it.`,
          )
          return
        }

        // `/autoresearch off` may have landed while we were reading; don't bring the loop back.
        if (!(await ctx.storage.get(activeKey(sessionID))) || controller.signal.aborted) return
        await ctx.storage.set(activeKey(sessionID), { ...state, lastRunCount: runCount, stalls } as never)
        // A synthetic (plugin-originated) input, not a fake user message: the docs list
        // synthetic for plugin input, and it doesn't run other plugins' user-prompt hooks.
        await ctx.session.synthetic({ sessionID: sessionID as never, text: CONTINUE_PROMPT, delivery: "queue" })
      } catch (err) {
        console.error("[autoresearch] turn-end handler failed:", err)
      } finally {
        inFlight.delete(sessionID)
      }
    }

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: ["session.execution.succeeded", "session.execution.interrupted", "session.execution.failed"],
          signal: controller.signal,
        })) {
          const sessionID = event.data.sessionID as string
          if (event.type === "session.execution.succeeded") {
            void onTurnEnd(sessionID)
            continue
          }
          const state = (await ctx.storage.get(activeKey(sessionID))) as ActiveState | undefined
          if (!state || !ownsSession(state)) continue
          if (event.type === "session.execution.interrupted") {
            // The user pressed stop: respect it and turn the loop off.
            await deactivate(sessionID)
            await notify(sessionID, "Loop turned off because the session was stopped. `/autoresearch` resumes it.")
          } else {
            // A provider/model error: don't retry in a loop. It stays on and continues after
            // the next turn that finishes normally.
            await notify(
              sessionID,
              "The last turn failed (provider or model error), so the loop is waiting. Send any message or `/autoresearch` to continue.",
            )
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) console.error("[autoresearch] event stream ended:", err)
      }
    })()

    return () => {
      controller.abort()
      dashboards.closeAll()
    }
  },
})
