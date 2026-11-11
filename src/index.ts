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
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin, Skill } from "@opencode/plugin"
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

const CONTINUE_PROMPT = [
  "[autoresearch] Continue the experiment loop.",
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

    // ── Skill ──────────────────────────────────────────────
    // Read before the (synchronous) transform, as the docs require.
    const skillFile = join(ROOT, "skills", SKILL_ID, "SKILL.md")
    const skillRaw = await readFile(skillFile, "utf8")
    const fm = skillRaw.match(/^---\n([\s\S]*?)\n---\n/)
    const skillDescription = fm?.[1].match(/^description:\s*(.+)$/m)?.[1].trim()
    const skillBody = fm ? skillRaw.slice(fm[0].length) : skillRaw

    await ctx.skill.transform((editor) => {
      editor.add({
        id: Skill.ID.make(SKILL_ID),
        name: Skill.Name.make(SKILL_ID),
        description: skillDescription,
        path: Skill.Info.fields.path.make(skillFile),
        content: skillBody,
      })
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
          const bench = await sh(command, cwd, timeout_seconds * 1000, signal)
          const metrics = parseMetrics(bench.output)
          const primary = metrics[config.metric_name]

          let checks: ShellResult | null = null
          if (bench.code === 0 && existsSync(checksPath(cwd))) {
            await progress({ status: "running checks" })
            checks = await sh(checksPath(cwd), cwd, checks_timeout_seconds * 1000, signal)
          }
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
        description: "Start or resume the autoresearch loop (`/autoresearch <goal>`), or stop it (`/autoresearch off`)",
        execute: async ({ sessionID, prompt, delivery }) => {
          const arg = prompt.text.trim()
          if (arg === "off") {
            await ctx.storage.remove(activeKey(sessionID))
            await ctx.session.synthetic({
              sessionID: sessionID as never,
              text: "[autoresearch] Loop turned off. .auto/log.jsonl is kept; `/autoresearch` resumes.",
            })
            return
          }

          const cwd = await cwdOf(sessionID)
          const runCount = (await readLog(cwd)).filter((e) => e.type === "run").length
          const state: ActiveState = { directory: cwd, lastRunCount: runCount, stalls: 0 }
          await ctx.storage.set(activeKey(sessionID), state as never)

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
        const stalls = runCount > state.lastRunCount ? 0 : state.stalls + 1

        const { runs } = currentSegment(entries)
        const max = await readMaxIterations(state.directory)
        const hitMax = max !== null && runs.length >= max

        if (stalls >= MAX_STALLS || hitMax) {
          await ctx.storage.remove(activeKey(sessionID))
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
            await ctx.storage.remove(activeKey(sessionID))
          } else {
            void onIdle(sessionID)
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) console.error("[autoresearch] event stream ended:", err)
      }
    })()

    return () => controller.abort()
  },
})
