// opencode-autoresearch: try an idea, measure it, keep what is confirmed to work, revert
// what doesn't, repeat. For OpenCode v2.
//
// Split of responsibilities:
//   - experiment.ts = the tools (measure, judge, commit/revert); the plugin decides, the agent proposes
//   - this file     = wiring into OpenCode: the /autoresearch command, loop on/off, keeping
//                     the loop going across turns, provider errors and restarts
//   - the skill     = how to set up a session for a specific goal (explains; enforces nothing)
//   - .auto/ files  = the durable state, so any fresh agent can resume

import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin, Skill } from "@opencode/plugin"
import { buildCompactionSummary, PLUGIN_PROMPT_PREFIX, USER_CONTEXT_LABEL } from "./compaction.ts"
import { Dashboards, logExists, openInBrowser } from "./dashboard.ts"
import {
  benchmarkDrift,
  fmt,
  initExperiment,
  limitReached,
  logExperiment,
  pauseLoop,
  progressText,
  recoverInterruptedSwap,
  runExperiment,
  runKey,
  type ActiveState,
  type Host,
  type PendingRun,
  type ToolCtx,
} from "./experiment.ts"
import { timing } from "./timing.ts"
import { currentBranch, fileHash, frozenInputs, git, headSha, isTrunk, scopeStatus, sessionBranches, tailLines } from "./shell.ts"
import {
  autoDir,
  checksPath,
  confirmationRuns,
  countRuns,
  currentSegment,
  measurePath,
  noImprovementStreak,
  promptPath,
  readLog,
  readSettings,
  segmentSummaries,
} from "./state.ts"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SKILL_ID = "autoresearch-create"
const FINALIZE_SKILL_ID = "autoresearch-finalize"
/** Turns in a row without a logged run before the loop pauses. */
const MAX_STALLS = 3

const HELP_TEXT = [
  "Commands:",
  "  /autoresearch <goal>          start a session (or resume it if .auto/prompt.md exists)",
  "  /autoresearch status          is the loop on? every segment's runs, kept experiments and gain; limits, warnings",
  "  /autoresearch off             stop the loop; the log is kept (also: stop, pause)",
  "  /autoresearch dashboard       open the live results page in your browser",
  "  /autoresearch dashboard off   close the dashboard's local web server",
  "  /autoresearch finalize        stop the loop and split kept experiments into reviewable branches",
  "  /autoresearch help            this list",
].join("\n")

const OFF_WORDS = new Set(["off", "stop", "pause", "end", "quit", "cancel", "exit"])

const INSTRUCTION_KEY = "autoresearch"
/**
 * Pinned into the session's instructions while the loop is on. Instructions aren't part
 * of the conversation, so this survives compaction: it carries the rules the agent must
 * never lose. It says one thing about stopping (use autoresearch_pause), not two.
 * It's also pinned during setup, where the agent still creates the branch, writes the
 * benchmark and commits the session files; so the rules say from when they apply.
 */
const ACTIVE_INSTRUCTION = [
  "Autoresearch mode is ON in this session: you are running an autonomous experiment loop.",
  "Tools: autoresearch_init, autoresearch_run, autoresearch_log, autoresearch_pause (in Code Mode: tools.autoresearch.init / .run / .log / .pause).",
  "Session state lives in .auto/: prompt.md (goal and rules), log.jsonl (every run), ideas.md (backlog).",
  "",
  "During setup (until autoresearch_init has run) follow the autoresearch-create skill: create the branch, write and commit the session files.",
  "",
  "Rules once autoresearch_init has run:",
  "- One experiment = change code, autoresearch_run, autoresearch_log. Don't edit files between run and log, or while autoresearch_log runs.",
  "- The plugin decides keeps. When the measurement looks better, log `keep`: the plugin measures the last commit and your change back to back and commits only a confirmed gain; otherwise it reverts and logs a discard. Not better: log `discard`. A change that removes more lines than it adds, at about equal performance: `keep` with `simplification: true`.",
  "- The benchmark is frozen: don't touch .auto/measure.sh, .auto/checks.sh or any helper file under .auto/ during experiments (only prompt.md, ideas.md and config.json may change). A legitimate change means: revert code changes, edit the file, commit that edit, call autoresearch_init (a new segment, visible to the user).",
  "- No cheating: don't shrink or special-case the workload, edit the benchmark to print better numbers, cache results between runs, remove or weaken tests or checks, or hard-code benchmark inputs.",
  "- Never commit, stash, reset, or switch branches yourself; the plugin does all git changes. The one exception: committing an edit of the benchmark files under .auto/ right before autoresearch_init.",
  "",
  "At all times:",
  "- Don't ask whether to continue; the plugin continues the loop after each turn.",
  // "a permission error or rejection": a rejected permission can carry the user's own
  // message, without the words "Permission denied" this rule used to key on.
  "- To stop (out of promising ideas, you need the user, or a tool call ends in a permission error or rejection), call autoresearch_pause with the reason. Don't run filler experiments, and don't retry or work around a refused permission.",
].join("\n")

// Must start with PLUGIN_PROMPT_PREFIX so the compaction summary can tell it apart from the user's messages.
const CONTINUE_PROMPT = [
  `${PLUGIN_PROMPT_PREFIX} Continue the experiment loop. The loop is ON now; earlier`,
  "[autoresearch] notices saying it was stopped, paused or off are out of date.",
  "If you've lost context, re-read .auto/prompt.md, the last ~20 lines of .auto/log.jsonl,",
  ".auto/ideas.md (if present) and `git log --oneline -20` first. If `git status` shows changes of an",
  "unfinished experiment, finish it (autoresearch_run, then autoresearch_log). Then run the next experiment.",
  "If there's nothing promising left to try, call autoresearch_pause instead.",
].join(" ")

const RETRY_PROMPT = `${PLUGIN_PROMPT_PREFIX} The previous turn failed with a provider or model error. Pick up where you left off.`

// ── Plugin ────────────────────────────────────────────────

export default Plugin.define({
  id: "autoresearch",
  async setup(ctx) {
    const cwdOf = async (sessionID: string) => {
      const session = await ctx.session.get({ sessionID: sessionID as never })
      return session.location.directory as string
    }
    const activeKey = (sessionID: string) => `active/${sessionID}`
    const stoppedKey = (sessionID: string) => `stopped/${sessionID}`
    const loopState = async (sessionID: string) =>
      (await ctx.storage.get(activeKey(sessionID))) as ActiveState | undefined
    const saveLoopState = (sessionID: string, state: ActiveState) =>
      // JSON round trip: storage rejects `undefined` values.
      ctx.storage.set(activeKey(sessionID), JSON.parse(JSON.stringify(state)) as never)

    // OpenCode runs one copy of this plugin per project (location). Every copy receives every
    // session's events, and plugin storage is shared between them (both verified live). So each
    // copy only acts on loops started in its own project; otherwise, with several projects
    // open, each turn would get one "continue" prompt per project.
    const ownsSession = (state: ActiveState) => state.directory === ctx.location.directory

    // Timers that re-send the continue after a failed turn, per session. Cleared when the
    // loop stops and when the plugin unloads.
    const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
    const clearRetry = (sessionID: string) => {
      clearTimeout(retryTimers.get(sessionID))
      retryTimers.delete(sessionID)
    }

    // Loop on/off. Besides the storage flag, "on" pins the rules into the session's
    // instructions (see ACTIVE_INSTRUCTION). Instruction entries are an experimental
    // OpenCode API, so failures are only logged.
    const activate = async (sessionID: string, state: ActiveState) => {
      await saveLoopState(sessionID, { ...state, since: new Date().toISOString() })
      await ctx.session.instructions.entry
        .put({ sessionID: sessionID as never, key: INSTRUCTION_KEY as never, value: ACTIVE_INSTRUCTION })
        .catch((err) => console.error("[autoresearch] couldn't pin instructions:", err))
    }
    const deactivate = async (sessionID: string) => {
      clearRetry(sessionID)
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
     * - tell: the answer to a command the user just typed (status, help…), or a stop that
     *   happens between turns. It must show up now, so it starts a turn; the model only
     *   needs to acknowledge it.
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

    /**
     * Every stop goes through here, so every stop tells the user why. From inside a tool
     * call (a turn is running) the notice rides along with that turn; between turns it
     * starts a short one so it's visible right away.
     */
    const stopLoop = async (sessionID: string, reason: string, how: "notify" | "tell" | "silent" = "notify") => {
      await deactivate(sessionID)
      // Kept for `/autoresearch status`. "silent" stops (an interrupt, a failed provider)
      // post a notice that starts no turn, so nobody may ever see it; those are marked and
      // the next `/autoresearch` repeats the reason.
      await ctx.storage.set(stoppedKey(sessionID), {
        reason,
        at: new Date().toISOString(),
        ...(how === "silent" ? { unseen: true } : {}),
      } as never)
      await (how === "tell" ? tell(sessionID, reason) : notify(sessionID, reason))
    }

    /** Other sessions with a loop on in this project. Only one loop per project is allowed. */
    const loopsIn = async (directory: string) => {
      const found: { sessionID: string; state: ActiveState }[] = []
      let after: string | undefined
      do {
        const page = await ctx.storage.scan({ prefix: "active/", after, limit: 100 })
        for (const { key, value } of page.entries) {
          const state = value as unknown as ActiveState
          if (state?.directory === directory) found.push({ sessionID: key.slice("active/".length), state })
        }
        after = page.next
      } while (after)
      return found
    }

    // The loops that were on when this copy of the plugin started, for the start-up continue
    // at the end of setup. Taken now, before any command can run: a loop that is turned on
    // later was started by its own prompt and must not get a second one from the timer.
    const loopsAtStart = new Map((await loopsIn(ctx.location.directory)).map(({ sessionID, state }) => [sessionID, state.since]))

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
    // Namespaced (autoresearch_init / _run / _log / _pause), as the plugin docs recommend, so
    // they can't collide with another plugin's tools. Commands and git changes are checked
    // with OpenCode's permission system first ("plugin tools enforce the permissions they
    // assert"); the asserted strings are the commands that really run.
    const host: Host = {
      storage: {
        get: (key) => ctx.storage.get(key),
        set: (key, value) => ctx.storage.set(key, JSON.parse(JSON.stringify(value)) as never),
        remove: (key) => ctx.storage.remove(key),
      },
      cwdOf,
      loopState,
      saveLoopState,
      stopLoop: (sessionID, reason) => stopLoop(sessionID, reason),
      assertShell: (context: ToolCtx, commands: string[], offerSave: boolean) =>
        ctx.permission.assert({
          sessionID: context.sessionID as never,
          agent: context.agent as never,
          source: { type: "tool", messageID: context.messageID, id: context.id },
          action: "shell",
          resources: commands,
          // No "always allow" offer for the commands that delete work (restore, clean).
          ...(offerSave ? { save: commands } : {}),
        }),
      setStatus: (cwd, status) => dashboards.setStatus(cwd, status),
    }

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "autoresearch",
        description: "Autonomous experiment loop: set up a session, measure, log (the plugin confirms and commits or reverts), pause.",
      })

      editor.add({
        name: "init",
        options: { namespace: "autoresearch" },
        description:
          "Start a segment of comparable runs: name, primary metric, unit, direction and how often each measurement repeats. " +
          "Freezes the benchmark (.auto/measure.sh, .auto/checks.sh and every helper file under .auto/ are hashed). Needs: the loop " +
          "on, a branch that isn't main/master, a clean working tree, an executable .auto/measure.sh, and measure.sh/checks.sh " +
          "committed. Call again only when the goal or the benchmark legitimately changes; that starts a new segment with a fresh baseline.",
        input: {
          type: "object",
          properties: {
            name: { type: "string", description: "Short session name, e.g. 'unit test runtime'" },
            metric_name: { type: "string", description: "Primary metric name as printed by measure.sh (METRIC <name>=...)" },
            metric_unit: { type: "string", description: "Unit, e.g. 's', 'ms', 'KB'" },
            direction: { type: "string", enum: ["lower", "higher"], description: "Which direction is better" },
            repeat: {
              type: "integer",
              minimum: 1,
              maximum: 50,
              description:
                "Benchmark runs per measurement, fixed for the segment (default 5). The median is used and the spread gives the noise. " +
                "A proposed keep costs about twice as many runs again (the last commit and the change, back to back). " +
                "Use 1–2 only when one run takes minutes; then a keep needs a fixed minimum gain instead.",
            },
          },
          required: ["name", "metric_name", "direction"],
          additionalProperties: false,
        },
        execute: (input, context) => initExperiment(host, input, context),
      })

      editor.add({
        name: "run",
        options: { namespace: "autoresearch" },
        description:
          "Measure the current code: runs ./.auto/measure.sh as often as the segment's `repeat` says, parses `METRIC name=value` " +
          "lines, then runs ./.auto/checks.sh if it exists. Tells you how the result compares with current and what to log. " +
          "Doesn't log; call autoresearch_log next, without changing files in between. Takes no command: the benchmark is fixed.",
        input: {
          type: "object",
          properties: {
            timeout_seconds: { type: "number", description: "Timeout per benchmark run (default 600)" },
            checks_timeout_seconds: { type: "number", description: "checks.sh timeout (default 300)" },
          },
          additionalProperties: false,
        },
        execute: (input, context) => runExperiment(host, input, context),
      })

      editor.add({
        name: "log",
        options: { namespace: "autoresearch" },
        description:
          "Record the last autoresearch_run (each run is logged once; the plugin records the measured numbers itself). " +
          "`keep` proposes to keep the change: the plugin measures the last commit and the change back to back (it swaps the files " +
          "itself and puts them back), and commits if the gain is confirmed, otherwise reverts and logs a discard. " +
          "`discard`, `crash` and `checks_failed` revert the code to the last commit (.auto/ is preserved). " +
          "Always include `asi` notes: what you learned, so a future agent doesn't repeat dead ends.",
        input: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["keep", "discard", "crash", "checks_failed"] },
            description: { type: "string", description: "One line: what this experiment changed" },
            asi: {
              type: "object",
              description: "Free-form notes for your future self, e.g. {hypothesis, learned, next_focus}",
              additionalProperties: true,
            },
            simplification: {
              type: "boolean",
              description:
                "With status keep: the change removes more lines than it adds (checked) and isn't meant to be faster. It's kept " +
                "when the back-to-back measurement shows it's not worse than the last commit beyond the noise, nor by more than minImprovement.",
            },
          },
          required: ["status", "description"],
          additionalProperties: false,
        },
        execute: (input, context) => logExperiment(host, input, context),
      })

      editor.add({
        name: "pause",
        options: { namespace: "autoresearch" },
        description:
          "Stop the loop and tell the user why. Use it when you're out of promising ideas, need the user's input or decision, " +
          "or a tool call ends in a permission error or rejection. Better than filler experiments.",
        input: {
          type: "object",
          properties: {
            reason: { type: "string", description: "For the user: why you're pausing and what you need from them" },
          },
          required: ["reason"],
          additionalProperties: false,
        },
        execute: (input, context) => pauseLoop(host, input, context),
      })
    })

    // ── /autoresearch command ──────────────────────────────

    /**
     * What must hold before the loop may be turned on, or a message saying exactly what to
     * do. In code, not in the skill: a resume on main with uncommitted work once wiped that
     * work with the first discard.
     */
    const preflight = async (cwd: string, resume: boolean): Promise<string | null> => {
      if (!(await headSha(cwd))) {
        return (
          "Autoresearch needs a git repository with at least one commit, because it commits what works and reverts what doesn't. " +
          "Commit the project first, then run `/autoresearch` again."
        )
      }
      const status = await scopeStatus(cwd)
      if (!status.ok) return `Couldn't check the working tree (git status failed):\n${tailLines(status.error, 10)}`
      if (status.status) {
        const lines = status.status.split("\n")
        return (
          "Not started: the working tree has uncommitted changes, and the loop reverts to the last commit after every failed experiment, " +
          "which would delete them.\n" +
          lines.slice(0, 15).join("\n") +
          (lines.length > 15 ? `\n… and ${lines.length - 15} more` : "") +
          "\nCommit them, or set them aside with `git stash -u`, then run `/autoresearch` again." +
          (resume ? " (If they're leftovers of an interrupted experiment, `git stash -u` is the safe way to clear them.)" : "")
        )
      }
      const branch = await currentBranch(cwd)
      const onTrunk = !branch || (await isTrunk(cwd, branch))
      if (!resume && onTrunk) {
        // No session files here, but they are committed on the experiment branch: this is
        // a resume from the wrong branch, not a new setup. (It used to start a second
        // setup on main while the session sat one `git switch` away.)
        const branches = await sessionBranches(cwd)
        if (branches.length) {
          return (
            `Not started: there are no session files on ${branch ? `\`${branch}\`` : "this detached HEAD"}, but an autoresearch session for this folder ` +
            `exists on \`${branches[0]}\`${branches.length > 1 ? ` (also: ${branches.slice(1).join(", ")})` : ""}. ` +
            `To continue it: \`git switch ${branches[0]}\`, then \`/autoresearch\` again. ` +
            "To start a separate new session instead: create its branch first (`git switch -c autoresearch/<goal>-<date>`) and run `/autoresearch <goal>` there."
          )
        }
      }
      if (resume) {
        if (onTrunk) {
          const list = await git(["branch", "--list", "autoresearch/*", "--format=%(refname:short)"], cwd)
          const branches = list.code === 0 ? list.output.split("\n").filter(Boolean) : []
          return (
            `Not resumed: ${branch ? `you're on \`${branch}\`, the main branch` : "HEAD is detached"}. Experiments run on their own branch. ` +
            (branches.length
              ? `Switch to it first (\`git switch ${branches.at(-1)}\`${branches.length > 1 ? `; others: ${branches.slice(0, -1).join(", ")}` : ""}), `
              : "Switch to the experiment branch first, ") +
            "then run `/autoresearch` again."
          )
        }
      }
      return null
    }

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
            await say(HELP_TEXT)
            return
          }

          // A keep's confirmation that was cut off (crash, restart) leaves the project's
          // files at the last commit and the experiment's files in git. Put them back before
          // anything below looks at the working tree; a clean-looking tree would be a lie.
          // (Nothing happens while a confirmation is running right now.)
          const recovery = sub.startsWith("dashboard") ? null : await recoverInterruptedSwap(host, await cwdOf(sessionID))
          const recoveryNote = recovery?.failed ?? recovery?.note

          // "stop", "pause"… mean off. (They used to be taken as a goal and resumed the loop.)
          if (OFF_WORDS.has(sub)) {
            const state = await loopState(sessionID)
            const unlogged = (await ctx.storage.get(runKey(sessionID))) as object | undefined
            if (state && unlogged && !state.stopping) {
              // An experiment is being measured or waits to be logged. Turning the tools off
              // now would leave its changes in the working tree with no way to commit or
              // revert them, so let the agent log this one run first.
              await saveLoopState(sessionID, { ...state, stopping: true })
              await say(
                "The loop stops as soon as the experiment in progress is logged (kept or reverted); no new one will start. " +
                  "`/autoresearch off` again stops right now and leaves its changes in the working tree.",
              )
              return
            }
            await deactivate(sessionID)
            await ctx.storage.remove(runKey(sessionID))
            const status = state ? await scopeStatus(state.directory) : undefined
            await say(
              "Loop turned off. .auto/log.jsonl is kept; `/autoresearch` resumes." +
                (recoveryNote ? ` ${recoveryNote}` : "") +
                (status?.ok && status.status
                  ? " The working tree has uncommitted changes (an unfinished experiment); `/autoresearch` won't resume until " +
                    "they're committed, stashed (`git stash -u`) or reverted."
                  : ""),
            )
            return
          }

          if (sub === "status") {
            await say((await statusText(sessionID)) + (recoveryNote ? `\nWarning: ${recoveryNote}` : ""))
            return
          }

          if (sub === "dashboard off" || sub === "dashboard close") {
            const closed = dashboards.close(await cwdOf(sessionID))
            await say(closed ? "Dashboard closed." : "No dashboard was open for this project.")
            return
          }

          if (sub === "dashboard") {
            const cwd = await cwdOf(sessionID)
            const wasOpen = dashboards.isOpen(cwd)
            const url = await dashboards.open(cwd)
            if (!wasOpen) openInBrowser(url) // don't open another tab every time
            const note = (await logExists(cwd)) ? "" : " No experiments yet; it fills in as they run."
            await say(`Live dashboard: ${url}${note}`)
            return
          }

          // Starting, resuming or finalizing on files that aren't the ones they seem: don't.
          if (recovery?.failed) {
            await say(`Not started: ${recovery.failed}`)
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

          // ── start or resume ──
          const cwd = await cwdOf(sessionID)

          // Already on in this session: the text is a note for the running loop. No
          // preflight (a dirty tree is normal mid-experiment) and no reset of the loop's
          // state or of a measured run. It also revives a loop that's waiting, and takes
          // back an `off` that hadn't taken effect yet.
          const running = await loopState(sessionID)
          if (running && running.directory === cwd) {
            await saveLoopState(sessionID, { ...running, stopping: undefined, stalls: 0, failures: 0 })
            await ctx.session.prompt({
              ...prompt,
              sessionID: sessionID as never,
              text: running.setup
                ? `${PLUGIN_PROMPT_PREFIX} The loop is already on (still setting up). ${arg ? `${USER_CONTEXT_LABEL} ${arg}` : "Continue the setup."}`
                : `${CONTINUE_PROMPT}${arg ? `\n\n${USER_CONTEXT_LABEL} ${arg}` : ""}`,
              delivery,
            })
            return
          }

          const setup = !existsSync(promptPath(cwd))
          const problem = await preflight(cwd, !setup)
          if (problem) {
            // E.g. "uncommitted changes": if those are the experiment that was just put back, say so.
            await say(problem + (recovery?.note ? `\n${recovery.note}` : ""))
            return
          }
          const entries = await readLog(cwd)
          const runCount = countRuns(entries)

          // Already at the run limit: say so instead of turning on a loop that can't run.
          if (!setup) {
            const { maxIterations } = await readSettings(cwd)
            if (runCount >= maxIterations) {
              await say(
                `${runCount}/${maxIterations} runs are already logged (maxIterations). Raise maxIterations in ` +
                  ".auto/config.json to continue, or run `/autoresearch finalize` to turn the results into branches.",
              )
              return
            }
          }

          // One loop per project: two would edit the same files and number runs twice.
          for (const other of await loopsIn(cwd)) {
            if (other.sessionID === sessionID) continue
            await deactivate(other.sessionID)
            await ctx.storage.remove(runKey(other.sessionID))
            await notify(other.sessionID, "Loop turned off here: another session started autoresearch in this project.")
          }

          // A measurement from before this start describes a tree that's gone (the tree is
          // clean now); it must not be logged.
          await ctx.storage.remove(runKey(sessionID))
          const stopped = (await ctx.storage.get(stoppedKey(sessionID))) as { reason?: string; at?: string; unseen?: boolean } | undefined
          await ctx.storage.remove(stoppedKey(sessionID))
          const state: ActiveState = {
            directory: cwd,
            startRunCount: runCount,
            lastRunCount: runCount,
            stalls: 0,
            failures: 0,
            ...(setup
              ? { setup: true, setupConfigs: entries.filter((e) => e.type === "config").length }
              : // On resume the loop is tied to this branch and commit right away. In setup the
                // agent still creates the branch; autoresearch_init records it.
                { branch: (await currentBranch(cwd))!, head: (await headSha(cwd))! }),
          }
          await activate(sessionID, state)
          // Delivered with the turn the prompt below starts.
          if (recovery?.note) await notify(sessionID, recovery.note)
          if (stopped?.unseen && stopped.reason) {
            await notify(sessionID, `For the record, why the loop had stopped before this start (${stopped.at ?? "?"}): ${stopped.reason}`)
          }

          // The skill is attached on resume too: it explains the rules, and a resumed
          // session (or one whose context was compacted) may never have seen it.
          const skills = [...(prompt.skills ?? []), { id: Skill.ID.make(SKILL_ID) }]
          await ctx.session.prompt({
            ...prompt,
            sessionID: sessionID as never,
            text: setup
              ? `Set up and start an autoresearch session. Goal: ${arg || "(ask me)"}`
              : `${CONTINUE_PROMPT}${arg ? `\n\n${USER_CONTEXT_LABEL} ${arg}` : ""}`,
            skills,
            delivery,
          })
        },
      })
    })

    /**
     * `/autoresearch status`: the whole session (one line per segment, then totals), the
     * limits, and anything that needs attention.
     */
    const statusText = async (sessionID: string) => {
      const cwd = await cwdOf(sessionID)
      const state = await loopState(sessionID)
      const entries = await readLog(cwd)
      const { config } = currentSegment(entries)
      const settings = await readSettings(cwd)
      const warnings = [...settings.warnings]
      const lines = [
        `Loop: ${!state ? "off" : state.stopping ? "ON, stopping after the experiment in progress" : state.setup ? "ON (setting up)" : "ON"}` +
          (state?.branch ? ` · branch ${state.branch}` : ""),
      ]
      if (config) {
        const segments = segmentSummaries(entries)
        const repeat = config.repeat ?? 1
        lines.push(
          `Session: ${config.name} · ${config.metric_name} (${config.direction} is better) · ${repeat} benchmark run${repeat > 1 ? "s" : ""} per measurement, ` +
            `${confirmationRuns(repeat)} more to confirm a keep`,
        )
        // Every segment, not only the current one: after a benchmark change the earlier
        // segments' kept experiments are still in the branch, and showing only the last
        // segment made a session look like it had achieved nothing.
        for (const seg of segments) {
          lines.push(
            `Segment ${seg.config.segment} "${seg.config.name}"${seg.config.segment === config.segment ? " (current)" : ""}: ` +
              `${seg.runs} run${seg.runs === 1 ? "" : "s"}, ${progressText(seg)}`,
          )
        }
        const kept = segments.reduce((sum, seg) => sum + seg.kept, 0)
        lines.push(
          `Runs: ${countRuns(entries)}/${settings.maxIterations} in total · ${kept} kept experiment${kept === 1 ? "" : "s"}` +
            (segments.length > 1 ? ` in ${segments.length} segments (gains of different segments aren't combined: their benchmarks differ)` : ""),
          `Limits: maxIterations ${settings.maxIterations} · maxNoImprovement ${settings.maxNoImprovement}` +
            (state ? ` (now ${noImprovementStreak(entries, state.startRunCount)} runs without a keep since the loop was last started)` : "") +
            ` · minImprovement ${settings.minImprovement * 100}% (the gain a keep needs when a measurement has fewer than 3 runs, and the most a simplification may cost)`,
        )
        const inputs = await frozenInputs(autoDir(cwd))
        const drift = benchmarkDrift(config, {
          measure: await fileHash(measurePath(cwd)),
          checks: await fileHash(checksPath(cwd)),
          inputs: inputs.hash,
          inputFiles: inputs.files,
        })
        if (drift) {
          warnings.push(`The benchmark files differ from what this segment was started with (${drift}); the next run will be refused until autoresearch_init starts a new segment.`)
        }
        if (!config.checks_hash) warnings.push("No .auto/checks.sh: kept experiments aren't checked for correctness.")
      } else {
        lines.push(existsSync(promptPath(cwd)) ? "Set up, but no experiments yet." : "No session in this project yet.")
      }
      if (state?.branch) {
        const branch = await currentBranch(cwd)
        if (branch !== state.branch) warnings.push(`The checked-out branch is ${branch ?? "a detached HEAD"}, not ${state.branch}; the loop will pause at its next step.`)
      }
      if (!state) {
        // Why the loop last stopped. Stop notices are posted without starting a turn, so
        // this is where the user can always find the reason.
        const stopped = (await ctx.storage.get(stoppedKey(sessionID))) as { reason?: string; at?: string } | undefined
        if (stopped?.reason) lines.push(`Last stop (${stopped.at ?? "?"}): ${stopped.reason}`)
      }
      if (state?.failures) warnings.push(`The last ${state.failures} turn${state.failures > 1 ? "s" : ""} failed (provider error); retrying.`)
      for (const w of warnings) lines.push(`Warning: ${w}`)
      const url = dashboards.isOpen(cwd)
      lines.push(url ? `Dashboard: ${url}` : "Dashboard: closed (`/autoresearch dashboard` opens it)")
      return lines.join("\n")
    }

    // ── Compaction ─────────────────────────────────────────
    // While the loop is on, write the compaction summary from .auto/ instead of letting
    // the model summarize the chat (see compaction.ts for why). Setting event.result
    // skips the model call. Sessions without an active loop are left untouched.
    await ctx.session.hook("compaction", async (event) => {
      const state = await loopState(event.sessionID)
      if (!state || !ownsSession(state)) return
      try {
        const userMessages = event.messages.flatMap((m) =>
          m.role === "user"
            ? [m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n")]
            : [],
        )
        // What's in flight right now. Compaction usually happens mid-experiment; without
        // this the summary says "start the next experiment" on top of uncommitted edits.
        const status = await scopeStatus(state.directory)
        const stored = (await ctx.storage.get(runKey(event.sessionID))) as PendingRun | { running: true } | undefined
        const pendingRun = !stored
          ? undefined
          : "running" in stored
            ? "autoresearch_run was in progress (or was interrupted); it has no result. Run it again before logging."
            : `measured but not logged yet: ${stored.metric === null ? "the benchmark failed" : `first measurement ${fmt(stored.metric)}`}` +
              `${stored.checks === "failed" ? ", checks failed" : ""}. Call autoresearch_log for it before anything else, without changing files.`
        const summary = await buildCompactionSummary(state.directory, userMessages, {
          workingTree: status.ok ? status.status : undefined,
          pendingRun,
        })
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
    // on OpenCode 2.2.5. The SDK's `experimental.idle` hook might replace this one day;
    // the event is the path that was verified live.)
    const controller = new AbortController()
    const inFlight = new Set<string>()

    // A synthetic (plugin-originated) input, not a fake user message: the docs list
    // synthetic for plugin input, and it doesn't run other plugins' user-prompt hooks.
    const sendContinue = (sessionID: string, text = CONTINUE_PROMPT) =>
      ctx.session.synthetic({ sessionID: sessionID as never, text, delivery: "queue" })

    const onTurnEnd = async (sessionID: string) => {
      if (inFlight.has(sessionID)) return
      inFlight.add(sessionID)
      try {
        let state = await loopState(sessionID)
        if (!state || !ownsSession(state)) return
        clearRetry(sessionID)
        if (controller.signal.aborted) return // plugin is unloading (e.g. reload); the new copy takes over

        // `/autoresearch off` during an experiment, and the turn ended without logging it.
        if (state.stopping) {
          const status = await scopeStatus(state.directory)
          await ctx.storage.remove(runKey(sessionID))
          await stopLoop(
            sessionID,
            "Loop turned off." +
              (status.ok && status.status
                ? " The experiment in progress wasn't logged, so its changes are still in the working tree; `/autoresearch` " +
                  "won't resume until they're committed, stashed (`git stash -u`) or reverted."
                : ""),
            "tell",
          )
          return
        }

        const entries = await readLog(state.directory)
        const runCount = countRuns(entries)
        // While setting up, the agent may be waiting for the user's answers; nudging would
        // push past those questions. Setup is over once prompt.md and a config entry from
        // this setup exist. (It used to last until the first logged run, and a turn ending
        // between those two points left the loop "on" but silent forever.)
        if (state.setup) {
          const configs = entries.filter((e) => e.type === "config").length
          if (!existsSync(promptPath(state.directory)) || configs <= (state.setupConfigs ?? 0)) {
            if (state.failures) await saveLoopState(sessionID, { ...state, failures: 0 })
            return
          }
          state = { ...state, setup: undefined }
        }

        const limit = limitReached(entries, state, await readSettings(state.directory))
        const stalls = runCount > state.lastRunCount ? 0 : state.stalls + 1
        if (limit || stalls >= MAX_STALLS) {
          // Shown right away (the user wants to know why the loop ended); costs one short reply.
          await stopLoop(
            sessionID,
            limit ? `Loop stopped: ${limit}` : `Loop paused: no experiment was logged in ${MAX_STALLS} turns. \`/autoresearch\` resumes it.`,
            "tell",
          )
          return
        }

        // `/autoresearch off` may have landed while we were reading; don't bring the loop back.
        if (!(await loopState(sessionID)) || controller.signal.aborted) return
        await saveLoopState(sessionID, { ...state, lastRunCount: runCount, stalls, failures: 0 })
        await sendContinue(sessionID)
      } catch (err) {
        console.error("[autoresearch] turn-end handler failed:", err)
      } finally {
        inFlight.delete(sessionID)
      }
    }

    /**
     * A turn failed (provider or model error, after OpenCode's own retries). Unattended,
     * that used to be the end of the night's run. Now: wait, send the continue again, with
     * growing delays; give up only after several failures in a row.
     * (The SDK's `retry` session hook isn't used: it decides retries of single model
     * requests inside a turn, not what happens once a turn has failed.)
     */
    const onTurnFailed = async (sessionID: string, message: string) => {
      const state = await loopState(sessionID)
      if (!state || !ownsSession(state) || controller.signal.aborted) return
      clearRetry(sessionID)
      const failures = (state.failures ?? 0) + 1
      const delay = timing.retryDelaysMs[failures - 1]
      if (delay === undefined) {
        // No turn is started for this notice: it would only fail again.
        await stopLoop(
          sessionID,
          `Loop paused: ${failures} turns in a row failed${message ? ` (last error: ${message.slice(0, 300)})` : ""}. ` +
            "Check the provider or model, then `/autoresearch` resumes.",
          "silent",
        )
        return
      }
      await saveLoopState(sessionID, { ...state, failures })
      retryTimers.set(
        sessionID,
        setTimeout(() => {
          retryTimers.delete(sessionID)
          void (async () => {
            // The loop may have been turned off, or a turn may have succeeded, while waiting.
            const now = await loopState(sessionID)
            if (!now || now.failures !== failures || controller.signal.aborted) return
            await sendContinue(sessionID, now.setup ? RETRY_PROMPT : `${RETRY_PROMPT} ${CONTINUE_PROMPT.slice(PLUGIN_PROMPT_PREFIX.length + 1)}`)
          })().catch((err) => console.error("[autoresearch] retry failed:", err))
        }, delay),
      )
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
          } else if (event.type === "session.execution.failed") {
            const message = String((event.data as { error?: { message?: unknown } }).error?.message ?? "")
            void onTurnFailed(sessionID, message).catch((err) => console.error("[autoresearch] failure handler failed:", err))
          } else {
            const state = await loopState(sessionID)
            if (!state || !ownsSession(state)) continue
            // The user pressed stop: respect it and turn the loop off.
            await stopLoop(sessionID, "Loop turned off because the session was stopped. `/autoresearch` resumes it.", "silent")
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) console.error("[autoresearch] event stream ended:", err)
      }
    })()

    // After a restart or plugin reload nothing would end a turn, so nothing would send the
    // next continue: the loop would sit "on" and silent. Send one continue for each loop
    // this copy owns. Queued, so if a turn is in fact still running it's handled after it.
    // Loops in setup are skipped: there the agent may be waiting for the user.
    //
    // Only loops that were on when this copy started (loopsAtStart), and only if the same
    // activation is still on when the timer fires. In a freshly loaded project the command
    // turned the loop on moments after the plugin loaded; the timer then sent a second
    // continue, which arrived after the agent had paused: "The loop is ON now" on a paused loop.
    const startup = setTimeout(() => {
      void (async () => {
        // A restart may have cut off a keep's confirmation: put the experiment's files back
        // first, or the agent would be told to carry on over a tree that only looks clean.
        const recovery = await recoverInterruptedSwap(host, ctx.location.directory)
        for (const [sessionID, since] of loopsAtStart) {
          if (controller.signal.aborted) return
          const state = await loopState(sessionID)
          if (!state || !ownsSession(state) || state.since !== since) continue
          if (recovery?.failed) {
            await stopLoop(sessionID, `Loop paused: ${recovery.failed}`, "tell")
            continue
          }
          if (state.setup || state.stopping) continue
          await sendContinue(sessionID, recovery?.note ? `${CONTINUE_PROMPT}\n\n${recovery.note}` : CONTINUE_PROMPT)
        }
      })().catch((err) => console.error("[autoresearch] couldn't continue loops after start:", err))
    }, timing.startupDelayMs)

    return () => {
      controller.abort()
      clearTimeout(startup)
      for (const timer of retryTimers.values()) clearTimeout(timer)
      retryTimers.clear()
      dashboards.closeAll()
    }
  },
})
