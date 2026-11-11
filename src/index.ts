// opencode-autoresearch: try an idea, measure it, keep what works, revert what
// doesn't, repeat. A minimal OpenCode v2 port of pi-autoresearch
// (https://github.com/davebcn87/pi-autoresearch).
//
// Split of responsibilities (same as the pi original):
//   - this plugin  = domain-agnostic machinery (run, time, log, commit/revert, keep looping)
//   - the skill    = how to set up a session for a specific goal
//   - .auto/ files = the durable state, so any fresh agent can resume

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin, Skill } from "@opencode/plugin"
import { buildCompactionSummary, PLUGIN_PROMPT_PREFIX } from "./compaction.ts"
import { Dashboards, logExists, openInBrowser } from "./dashboard.ts"
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

// ── Shell helpers ─────────────────────────────────────────

interface ShellResult {
  code: number | null
  output: string
  durationMs: number
  timedOut: boolean
}

/** Run a bash command, merging stdout+stderr, with a timeout and abort support. */
function sh(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<ShellResult> {
  return new Promise((resolve) => {
    const started = performance.now()
    // detached: gives the command its own process group so we can kill the whole tree.
    const child = spawn("bash", ["-c", command], { cwd, detached: true, env: process.env })
    let output = ""
    let timedOut = false
    child.stdout.on("data", (d) => (output += d))
    child.stderr.on("data", (d) => (output += d))
    const kill = () => {
      try {
        process.kill(-child.pid!, "SIGKILL")
      } catch {}
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, timeoutMs)
    signal?.addEventListener("abort", kill, { once: true })
    child.on("close", (code) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", kill)
      resolve({ code, output, durationMs: performance.now() - started, timedOut })
    })
    child.on("error", (err) => {
      clearTimeout(timer)
      resolve({ code: -1, output: String(err), durationMs: performance.now() - started, timedOut })
    })
  })
}

const git = (args: string, cwd: string) => sh(`git ${args}`, cwd, 60_000)

const tail = (text: string, n = OUTPUT_TAIL_LINES) => text.trimEnd().split("\n").slice(-n).join("\n")

const fmt = (n: number | null | undefined) =>
  n === null || n === undefined ? "–" : Number.isInteger(n) ? String(n) : n.toPrecision(5)

// ── Per-session runtime state ─────────────────────────────

/** Persisted in plugin storage under `active/<sessionID>` while the loop is on. */
interface ActiveState {
  directory: string
  /** Number of logged runs when the loop was turned on. Auto-continue waits until there are more. */
  startRunCount: number
  /** Number of logged runs when we last auto-continued; detects a stalled agent. */
  lastRunCount: number
  /** Consecutive auto-continues with no new logged run. */
  stalls: number
}

const MAX_STALLS = 3

/** Remembers whether the last run_experiment's checks failed, so log_experiment can refuse `keep`. */
const lastChecksFailed = new Map<string, boolean>()

async function readMaxIterations(cwd: string): Promise<number | null> {
  try {
    const raw = JSON.parse(await readFile(join(cwd, ".auto", "config.json"), "utf8"))
    return typeof raw.maxIterations === "number" ? raw.maxIterations : null
  } catch {
    return null
  }
}

const HELP_TEXT = [
  "[autoresearch] Commands:",
  "  /autoresearch <goal>      start a session (or resume it if .auto/prompt.md exists)",
  "  /autoresearch off         stop the loop; the log is kept",
  "  /autoresearch dashboard   open the live results page in your browser",
  "  /autoresearch finalize    stop the loop and split kept experiments into reviewable branches",
].join("\n")

const INSTRUCTION_KEY = "autoresearch"
const ACTIVE_INSTRUCTION = [
  "Autoresearch mode is ON in this session: you are running an autonomous experiment loop.",
  "Use init_experiment, run_experiment and log_experiment. Session state lives in .auto/:",
  "prompt.md (goal and rules), log.jsonl (every run), ideas.md (backlog).",
  "Don't ask whether to continue; keep running experiments until the user stops the loop.",
].join(" ")

// Must start with PLUGIN_PROMPT_PREFIX so the compaction summary can tell it apart from the user's messages.
const CONTINUE_PROMPT = [
  `${PLUGIN_PROMPT_PREFIX} Continue the experiment loop.`,
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
            bench = await sh(command, cwd, timeout_seconds * 1000, signal)
            if (bench.code === 0 && existsSync(checksPath(cwd))) {
              await progress({ status: "running checks" })
              dashboards.setStatus(cwd, { running: true, command: "checks.sh", startedAt: Date.now() })
              checks = await sh(checksPath(cwd), cwd, checks_timeout_seconds * 1000, signal)
            }
          } finally {
            dashboards.setStatus(cwd, { running: false })
          }
          const metrics = parseMetrics(bench.output)
          const primary = metrics[config.metric_name]
          const checksFailed = checks !== null && checks.code !== 0
          lastChecksFailed.set(sessionID, checksFailed)

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
          "Record the result of the last run_experiment. `keep` commits all changes; `discard`, `crash` and " +
          "`checks_failed` revert code changes (the .auto/ folder is preserved). Always include `asi` notes: " +
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
          const { status, metric, description, metrics = {}, asi = {} } = input as {
            status: RunStatus
            metric: number
            description: string
            metrics?: Record<string, number>
            asi?: Record<string, unknown>
          }
          const cwd = await cwdOf(sessionID)
          const { config, runs } = currentSegment(await readLog(cwd))
          if (!config) return { content: "ERROR: No session. Call init_experiment first." }
          if (status === "keep" && lastChecksFailed.get(sessionID)) {
            return { content: "ERROR: checks failed on the last run, so it can't be kept. Log it as checks_failed." }
          }

          let commit: string | null = null
          let gitNote = ""
          if (status === "keep") {
            await git("add -A", cwd)
            const msg = `autoresearch: ${description} (${config.metric_name}=${fmt(metric)})`
            const res = await git(`commit -q -m ${JSON.stringify(msg)}`, cwd)
            if (res.code === 0) {
              commit = (await git("rev-parse --short HEAD", cwd)).output.trim()
            } else {
              gitNote = /nothing to commit/.test(res.output) ? " (nothing to commit)" : `\nWARNING: commit failed:\n${tail(res.output, 20)}`
            }
          } else {
            // Revert tracked changes and remove untracked files, but never touch .auto/.
            // This is why the skill insists on a dedicated branch with a clean tree.
            await git("checkout -- . ':(exclude).auto'", cwd)
            await git("clean -fd -- . ':(exclude).auto'", cwd)
            gitNote = " (changes reverted)"
          }
          lastChecksFailed.delete(sessionID)

          const all = [...runs.map((r) => r.metric), metric]
          const { baseline, best } = summarize(
            [...runs, { status, metric } as (typeof runs)[number]],
            config.direction,
          )
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
              `Run #${runs.length + 1} logged as ${status}${commit ? ` @ ${commit}` : ""}${gitNote}.\n` +
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
        description: "Autoresearch loop: `<goal>` start/resume · `off` · `dashboard` · `finalize` · `help`",
        execute: async ({ sessionID, prompt, delivery }) => {
          const arg = prompt.text.trim()
          const say = (text: string) => ctx.session.synthetic({ sessionID: sessionID as never, text })
          const sub = arg.toLowerCase()

          if (sub === "help" || sub === "--help" || sub === "-h") {
            await say(HELP_TEXT)
            return
          }

          if (sub === "off") {
            await deactivate(sessionID)
            await say("[autoresearch] Loop turned off. .auto/log.jsonl is kept; `/autoresearch` resumes.")
            return
          }

          if (sub === "dashboard" || sub === "export") {
            const cwd = await cwdOf(sessionID)
            const url = await dashboards.open(cwd)
            openInBrowser(url)
            const note = (await logExists(cwd)) ? "" : " No experiments yet; it fills in as they run."
            await say(`[autoresearch] Live dashboard: ${url}${note}`)
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
          const runCount = (await readLog(cwd)).filter((e) => e.type === "run").length
          const state: ActiveState = { directory: cwd, startRunCount: runCount, lastRunCount: runCount, stalls: 0 }
          await activate(sessionID, state)

          if (existsSync(promptPath(cwd))) {
            await ctx.session.prompt({
              ...prompt,
              sessionID: sessionID as never,
              text: `${CONTINUE_PROMPT}${arg ? `\n\nAdditional context from the user: ${arg}` : ""}`,
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
      if (!state) return
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
    // session.idle fires after every finished turn. If autoresearch is active for that
    // session, nudge it to continue. Storage is re-read on every event so `/autoresearch off`
    // takes effect immediately.
    const controller = new AbortController()
    const inFlight = new Set<string>()

    const onIdle = async (sessionID: string) => {
      if (inFlight.has(sessionID)) return
      inFlight.add(sessionID)
      try {
        const state = (await ctx.storage.get(activeKey(sessionID))) as ActiveState | undefined
        if (!state) return

        const entries = await readLog(state.directory)
        const runCount = entries.filter((e) => e.type === "run").length
        // Until the first experiment is logged, the agent is still setting up and may be
        // waiting for the user's answers. Nudging it then would push past those questions.
        if (runCount <= (state.startRunCount ?? 0)) return
        const stalls = runCount > state.lastRunCount ? 0 : state.stalls + 1

        const { runs } = currentSegment(entries)
        const max = await readMaxIterations(state.directory)
        const hitMax = max !== null && runs.length >= max

        if (stalls >= MAX_STALLS || hitMax) {
          await deactivate(sessionID)
          await ctx.session.synthetic({
            sessionID: sessionID as never,
            text: hitMax
              ? `[autoresearch] maxIterations (${max}) reached. Loop stopped.`
              : `[autoresearch] No new experiments in ${MAX_STALLS} turns. Loop paused; \`/autoresearch\` to resume.`,
          })
          return
        }

        await ctx.storage.set(activeKey(sessionID), { ...state, lastRunCount: runCount, stalls } as never)
        await ctx.session.prompt({ sessionID: sessionID as never, text: CONTINUE_PROMPT, delivery: "queue" })
      } catch (err) {
        console.error("[autoresearch] idle handler failed:", err)
      } finally {
        inFlight.delete(sessionID)
      }
    }

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: ["session.idle", "session.execution.interrupted"],
          signal: controller.signal,
        })) {
          const sessionID = event.data.sessionID as string
          if (event.type === "session.execution.interrupted") {
            // The user pressed stop: respect it and turn the loop off.
            await deactivate(sessionID)
          } else {
            void onIdle(sessionID)
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
