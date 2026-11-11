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

/** Up to 5 significant digits, without trailing zeros (4.4, not 4.4000). */
const fmt = (n: number | null | undefined) =>
  n === null || n === undefined ? "–" : String(Number(n.toPrecision(5)))

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
 * Persisted under `run/<sessionID>` by run_experiment and consumed by log_experiment, so each
 * logged result is tied to an actual measurement (and survives a plugin reload in between).
 */
interface PendingRun {
  exitCode: number | null
  timedOut: boolean
  checksFailed: boolean
  /** Measured value of the primary metric; undefined if the METRIC line was missing. */
  primary?: number
}

const MAX_STALLS = 3

/** `maxIterations` from .auto/config.json; also accepts a numeric string. Null = no limit. */
async function readMaxIterations(cwd: string): Promise<number | null> {
  try {
    const raw = JSON.parse(await readFile(join(cwd, ".auto", "config.json"), "utf8"))
    const n = Number(raw.maxIterations)
    return raw.maxIterations !== undefined && raw.maxIterations !== null && Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
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
  "Use init_experiment, run_experiment and log_experiment. Session state lives in .auto/:",
  "prompt.md (goal and rules), log.jsonl (every run), ideas.md (backlog).",
  "Don't ask whether to continue; keep running experiments until the user stops the loop.",
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
    const tell = (sessionID: string, text: string) =>
      ctx.session
        .synthetic({
          sessionID: sessionID as never,
          text: `${PLUGIN_PROMPT_PREFIX} ${text}\n\n(Shown to the user. No action needed; at most acknowledge it in one line.)`,
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
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "init_experiment",
        description:
          "Start (or restart) an autoresearch session: name, primary metric, unit and direction. " +
          "Call again when the optimization target changes; this starts a new segment with a fresh baseline.",
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
          const { config } = currentSegment(await readLog(cwd))
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
          return {
            content:
              `Initialized "${name}" (segment ${segment}): ${metric_name} in ${metric_unit || "units"}, ${direction} is better.\n` +
              `Next: run_experiment for the baseline, then log_experiment with status "keep".`,
          }
        },
      })

      editor.add({
        name: "run_experiment",
        description:
          "Run the benchmark (default ./.auto/measure.sh), time it, and parse `METRIC name=value` lines. " +
          "If .auto/checks.sh exists and the benchmark passed, runs it too. Does not log anything; call log_experiment next.",
        input: {
          type: "object",
          properties: {
            command: { type: "string", description: "Command to run. Default: ./.auto/measure.sh" },
            timeout_seconds: { type: "number", description: "Benchmark timeout (default 600)" },
            checks_timeout_seconds: { type: "number", description: "checks.sh timeout (default 300)" },
          },
          additionalProperties: false,
        },
        async execute(input, { sessionID, signal, progress }) {
          const {
            command = "./.auto/measure.sh",
            timeout_seconds = 600,
            checks_timeout_seconds = 300,
          } = input as { command?: string; timeout_seconds?: number; checks_timeout_seconds?: number }
          const cwd = await cwdOf(sessionID)
          const { config, runs } = currentSegment(await readLog(cwd))
          if (!config) return { content: "ERROR: No session. Call init_experiment first." }

          const max = await readMaxIterations(cwd)
          if (max !== null && runs.length >= max) {
            return {
              content: `STOP: maxIterations (${max}) reached for this segment. Summarize results for the user instead of running more.`,
            }
          }

          await progress({ status: `running ${command}` })
          dashboards.setStatus(cwd, { running: true, command, startedAt: Date.now() })
          let bench: ShellResult
          let checks: ShellResult | null = null
          try {
            bench = await bash(command, cwd, timeout_seconds * 1000, signal)
            if (bench.code === 0 && !bench.timedOut && existsSync(checksPath(cwd))) {
              await progress({ status: "running checks" })
              dashboards.setStatus(cwd, { running: true, command: "checks.sh", startedAt: Date.now() })
              // Relative path: an absolute one breaks when the project path contains spaces.
              checks = await bash("./.auto/checks.sh", cwd, checks_timeout_seconds * 1000, signal)
            }
          } finally {
            dashboards.setStatus(cwd, { running: false })
          }
          const metrics = parseMetrics(bench.output)
          const primary = metrics[config.metric_name]
          const checksFailed = checks !== null && (checks.code !== 0 || checks.timedOut)
          const pending: PendingRun = { exitCode: bench.code, timedOut: bench.timedOut, checksFailed, primary }
          await ctx.storage.set(runKey(sessionID), pending as never)

          const lines = [
            `exit: ${bench.code}${bench.timedOut ? " (TIMED OUT)" : ""} · wall: ${(bench.durationMs / 1000).toFixed(2)}s`,
            `${config.metric_name}: ${primary === undefined ? "MISSING (no METRIC line found)" : fmt(primary)} ${config.metric_unit}`,
          ]
          const secondary = Object.entries(metrics).filter(([k]) => k !== config.metric_name)
          if (secondary.length) lines.push(`secondary: ${secondary.map(([k, v]) => `${k}=${fmt(v)}`).join(", ")}`)
          if (checks) lines.push(`checks: ${checksFailed ? "FAILED, log as checks_failed" : "passed"}`)
          lines.push("", "── output (tail) ──", tail(bench.output))
          if (checksFailed) lines.push("", "── checks output (tail) ──", tail(checks!.output))
          return { content: lines.join("\n") }
        },
      })

      editor.add({
        name: "log_experiment",
        description:
          "Record the result of the last run_experiment (each run is logged exactly once). `keep` commits the code " +
          "changes (not .auto/) and needs a successful run with the measured metric; `discard`, `crash` and " +
          "`checks_failed` revert everything to the last commit (.auto/ is preserved). Always include `asi` notes: " +
          "what you learned, so a future agent doesn't repeat dead ends.",
        input: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["keep", "discard", "crash", "checks_failed"] },
            metric: { type: "number", description: "Primary metric value from run_experiment" },
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
        async execute(input, { sessionID }) {
          let { status, metric, description, metrics = {}, asi = {} } = input as {
            status: RunStatus
            metric: number
            description: string
            metrics?: Record<string, number>
            asi?: Record<string, unknown>
          }
          const cwd = await cwdOf(sessionID)
          const { config, runs } = currentSegment(await readLog(cwd))
          if (!config) return { content: "ERROR: No session. Call init_experiment first." }

          // Each logged result must belong to exactly one measurement.
          const pending = (await ctx.storage.get(runKey(sessionID))) as PendingRun | undefined
          if (!pending) {
            return { content: "ERROR: No unlogged run. Call run_experiment first; each run is logged once." }
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
            if (Math.abs(pending.primary - metric) > 1e-9 * Math.max(1, Math.abs(pending.primary))) {
              return {
                content: `ERROR: metric ${metric} doesn't match the measured ${config.metric_name}=${pending.primary}. Log the measured value.`,
              }
            }
          }

          // For discard/checks_failed, record what was actually measured (agents sometimes pass a
          // placeholder like 0, which then skewed the confidence estimate). Crashes keep theirs.
          let metricNote = ""
          if (status !== "keep" && status !== "crash" && pending.primary !== undefined && pending.primary !== metric) {
            metricNote = ` (recorded the measured ${config.metric_name}=${fmt(pending.primary)})`
            metric = pending.primary
          }

          let commit: string | null = null
          let gitNote = ""
          if (status === "keep") {
            // `.auto/` isn't committed (see commitKeep); the message goes to git as data, not through a shell.
            const res = await commitKeep(cwd, `autoresearch: ${description} (${config.metric_name}=${fmt(metric)})`)
            if (!res.ok) {
              // Don't log a keep that isn't in git: the changes stay in place, unstaged.
              return {
                content:
                  `ERROR: Couldn't commit, so the run was NOT logged:\n${tail(res.error, 20)}\n` +
                  "Fix the cause and call log_experiment again, or log it as discard to revert.",
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
                  "Fix the cause (e.g. a leftover .git/index.lock) and call log_experiment again.",
              }
            }
            gitNote = " (changes reverted)"
          }
          await ctx.storage.remove(runKey(sessionID))

          // Crash metrics are placeholders; leave them out of the noise estimate.
          const all = [...runs, { status, metric }].filter((r) => r.status !== "crash").map((r) => r.metric)
          const { baseline, best } = summarize([...runs, { status, metric }], config.direction)
          const confidence = all.length >= 3 ? computeConfidence(all, baseline, best) : null

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
            timestamp: new Date().toISOString(),
          })

          const improved = baseline !== null && best !== null && isBetter(best, baseline, config.direction)
          const delta =
            improved && baseline ? ` (${(((best! - baseline) / Math.abs(baseline)) * 100).toFixed(1)}% vs baseline)` : ""
          const conf =
            confidence === null
              ? ""
              : ` · confidence ${confidence.toFixed(2)}× ${confidence >= 2 ? "(likely real)" : confidence >= 1 ? "(marginal)" : "(within noise, consider re-running)"}`
          const max = await readMaxIterations(cwd)
          return {
            content:
              `Run #${runs.length + 1} logged as ${status}${commit ? ` @ ${commit}` : ""}${gitNote}${metricNote}.\n` +
              `baseline ${fmt(baseline)} → best ${fmt(best)} ${config.metric_unit}${delta}${conf}` +
              (max !== null ? `\nRuns: ${runs.length + 1}/${max}` : ""),
          }
        },
      })
    })

    // ── /autoresearch command ──────────────────────────────
    await ctx.command.transform((editor) => {
      editor.add({
        name: "autoresearch",
        description:
          "Autoresearch loop: `<goal>` start/resume · `status` · `off` · `dashboard` · `finalize` · `help`",
        execute: async ({ sessionID, prompt, delivery }) => {
          const arg = prompt.text.trim()
          const say = (text: string) => tell(sessionID, text)
          const sub = arg.toLowerCase().replace(/[.!]+$/, "")

          if (sub === "help" || sub === "--help" || sub === "-h") {
            await say(HELP_TEXT.replace(`${PLUGIN_PROMPT_PREFIX} `, ""))
            return
          }

          // "stop", "pause"… mean off. (They used to be taken as a goal and resumed the loop.)
          if (OFF_WORDS.has(sub)) {
            await deactivate(sessionID)
            const unlogged = await ctx.storage.get(runKey(sessionID))
            await say(
              "Loop turned off. .auto/log.jsonl is kept; `/autoresearch` resumes." +
                (unlogged
                  ? " An experiment was measured but not logged yet: its code changes are still in the working tree " +
                    "and would be part of the next experiment. Log it or revert them before resuming."
                  : ""),
            )
            return
          }

          if (sub === "status") {
            const cwd = await cwdOf(sessionID)
            const on = Boolean(await ctx.storage.get(activeKey(sessionID)))
            const { config, runs } = currentSegment(await readLog(cwd))
            const max = await readMaxIterations(cwd)
            const url = dashboards.isOpen(cwd)
            const lines = [`Loop: ${on ? "ON" : "off"}`]
            if (config) {
              const { baseline, best } = summarize(runs, config.direction)
              lines.push(
                `Session: ${config.name} · ${config.metric_name} (${config.direction} is better)`,
                `Runs: ${runs.length}${max !== null ? `/${max}` : ""} · baseline ${fmt(baseline)} → best ${fmt(best)} ${config.metric_unit}`,
              )
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
            const max = await readMaxIterations(cwd)
            const { runs } = currentSegment(entries)
            if (max !== null && runs.length >= max) {
              await say(
                `This segment already has ${runs.length}/${max} runs (maxIterations). Raise maxIterations in ` +
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

        const { runs } = currentSegment(entries)
        const max = await readMaxIterations(state.directory)
        const hitMax = max !== null && runs.length >= max

        if (stalls >= MAX_STALLS || hitMax) {
          await deactivate(sessionID)
          await notify(
            sessionID,
            hitMax
              ? `maxIterations (${max}) reached. Loop stopped. \`/autoresearch finalize\` turns the kept experiments into reviewable branches.`
              : `No new experiments in ${MAX_STALLS} turns. Loop paused; \`/autoresearch\` resumes it.`,
          )
          return
        }

        // `/autoresearch off` may have landed while we were reading; don't bring the loop back.
        if (!(await ctx.storage.get(activeKey(sessionID)))) return
        await ctx.storage.set(activeKey(sessionID), { ...state, lastRunCount: runCount, stalls } as never)
        await ctx.session.prompt({ sessionID: sessionID as never, text: CONTINUE_PROMPT, delivery: "queue" })
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
