// The whole plugin, driven through a small fake of OpenCode's plugin context against real
// git repos. Each case is a way the earlier version could be made to lie about a result or
// to damage the user's work (see docs/design.md).

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { swapKey } from "./experiment.ts"
import plugin from "./index.ts"
import { timing } from "./timing.ts"
import { headTree, swapScope } from "./shell.ts"
import type { ConfigEntry, RunEntry } from "./state.ts"

// A keep is about ten benchmark runs and a few dozen git calls; on a busy machine several
// of them in one test pass bun's 5 s default.
setDefaultTimeout(60_000)

const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" })

// The benchmark reads its numbers from .bench/ (gitignored, so setting them changes neither
// the measured tree nor the frozen files under .auto/): each call takes the next line of
// .bench/queue, or .bench/value when the queue is empty. "CODE" means: the number in the
// tracked file perf.txt, so the result depends on which tree is checked out (that's how the
// tests see what a paired confirmation measured). "FAIL" exits 1; "NONE" prints no metric.
// Every call appends "run <perf.txt>" to .bench/calls; .bench/sleep slows a run down.
const MEASURE = `#!/bin/bash
b=.bench; mkdir -p $b
q=$b/queue
if [ -s "$q" ]; then v=$(head -n1 "$q"); tail -n +2 "$q" > "$q.tmp"; mv "$q.tmp" "$q"; else v=$(cat $b/value); fi
echo "run $(cat perf.txt 2>/dev/null)" >> $b/calls
[ -f $b/sleep ] && sleep "$(cat $b/sleep)"
[ "$v" = CODE ] && v=$(cat perf.txt)
[ "$v" = FAIL ] && { echo boom; exit 1; }
[ "$v" = NONE ] && exit 0
echo "METRIC ms=$v"
echo "METRIC extra=7"
`

/** Fill a project folder: code, a gitignore, and .auto/ with prompt.md and measure.sh. */
function project(dir: string, measure = MEASURE) {
  writeFileSync(join(dir, "code.txt"), "v1\n")
  writeFileSync(join(dir, "perf.txt"), "100\n")
  writeFileSync(join(dir, "lib.txt"), "a\nb\nc\nd\ne\n")
  writeFileSync(join(dir, "old-name.txt"), "a file that gets renamed\n")
  writeFileSync(join(dir, "tool.sh"), "#!/bin/sh\n")
  writeFileSync(join(dir, ".gitignore"), "ignored/\n.bench/\n")
  mkdirSync(join(dir, ".auto"))
  writeFileSync(join(dir, ".auto", "prompt.md"), "rules\n")
  writeFileSync(join(dir, ".auto", "measure.sh"), measure)
  chmodSync(join(dir, ".auto", "measure.sh"), 0o755)
}

/** A committed project on an experiment branch, with .auto/prompt.md and measure.sh committed. */
function repo(opts: { branch?: string; measure?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ar-plugin-"))
  g(dir, "init", "-q", "-b", "main")
  g(dir, "config", "user.email", "t@t")
  g(dir, "config", "user.name", "t")
  project(dir, opts.measure)
  g(dir, "add", "-A")
  g(dir, "commit", "-qm", "init")
  if (opts.branch !== "main") g(dir, "checkout", "-q", "-b", opts.branch ?? "autoresearch/test")
  mkdirSync(join(dir, ".bench"))
  writeFileSync(join(dir, ".bench", "value"), "100\n")
  return dir
}

const setValue = (dir: string, v: string | number) => writeFileSync(join(dir, ".bench", "value"), `${v}\n`)
const setQueue = (dir: string, values: (string | number)[]) => writeFileSync(join(dir, ".bench", "queue"), values.map((v) => `${v}\n`).join(""))
/** The perf.txt content each benchmark call saw, in order. */
const seen = (dir: string) =>
  existsSync(join(dir, ".bench", "calls")) ? readFileSync(join(dir, ".bench", "calls"), "utf8").split("\n").filter(Boolean).map((l) => l.slice(4)) : []
const calls = (dir: string) => seen(dir).length
/** Make the code "faster": the benchmark prints perf.txt when the value is CODE. */
const setPerf = (dir: string, v: number) => {
  setValue(dir, "CODE")
  writeFileSync(join(dir, "perf.txt"), `${v}\n`)
}
/** Commit benchmark files, as the agent must before autoresearch_init. */
const commitBenchmark = (dir: string) => {
  g(dir, "add", ".auto/measure.sh")
  if (existsSync(join(dir, ".auto", "checks.sh"))) g(dir, "add", ".auto/checks.sh")
  g(dir, "commit", "-qm", "autoresearch: benchmark")
}
const logOf = (dir: string) =>
  existsSync(join(dir, ".auto", "log.jsonl"))
    ? readFileSync(join(dir, ".auto", "log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : []
const runsOf = (dir: string) => logOf(dir).filter((e) => e.type === "run") as RunEntry[]
const head = (dir: string) => g(dir, "rev-parse", "HEAD").trim()

const cleanups: (() => unknown)[] = []
afterAll(async () => {
  for (const c of cleanups) await c()
})

/** Boot the plugin for one project. `sessions` maps session IDs to their folders. */
async function boot(locationDir: string, sessions: Record<string, string>, shared?: Map<string, any>) {
  const storage = shared ?? new Map<string, any>()
  const tools: Record<string, any> = {}
  const commands: Record<string, any> = {}
  const hooks: Record<string, any> = {}
  const sent: any[] = []
  const queue: any[] = []
  let wake: (() => void) | null = null
  let denied: RegExp | null = null
  const ctx: any = {
    location: { directory: locationDir },
    storage: {
      get: async (k: string) => storage.get(k),
      set: async (k: string, v: any) => void storage.set(k, JSON.parse(JSON.stringify(v))),
      remove: async (k: string) => void storage.delete(k),
      scan: async ({ prefix }: any) => ({
        entries: [...storage].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })),
      }),
    },
    session: {
      get: async ({ sessionID }: any) => ({ location: { directory: sessions[sessionID] } }),
      instructions: {
        entry: {
          put: async (x: any) => void sent.push({ kind: "instruction", ...x }),
          remove: async () => {},
        },
      },
      synthetic: async (x: any) => void sent.push({ kind: "synthetic", ...x }),
      prompt: async (x: any) => void sent.push({ kind: "prompt", ...x }),
      hook: async (name: string, fn: any) => void (hooks[name] = fn),
    },
    skill: { transform: async (fn: any) => fn({ add() {} }) },
    tool: { transform: async (fn: any) => fn({ namespace() {}, add(t: any) { tools[t.name] = t } }) },
    command: { transform: async (fn: any) => fn({ add(c: any) { commands[c.name] = c } }) },
    permission: {
      assert: async (x: any) => {
        sent.push({ kind: "assert", resources: x.resources, save: x.save })
        if (denied && x.resources.some((r: string) => denied!.test(r))) throw new Error("Permission denied")
      },
    },
    event: {
      subscribe: ({ signal }: any) => ({
        async *[Symbol.asyncIterator]() {
          while (!signal.aborted) {
            while (queue.length) yield queue.shift()
            await new Promise<void>((r) => {
              wake = r
              signal.addEventListener("abort", () => r(), { once: true })
            })
          }
        },
      }),
    },
  }
  const cleanup = await (plugin as any).setup(ctx)
  cleanups.push(cleanup)
  const tctx = (sessionID: string, signal: AbortSignal = new AbortController().signal) => ({
    sessionID,
    agent: "a",
    messageID: "m",
    id: "c",
    signal,
    progress: async () => {},
  })
  const text = async (p: Promise<{ content: string }>) => (await p).content
  return {
    storage,
    sent,
    cleanup,
    hooks,
    tools,
    deny: (pattern: RegExp | null) => (denied = pattern),
    emit: (type: string, sessionID: string, data: object = {}) => {
      queue.push({ type, data: { sessionID, ...data } })
      wake?.()
    },
    init: (sid: string, i: any = {}) =>
      text(tools.init.execute({ name: "t", metric_name: "ms", direction: "lower", repeat: 3, ...i }, tctx(sid))),
    run: (sid: string, i: any = {}) => text(tools.run.execute(i, tctx(sid))),
    log: (sid: string, i: any, signal?: AbortSignal) => text(tools.log.execute({ description: "an experiment", ...i }, tctx(sid, signal))),
    pause: (sid: string, reason: string) => text(tools.pause.execute({ reason }, tctx(sid))),
    cmd: (sid: string, text: string) => commands.autoresearch.execute({ sessionID: sid, prompt: { text }, delivery: "queue" }),
    /** Texts of everything the plugin posted to a session. */
    said: (sid: string) => sent.filter((s) => (s.kind === "synthetic" || s.kind === "prompt") && s.sessionID === sid).map((s) => String(s.text)),
    active: (sid: string) => storage.get(`active/${sid}`),
  }
}

/** A booted plugin with the loop on in session "s" (resume path: prompt.md exists). */
async function started(opts: Parameters<typeof repo>[0] = {}) {
  const dir = repo(opts)
  const p = await boot(dir, { s: dir })
  await p.cmd("s", "make it faster")
  return { dir, p }
}

/** Loop on, segment initialised, baseline (100) logged. */
async function withBaseline(opts: Parameters<typeof repo>[0] = {}, init: any = {}) {
  const { dir, p } = await started(opts)
  expect(await p.init("s", init)).toContain("Initialized")
  expect(await p.run("s")).toContain("baseline")
  expect(await p.log("s", { status: "keep", description: "baseline" })).toContain("logged as the baseline")
  return { dir, p }
}

async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting")
    await new Promise((r) => setTimeout(r, 10))
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── Safety: where and when the tools work at all ──────────

describe("the tools only work while the loop is on", () => {
  test("loop off: init, run and log refuse and change nothing", async () => {
    const dir = repo()
    const p = await boot(dir, { s: dir })
    writeFileSync(join(dir, "code.txt"), "the user's uncommitted work\n")
    for (const out of [await p.init("s"), await p.run("s"), await p.log("s", { status: "discard" })]) {
      expect(out).toContain("ERROR")
      expect(out).toContain("loop is off")
    }
    expect(readFileSync(join(dir, "code.txt"), "utf8")).toBe("the user's uncommitted work\n")
    expect(logOf(dir)).toEqual([])
  })

  test("a loop in another session of the project doesn't enable the tools here", async () => {
    const dir = repo()
    const p = await boot(dir, { s: dir, other: dir })
    await p.cmd("s", "goal")
    expect(await p.init("other")).toContain("loop is off")
  })

  test("/autoresearch off turns them off again", async () => {
    const { p } = await withBaseline()
    await p.cmd("s", "off")
    expect(p.active("s")).toBeUndefined()
    expect(await p.run("s")).toContain("loop is off")
  })
})

describe("/autoresearch preflight", () => {
  test("refuses to start or resume over uncommitted changes, and says what to do", async () => {
    const dir = repo()
    const p = await boot(dir, { s: dir })
    writeFileSync(join(dir, "code.txt"), "user work\n")
    writeFileSync(join(dir, "untracked.txt"), "user file\n")
    await p.cmd("s", "goal")
    expect(p.active("s")).toBeUndefined()
    const said = p.said("s").join("\n")
    expect(said).toContain("uncommitted changes")
    expect(said).toContain("code.txt")
    expect(said).toContain("untracked.txt")
    expect(said).toContain("git stash -u")
    expect(p.sent.some((s) => s.kind === "prompt")).toBe(false)
  })

  test("changes inside .auto/ don't count as a dirty tree", async () => {
    const dir = repo()
    const p = await boot(dir, { s: dir })
    writeFileSync(join(dir, ".auto", "ideas.md"), "- idea\n")
    await p.cmd("s", "goal")
    expect(p.active("s")).toBeDefined()
  })

  test("refuses to resume on trunk and names the experiment branch", async () => {
    const dir = repo()
    g(dir, "checkout", "-q", "main")
    const p = await boot(dir, { s: dir })
    await p.cmd("s", "goal")
    expect(p.active("s")).toBeUndefined()
    const said = p.said("s").join("\n")
    expect(said).toContain("main")
    expect(said).toContain("git switch autoresearch/test")
  })

  test("setup (no prompt.md) may start on trunk: the agent creates the branch; no git repo is refused", async () => {
    const dir = repo({ branch: "main" })
    rmSync(join(dir, ".auto", "prompt.md"))
    g(dir, "commit", "-qam", "no prompt")
    const p = await boot(dir, { s: dir })
    await p.cmd("s", "goal")
    expect(p.active("s")).toMatchObject({ setup: true })
    expect(p.active("s").branch).toBeUndefined()

    const plain = mkdtempSync(join(tmpdir(), "ar-plain-"))
    const q = await boot(plain, { s: plain })
    await q.cmd("s", "goal")
    expect(q.active("s")).toBeUndefined()
    expect(q.said("s").join("\n")).toContain("git repository")
  })

  test("resume attaches the create skill and records branch and HEAD", async () => {
    const { dir, p } = await started()
    const prompt = p.sent.find((s) => s.kind === "prompt")
    expect(prompt.skills).toEqual([{ id: "autoresearch-create" }])
    expect(prompt.text).toContain("Continue the experiment loop")
    expect(prompt.text).toContain("make it faster")
    expect(p.active("s")).toMatchObject({ branch: "autoresearch/test", head: head(dir), failures: 0 })
    const pinned = p.sent.find((s) => s.kind === "instruction").value as string
    expect(pinned).toContain("autoresearch_pause")
    expect(pinned).toContain("No cheating")
    expect(pinned).not.toContain("until the user stops")
  })

  test("/autoresearch <text> while the loop is on passes the note on and leaves the experiment in progress alone", async () => {
    const { dir, p } = await withBaseline()
    setPerf(dir, 90) // dirty tree: normal mid-experiment
    await p.run("s")
    await p.cmd("s", "off") // → stopping
    p.sent.length = 0
    await p.cmd("s", "also try the parser")
    expect(p.said("s").join("\n")).not.toContain("Not started")
    const prompt = p.sent.find((s) => s.kind === "prompt")
    expect(prompt.text).toContain("also try the parser")
    expect(p.active("s").stopping).toBeUndefined()
    expect(p.storage.get("run/s")).toBeDefined()
    expect(await p.log("s", { status: "keep" })).toContain("logged as keep")
    expect(p.active("s")).toBeDefined()
  })

  test("setup mode with an old log: run and log refuse until init has tied the loop to a branch", async () => {
    const { dir, p } = await withBaseline()
    await p.cmd("s", "off")
    g(dir, "checkout", "-q", "-b", "feature/other")
    rmSync(join(dir, ".auto", "prompt.md"))
    g(dir, "commit", "-qam", "prompt removed")
    await p.cmd("s", "new goal") // setup mode, on another branch, config entry exists
    expect(p.active("s")).toMatchObject({ setup: true })
    writeFileSync(join(dir, "code.txt"), "edit on the other branch\n")
    expect(await p.run("s")).toContain("call autoresearch_init first")
    expect(await p.log("s", { status: "discard" })).toContain("call autoresearch_init first")
    expect(readFileSync(join(dir, "code.txt"), "utf8")).toBe("edit on the other branch\n")
  })
})

describe("autoresearch_init preflight", () => {
  test("refuses on trunk", async () => {
    // Setup mode lets the loop start on main; init is where the branch is enforced.
    const dir = repo({ branch: "main" })
    const p = await boot(dir, { s: dir })
    p.storage.set("active/s", { directory: dir, setup: true, startRunCount: 0, lastRunCount: 0, stalls: 0, failures: 0 })
    const out = await p.init("s")
    expect(out).toContain("ERROR")
    expect(out).toContain("main")
    expect(out).toContain("git switch -c autoresearch/")
    expect(logOf(dir)).toEqual([])
  })

  test("refuses on a detached HEAD", async () => {
    const dir = repo()
    const p = await boot(dir, { s: dir })
    p.storage.set("active/s", { directory: dir, setup: true, startRunCount: 0, lastRunCount: 0, stalls: 0, failures: 0 })
    g(dir, "checkout", "-q", "--detach")
    expect(await p.init("s")).toContain("detached")
  })

  test("refuses on a dirty tree and leaves the changes alone", async () => {
    const { dir, p } = await started()
    writeFileSync(join(dir, "code.txt"), "edited\n")
    writeFileSync(join(dir, "new.txt"), "n\n")
    const out = await p.init("s")
    expect(out).toContain("uncommitted changes")
    expect(out).toContain("new.txt")
    expect(readFileSync(join(dir, "code.txt"), "utf8")).toBe("edited\n")
    expect(logOf(dir)).toEqual([])
  })

  test("refuses when git tracks nothing in the folder (an untracked project inside a bigger repo)", async () => {
    const outer = repo()
    const dir = join(outer, "project")
    mkdirSync(join(dir, ".auto"), { recursive: true })
    writeFileSync(join(dir, "app.js"), "1\n")
    writeFileSync(join(dir, ".auto", "prompt.md"), "rules\n")
    writeFileSync(join(dir, ".auto", "measure.sh"), MEASURE)
    chmodSync(join(dir, ".auto", "measure.sh"), 0o755)
    const p = await boot(dir, { s: dir })
    // The command already refuses (the folder shows up as untracked files)…
    await p.cmd("s", "goal")
    expect(p.active("s")).toBeUndefined()
    // …and init refuses on its own, too.
    p.storage.set("active/s", { directory: dir, startRunCount: 0, lastRunCount: 0, stalls: 0, failures: 0 })
    const out = await p.init("s")
    expect(out).toContain("tracks no files")
    expect(existsSync(join(dir, "app.js"))).toBe(true)
  })

  test("refuses without an executable measure.sh, and with a bad repeat", async () => {
    const { dir, p } = await started()
    chmodSync(join(dir, ".auto", "measure.sh"), 0o644)
    expect(await p.init("s")).toContain("isn't executable")
    rmSync(join(dir, ".auto", "measure.sh"))
    expect(await p.init("s")).toContain("doesn't exist")
    expect(await p.init("s", { repeat: 0 })).toContain("repeat")
    expect(await p.init("s", { repeat: 2.5 })).toContain("repeat")
  })

  test("writes the config entry with repeat and the benchmark hashes; repeat defaults to 5", async () => {
    const { dir, p } = await started()
    writeFileSync(join(dir, ".auto", "checks.sh"), "#!/bin/bash\nexit 0\n")
    chmodSync(join(dir, ".auto", "checks.sh"), 0o755)
    commitBenchmark(dir)
    await p.init("s", { repeat: undefined })
    const config = logOf(dir)[0] as ConfigEntry
    expect(config).toMatchObject({ type: "config", segment: 1, name: "t", metric_name: "ms", direction: "lower", repeat: 5 })
    expect(config.measure_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(config.checks_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(config.inputs_hash).toMatch(/^[0-9a-f]{64}$/)
  })
})

// ── Truth: what a keep means ──────────────────────────────

describe("baseline", () => {
  test("a baseline on a dirty tree is refused", async () => {
    const { dir, p } = await started()
    await p.init("s")
    writeFileSync(join(dir, "code.txt"), "already changed\n")
    const out = await p.run("s")
    expect(out).toContain("ERROR")
    expect(out).toContain("baseline must be measured on unchanged code")
    expect(calls(dir)).toBe(0) // not even measured
    expect(readFileSync(join(dir, "code.txt"), "utf8")).toBe("already changed\n")
  })

  test("baseline: one uncounted warm-up run, logged as keep with baseline: true and no commit", async () => {
    const { dir, p } = await started()
    await p.init("s")
    setQueue(dir, [500, 100, 101, 99]) // the warm-up (500) must not count
    const before = head(dir)
    const out = await p.run("s")
    expect(out).toContain("ms: 100")
    expect(out).toContain("samples: 100, 101, 99")
    expect(calls(dir)).toBe(4)
    expect(await p.log("s", { status: "keep", description: "baseline" })).toContain("baseline")
    expect(head(dir)).toBe(before)
    expect(runsOf(dir)).toHaveLength(1)
    expect(runsOf(dir)[0]).toMatchObject({
      status: "keep",
      baseline: true,
      metric: 100,
      samples: [100, 101, 99],
      noise: 1,
      commit: null,
      confidence: null,
      metrics: { extra: 7 },
      run: 1,
      segment: 1,
    })
  })

  test("a crashed baseline can be logged as crash; the next clean run is still the baseline", async () => {
    const { dir, p } = await started()
    await p.init("s")
    setValue(dir, "FAIL")
    expect(await p.run("s")).toContain("exited with code 1")
    expect(await p.log("s", { status: "keep" })).toContain("can't be kept")
    await p.log("s", { status: "crash" })
    setValue(dir, 100)
    expect(await p.run("s")).toContain("This is the baseline")
    await p.log("s", { status: "keep" })
    expect(runsOf(dir).map((r) => [r.status, r.baseline ?? false, r.metric])).toEqual([
      ["crash", false, null],
      ["keep", true, 100],
    ])
  })
})

describe("keep", () => {
  test("a confirmed keep commits exactly the measured tree, with the confirmation samples as its result", async () => {
    const { dir, p } = await withBaseline()
    // A failing hook and forced signing would block a normal commit.
    const hook = join(dir, ".git", "hooks", "pre-commit")
    writeFileSync(hook, "#!/bin/sh\nexit 1\n")
    chmodSync(hook, 0o755)
    g(dir, "config", "commit.gpgsign", "true")
    g(dir, "config", "gpg.program", "/nonexistent/gpg")

    writeFileSync(join(dir, "code.txt"), "v2 faster\n")
    writeFileSync(join(dir, "new-file.txt"), "new\n")
    mkdirSync(join(dir, "ignored"))
    writeFileSync(join(dir, "ignored", "cache"), "x\n")
    // first measurement · HEAD · candidate · HEAD again
    setQueue(dir, [90, 91, 89, 100, 101, 99, 92, 93, 91, 100, 100, 100])
    const runOut = await p.run("s")
    expect(runOut).toContain("better")
    expect(runOut).toContain("Log `keep`")
    const measuredTree = p.storage.get("run/s").fingerprint.tree
    const before = head(dir)

    const out = await p.log("s", { status: "keep", description: "use `fast` path $(touch INJ)", asi: { learned: "x" } })
    expect(out).toContain("logged as keep @")
    expect(out).toContain("Confirmed")
    expect(out).toContain("candidate 92 vs HEAD 100, measured back to back: 8.0% better")
    expect(out).toContain("Segment 1 so far: 1 kept, 8.0% better overall")
    expect(out).toContain("measured at the time: baseline 100, current 92")

    expect(head(dir)).not.toBe(before)
    expect(await headTree(dir)).toBe(measuredTree)
    expect(g(dir, "show", "--name-only", "--format=", "HEAD").trim().split("\n").sort()).toEqual(["code.txt", "new-file.txt"])
    expect(g(dir, "status", "--short", "--", ".", ":(exclude).auto").trim()).toBe("")
    expect(g(dir, "log", "-1", "--format=%s").trim()).toBe("autoresearch: use `fast` path $(touch INJ) (ms=92)")
    expect(existsSync(join(dir, "INJ"))).toBe(false)
    expect(existsSync(join(dir, "ignored", "cache"))).toBe(true)

    const entry = runsOf(dir)[1]
    expect(entry).toMatchObject({
      status: "keep",
      metric: 92, // the confirmation, not the (selected, so biased) first measurement
      samples: [92, 93, 91],
      current_samples: [100, 101, 99, 100, 100, 100], // HEAD, measured before and after the candidate
      first_metric: 90,
      vs: 100,
      commit: head(dir).slice(0, 7),
      asi: { learned: "x" },
    })
    expect(entry.confidence!).toBeGreaterThan(2.5)
    expect(entry.baseline).toBeUndefined()
    expect(p.active("s").head).toBe(head(dir))
    expect(p.storage.get("run/s")).toBeUndefined()
  })

  test("a keep that isn't confirmed is reverted and logged as discard with a note", async () => {
    const { dir, p } = await withBaseline()
    writeFileSync(join(dir, "code.txt"), "no-op change\n")
    writeFileSync(join(dir, "new-file.txt"), "new\n")
    setQueue(dir, [95, 96, 94, 100, 101, 99, /* the candidate, back to back: no better than HEAD */ 100.5, 101, 99.5, 100, 100, 100])
    await p.run("s")
    const before = head(dir)
    const out = await p.log("s", { status: "keep" })
    expect(out).toContain("NOT confirmed")
    expect(out).toContain("logged as discard")
    expect(head(dir)).toBe(before)
    expect(readFileSync(join(dir, "code.txt"), "utf8")).toBe("v1\n")
    expect(existsSync(join(dir, "new-file.txt"))).toBe(false)
    const entry = runsOf(dir)[1]
    expect(entry).toMatchObject({
      status: "discard",
      metric: 100.5,
      samples: [100.5, 101, 99.5],
      current_samples: [100, 101, 99, 100, 100, 100],
      first_metric: 95,
      vs: 100,
      commit: null,
      note: "keep not confirmed: candidate 100.5 vs HEAD 100 back to back (0.5% worse); first measurement 95",
    })
    // The confidence is recorded for unconfirmed keeps too, so the decision can be audited.
    expect(entry.confidence!).toBeLessThan(0)
    expect(out).toContain("0.5% worse")
    expect(out).not.toMatch(/[+-]\d+(\.\d+)?%/) // one wording for gains: never a signed percentage
    // The same measurement can't be logged again.
    expect(await p.log("s", { status: "keep" })).toContain("No unlogged run")
  })

  test("a confirmation run that crashes counts as not confirmed", async () => {
    const { dir, p } = await withBaseline()
    writeFileSync(join(dir, "code.txt"), "flaky\n")
    setQueue(dir, [90, 90, 90, 100, 100, 100, 90, "FAIL"])
    await p.run("s")
    const out = await p.log("s", { status: "keep" })
    expect(out).toContain("NOT confirmed")
    expect(readFileSync(join(dir, "code.txt"), "utf8")).toBe("v1\n")
    expect(runsOf(dir)[1]).toMatchObject({ status: "discard", metric: null, samples: [] })
    expect(runsOf(dir)[1].note).toContain("exited with code 1")
  })

  test("fingerprint mismatch: files edited after the measurement can't be kept", async () => {
    const { dir, p } = await withBaseline()
    writeFileSync(join(dir, "code.txt"), "measured version\n")
    setPerf(dir, 90)
    await p.run("s")
    writeFileSync(join(dir, "code.txt"), "edited after measuring\n")
    const before = head(dir)
    const out = await p.log("s", { status: "keep" })
    expect(out).toContain("ERROR")
    expect(out).toContain("Files changed since the measurement")
    expect(head(dir)).toBe(before)
    expect(runsOf(dir)).toHaveLength(1) // nothing logged
    expect(readFileSync(join(dir, "code.txt"), "utf8")).toBe("edited after measuring\n") // nothing reverted either
    // Measuring again makes it keepable.
    await p.run("s")
    expect(await p.log("s", { status: "keep" })).toContain("logged as keep")
  })

  test("a new untracked file after the measurement is a mismatch too", async () => {
    const { dir, p } = await withBaseline()
    writeFileSync(join(dir, "code.txt"), "measured version\n")
    setValue(dir, 90)
    await p.run("s")
    writeFileSync(join(dir, "sneaked-in.txt"), "x\n")
    expect(await p.log("s", { status: "keep" })).toContain("Files changed since the measurement")
  })

  test("a keep with no diff is refused", async () => {
    const { dir, p } = await withBaseline()
    setValue(dir, 80) // a lucky number on unchanged code
    await p.run("s")
    const out = await p.log("s", { status: "keep" })
    expect(out).toContain("ERROR")
    expect(out).toContain("no code changes to keep")
    expect(runsOf(dir)).toHaveLength(1)
    expect(await p.log("s", { status: "keep", simplification: true })).toContain("no code changes to keep")
  })

  test("a keep on a measurement that isn't better than current is refused without re-measuring", async () => {
    const { dir, p } = await withBaseline()
    writeFileSync(join(dir, "code.txt"), "slower\n")
    setValue(dir, 105)
    expect(await p.run("s")).toContain("Log `discard`")
    const n = calls(dir)
    const out = await p.log("s", { status: "keep" })
    expect(out).toContain("isn't better than current")
    expect(calls(dir)).toBe(n)
    expect(runsOf(dir)).toHaveLength(1)
  })

  test("simplification: needs a net deletion; kept as neutral when not worse beyond the noise nor by more than minImprovement", async () => {
    const { dir, p } = await withBaseline()
    // Not a net deletion: refused before anything is measured. (This flag was used to get a
    // performance change past the "first measurement must be better" filter.)
    writeFileSync(join(dir, "code.txt"), "v1 rewritten\n")
    setValue(dir, 101)
    await p.run("s")
    const n = calls(dir)
    const refused = await p.log("s", { status: "keep", simplification: true })
    expect(refused).toContain("ERROR")
    expect(refused).toContain("adds 1 and removes 1")
    expect(calls(dir)).toBe(n)
    expect(runsOf(dir)).toHaveLength(1)
    await p.log("s", { status: "discard" })

    // Two lines less, about equal: kept as neutral.
    writeFileSync(join(dir, "lib.txt"), "a\nb\nc\n")
    setQueue(dir, [100.2, 101, 99.5, 100, 101, 99, 100.3, 101.2, 99.4, 100, 100, 100])
    await p.run("s")
    const out = await p.log("s", { status: "keep", simplification: true, description: "remove dead lines" })
    expect(out).toContain("(simplification)")
    expect(out).toContain("Confirmed as a simplification")
    expect(runsOf(dir).at(-1)).toMatchObject({ status: "keep", neutral: true, metric: 100.3, vs: 100 })
    expect(g(dir, "log", "-1", "--format=%s").trim()).toContain("simplification")

    // Clearly worse: reverted.
    writeFileSync(join(dir, "lib.txt"), "a\nb\n")
    setQueue(dir, [100, 100, 100, 100, 101, 99, 110, 111, 109, 100, 100, 100])
    await p.run("s")
    expect(await p.log("s", { status: "keep", simplification: true })).toContain("NOT confirmed")
    expect(readFileSync(join(dir, "lib.txt"), "utf8")).toBe("a\nb\nc\n")

    // Inside a wide noise band, but 2 % worse: "within the noise" alone isn't enough.
    writeFileSync(join(dir, "lib.txt"), "a\nb\n")
    setQueue(dir, [100, 100, 100, 100, 110, 90, 102, 112, 92, 100, 110, 90])
    await p.run("s")
    const costly = await p.log("s", { status: "keep", simplification: true })
    expect(costly).toContain("NOT confirmed")
    expect(costly).toContain("may not cost more than 1%")
  })

  test("the next candidate is compared with current (the last keep), not with a best-ever", async () => {
    const { dir, p } = await withBaseline()
    setPerf(dir, 90)
    await p.run("s")
    expect(await p.log("s", { status: "keep" })).toContain("logged as keep")
    setPerf(dir, 95) // better than the baseline, worse than current
    const out = await p.run("s")
    expect(out).toContain("current's logged 90")
    expect(out).toContain("5.6% worse")
    expect(out).toContain("Log `discard`")
  })

  test("repeat 1: no noise estimate, so the paired gain must reach minImprovement", async () => {
    const { dir, p } = await withBaseline({}, { repeat: 1 })
    writeFileSync(join(dir, "code.txt"), "v2\n")
    setQueue(dir, [98, /* HEAD */ 100, /* candidate: only 0.5 % better */ 99.5, /* HEAD */ 100])
    await p.run("s")
    expect(await p.log("s", { status: "keep" })).toContain("NOT confirmed")
    writeFileSync(join(dir, "code.txt"), "v3\n")
    setQueue(dir, [97, 100, 98, 100])
    await p.run("s")
    expect(await p.log("s", { status: "keep" })).toContain("logged as keep")
    expect(runsOf(dir).at(-1)).toMatchObject({ metric: 98, samples: [98], current_samples: [100, 100], noise: null, confidence: null })
  })

  test("a failed commit doesn't re-roll the confirmation", async () => {
    const { dir, p } = await withBaseline()
    writeFileSync(join(dir, "code.txt"), "v2\n")
    setQueue(dir, [90, 91, 89, 100, 101, 99, 92, 93, 91, 100, 100, 100])
    await p.run("s")
    writeFileSync(join(dir, ".git", "index.lock"), "") // makes git add fail
    const n = calls(dir)
    expect(await p.log("s", { status: "keep" })).toContain("Couldn't commit")
    expect(calls(dir)).toBe(n + 9)
    rmSync(join(dir, ".git", "index.lock"))
    expect(await p.log("s", { status: "keep" })).toContain("logged as keep")
    expect(calls(dir)).toBe(n + 9) // judged on the stored confirmation
    expect(runsOf(dir)[1]).toMatchObject({ metric: 92, samples: [92, 93, 91] })
  })
})

describe("discard, crash, checks_failed", () => {
  test("revert to the last commit and record what was measured, not what the agent says", async () => {
    const { dir, p } = await withBaseline()
    writeFileSync(join(dir, "code.txt"), "worse\n")
    writeFileSync(join(dir, "junk.txt"), "j\n")
    writeFileSync(join(dir, ".auto", "ideas.md"), "- keep me\n")
    setValue(dir, 120)
    await p.run("s")
    // `metric` and `metrics` aren't inputs: passing them is an error that names them.
    const typed = await p.log("s", { status: "discard", metric: 1, metrics: { extra: 0 } })
    expect(typed).toContain("ERROR: Unknown arguments `metric`, `metrics`")
    expect(readFileSync(join(dir, "code.txt"), "utf8")).toBe("worse\n")
    const out = await p.log("s", { status: "discard" })
    expect(out).toContain("logged as discard")
    expect(readFileSync(join(dir, "code.txt"), "utf8")).toBe("v1\n")
    expect(existsSync(join(dir, "junk.txt"))).toBe(false)
    expect(existsSync(join(dir, ".auto", "ideas.md"))).toBe(true)
    expect(runsOf(dir)[1]).toMatchObject({ status: "discard", metric: 120, samples: [120, 120, 120], metrics: { extra: 7 }, vs: 100 })
  })

  test("each run is logged once; an interrupted run can't be logged", async () => {
    const { dir, p } = await withBaseline()
    expect(await p.log("s", { status: "discard" })).toContain("No unlogged run")
    p.storage.set("run/s", { running: true })
    expect(await p.log("s", { status: "discard" })).toContain("didn't finish")
    expect(runsOf(dir)).toHaveLength(1)
  })

  test("failed checks: can't be kept, logged as checks_failed", async () => {
    const { dir, p } = await started()
    writeFileSync(join(dir, ".auto", "checks.sh"), "#!/bin/bash\ngrep -q broken code.txt && { echo 'test failed'; exit 1; }\nexit 0\n")
    chmodSync(join(dir, ".auto", "checks.sh"), 0o755)
    commitBenchmark(dir)
    await p.init("s")
    expect(await p.run("s")).toContain("checks: passed")
    await p.log("s", { status: "keep" })
    writeFileSync(join(dir, "code.txt"), "broken but fast\n")
    setValue(dir, 50)
    const out = await p.run("s")
    expect(out).toContain("checks: FAILED")
    expect(out).toContain("test failed")
    expect(await p.log("s", { status: "keep" })).toContain("Log it as `checks_failed`")
    await p.log("s", { status: "checks_failed" })
    expect(runsOf(dir)[1]).toMatchObject({ status: "checks_failed", metric: 50 })
    expect(readFileSync(join(dir, "code.txt"), "utf8")).toBe("v1\n")
  })
})

describe("the benchmark is frozen per segment", () => {
  test("an edited measure.sh is refused until a new segment is started", async () => {
    const { dir, p } = await withBaseline()
    writeFileSync(join(dir, ".auto", "measure.sh"), "#!/bin/bash\necho METRIC ms=1\n")
    const n = runsOf(dir).length
    const out = await p.run("s")
    expect(out).toContain("ERROR")
    expect(out).toContain("The benchmark changed")
    expect(out).toContain("autoresearch_init")
    expect(p.storage.get("run/s")).toBeUndefined()
    // The legitimate path: commit the edit, then a new segment, visible in the log, with its own baseline.
    const uncommitted = await p.init("s")
    expect(uncommitted).toContain("ERROR: The benchmark has uncommitted changes")
    expect(uncommitted).toContain(".auto/measure.sh")
    commitBenchmark(dir)
    expect(await p.init("s")).toContain("segment 2")
    expect(await p.run("s")).toContain("This is the baseline")
    await p.log("s", { status: "keep" })
    expect(runsOf(dir)).toHaveLength(n + 1)
    expect(runsOf(dir).at(-1)).toMatchObject({ segment: 2, run: 1, baseline: true, metric: 1 })
  })

  test("adding, editing or removing checks.sh is refused too", async () => {
    const { dir, p } = await withBaseline()
    writeFileSync(join(dir, ".auto", "checks.sh"), "#!/bin/bash\nexit 0\n")
    expect(await p.run("s")).toContain("checks.sh was added")
  })

  test("measure.sh edited between run and log: the keep is refused", async () => {
    const { dir, p } = await withBaseline()
    writeFileSync(join(dir, "code.txt"), "v2\n")
    setValue(dir, 90)
    await p.run("s")
    writeFileSync(join(dir, ".auto", "measure.sh"), "#!/bin/bash\necho METRIC ms=1\n")
    expect(await p.log("s", { status: "keep" })).toContain("benchmark files changed")
  })

  test("run → init → log: the old measurement can't become the new segment's baseline", async () => {
    const { dir, p } = await withBaseline()
    setValue(dir, 42)
    await p.run("s")
    await p.init("s")
    expect(await p.log("s", { status: "keep" })).toContain("No unlogged run")
    expect(runsOf(dir)).toHaveLength(1)
  })

  test("a benchmark that writes files into the project can't produce a keep", async () => {
    // Otherwise the committed tree isn't the measured one, and "is there a diff?" is always yes.
    const { dir, p } = await started({ measure: MEASURE + "date +%s%N > bench-output.txt\n" })
    await p.init("s")
    const out = await p.run("s")
    expect(out).toContain("benchmark itself changed files")
    expect(out).toContain("bench-output.txt")
    expect(await p.log("s", { status: "keep" })).toContain("benchmark changed files")
    expect(runsOf(dir)).toHaveLength(0)
    expect(await p.log("s", { status: "discard" })).toContain("logged as discard")
    expect(existsSync(join(dir, "bench-output.txt"))).toBe(false)
  })
})

describe("branch and HEAD are checked on every step", () => {
  test("a commit made underneath pauses the loop instead of reverting or committing on top", async () => {
    const { dir, p } = await withBaseline()
    writeFileSync(join(dir, "user.txt"), "the user's commit\n")
    g(dir, "add", "user.txt")
    g(dir, "commit", "-qm", "user commit")
    const out = await p.run("s")
    expect(out).toContain("ERROR")
    expect(out).toContain("HEAD is")
    expect(p.active("s")).toBeUndefined()
    expect(p.said("s").at(-1)).toContain("Loop paused")
    expect(calls(dir)).toBe(4) // only the baseline's runs
  })

  test("a branch switch mid-experiment: log refuses and the other branch's tree is left alone", async () => {
    const { dir, p } = await withBaseline()
    setValue(dir, 120)
    await p.run("s")
    g(dir, "checkout", "-q", "main")
    writeFileSync(join(dir, "code.txt"), "work on main\n")
    const out = await p.log("s", { status: "discard" })
    expect(out).toContain("ERROR")
    expect(out).toContain("`main`")
    expect(readFileSync(join(dir, "code.txt"), "utf8")).toBe("work on main\n")
    expect(p.active("s")).toBeUndefined()
    expect(runsOf(dir)).toHaveLength(1)
  })

  test("a takeover by another session disables the first session's tools", async () => {
    const dir = repo()
    const p = await boot(dir, { s1: dir, s2: dir })
    await p.cmd("s1", "goal")
    await p.init("s1")
    await p.cmd("s2", "goal")
    expect(p.active("s1")).toBeUndefined()
    expect(p.said("s1").at(-1)).toContain("another session")
    expect(await p.run("s1")).toContain("loop is off")
    expect(p.active("s2")).toBeDefined()
  })
})

describe("permissions", () => {
  test("the asserted commands are the ones that run; no 'always allow' offer for restore and clean", async () => {
    const { dir, p } = await withBaseline()
    setPerf(dir, 90)
    p.sent.length = 0
    await p.run("s")
    expect(await p.log("s", { status: "keep" })).toContain("logged as keep")
    const asserts = p.sent.filter((s) => s.kind === "assert")
    expect(asserts[0]).toEqual({ kind: "assert", resources: ["./.auto/measure.sh"], save: ["./.auto/measure.sh"] })
    // Hooks are off on every git call, and the prompt shows the commands as they run.
    expect(asserts[1].resources).toHaveLength(4)
    expect(asserts[1].resources[0]).toBe("./.auto/measure.sh")
    expect(asserts[1].resources[1]).toBe("git -c core.hooksPath=/dev/null read-tree -m -u")
    expect(asserts[1].resources[2]).toStartWith("git -c core.hooksPath=/dev/null add -A -- .")
    expect(asserts[1].resources[3]).toStartWith("git -c core.hooksPath=/dev/null -c commit.gpgsign=false commit --no-verify")
    expect(asserts[1].save).toEqual(asserts[1].resources)
    expect(asserts[2].resources[0]).toStartWith("git -c core.hooksPath=/dev/null restore --source=HEAD --staged --worktree -- .")
    expect(asserts[2].resources[1]).toStartWith("git -c core.hooksPath=/dev/null clean -fd -- .")
    expect(asserts[2].save).toBeUndefined()
  })

  test("a denied permission propagates and nothing is changed or logged", async () => {
    const { dir, p } = await withBaseline()
    writeFileSync(join(dir, "code.txt"), "v2\n")
    setValue(dir, 120)
    await p.run("s")
    p.deny(/ clean -fd/)
    await expect(p.log("s", { status: "discard" })).rejects.toThrow("Permission denied")
    expect(readFileSync(join(dir, "code.txt"), "utf8")).toBe("v2\n")
    expect(runsOf(dir)).toHaveLength(1)
    p.deny(null)
    // A keep asks for the revert permission up front, before spending time on confirmation.
    setValue(dir, 90)
    await p.run("s")
    const n = calls(dir)
    p.deny(/ restore --source/)
    await expect(p.log("s", { status: "keep" })).rejects.toThrow("Permission denied")
    expect(calls(dir)).toBe(n)
  })
})

// ── Robustness: budget, stops, retries ────────────────────

describe("limits", () => {
  test("maxNoImprovement: the loop stops after that many runs in a row without a keep, and says why", async () => {
    const { dir, p } = await withBaseline()
    writeFileSync(join(dir, ".auto", "config.json"), '{"maxNoImprovement": 2}')
    setValue(dir, 120)
    await p.run("s")
    expect(await p.log("s", { status: "discard" })).not.toContain("STOP")
    await p.run("s")
    const out = await p.log("s", { status: "discard" })
    expect(out).toContain("STOP")
    expect(out).toContain("2 runs in a row without a keep since the loop was last started")
    expect(p.active("s")).toBeUndefined()
    expect(p.said("s").at(-1)).toContain("maxNoImprovement = 2")
    expect(await p.run("s")).toContain("loop is off")
  })

  test("the baseline doesn't count as an improvement, crashes count as no improvement", async () => {
    const { dir, p } = await started()
    writeFileSync(join(dir, ".auto", "config.json"), '{"maxNoImprovement": 2}')
    await p.init("s")
    setValue(dir, "FAIL")
    await p.run("s")
    await p.log("s", { status: "crash" })
    await p.run("s")
    expect(await p.log("s", { status: "crash" })).toContain("STOP")
  })

  test("a resume gets a fresh allowance", async () => {
    const { dir, p } = await withBaseline()
    writeFileSync(join(dir, ".auto", "config.json"), '{"maxNoImprovement": 1}')
    setValue(dir, 120)
    await p.run("s")
    expect(await p.log("s", { status: "discard" })).toContain("STOP")
    await p.cmd("s", "")
    expect(p.active("s")).toBeDefined()
    expect(await p.run("s")).not.toContain("STOP")
  })

  test("maxIterations (default 50 without a config file): log stops the loop, run and resume refuse", async () => {
    const { dir, p } = await withBaseline()
    expect(await p.log("s", { status: "discard" })).toContain("No unlogged run")
    writeFileSync(join(dir, ".auto", "config.json"), '{"maxIterations": 2}')
    setValue(dir, 120)
    await p.run("s")
    const out = await p.log("s", { status: "discard" })
    expect(out).toContain("Runs: 2/2")
    expect(out).toContain("STOP: maxIterations reached")
    expect(p.active("s")).toBeUndefined()
    p.sent.length = 0
    await p.cmd("s", "")
    expect(p.active("s")).toBeUndefined()
    expect(p.said("s").join("\n")).toContain("2/2 runs are already logged")

    rmSync(join(dir, ".auto", "config.json"))
    await p.cmd("s", "status")
    expect(p.said("s").at(-1)).toContain("Runs: 2/50")
  })
})

describe("autoresearch_pause", () => {
  test("turns the loop off and shows the reason to the user", async () => {
    const { p } = await withBaseline()
    const out = await p.pause("s", "Out of ideas that don't change the public API. Should I?")
    expect(out).toContain("Loop paused")
    expect(p.active("s")).toBeUndefined()
    expect(p.said("s").at(-1)).toContain("Out of ideas that don't change the public API")
    expect(await p.pause("s", "again")).toContain("already off")
    expect(await p.pause("s", " ")).toContain("ERROR")
  })
})

describe("/autoresearch status and off", () => {
  test("status shows current, limits and warnings", async () => {
    const { dir, p } = await withBaseline()
    setPerf(dir, 90)
    await p.run("s")
    await p.log("s", { status: "keep" })
    writeFileSync(join(dir, ".auto", "config.json"), '{"maxIterations": "lots", "maxNoImprovement": 7}')
    writeFileSync(join(dir, ".auto", "measure.sh"), MEASURE + "# edited\n")
    await p.cmd("s", "status")
    const text = p.said("s").at(-1)!
    expect(text).toContain("Loop: ON · branch autoresearch/test")
    expect(text).toContain('Segment 1 "t" (current): 2 runs, 1 kept, 10.0% better overall')
    expect(text).toContain("measured at the time: baseline 100, current 90")
    expect(text).toContain("Runs: 2/50 in total · 1 kept experiment")
    expect(text).toContain("maxNoImprovement 7 (now 0 runs without a keep since the loop was last started)")
    expect(text).toContain("Warning: maxIterations must be")
    expect(text).toContain("Warning: The benchmark files")
    expect(text).toContain("Warning: No .auto/checks.sh")
  })

  test("off while an experiment waits to be logged: that one run may still be logged, then the loop is off", async () => {
    const { dir, p } = await withBaseline()
    writeFileSync(join(dir, "code.txt"), "v2\n")
    setValue(dir, 120)
    await p.run("s")
    await p.cmd("s", "off")
    expect(p.active("s")).toMatchObject({ stopping: true })
    expect(p.said("s").at(-1)).toContain("stops as soon as the experiment in progress is logged")
    const out = await p.log("s", { status: "discard" })
    expect(out).toContain("STOP: the user turned the loop off")
    expect(readFileSync(join(dir, "code.txt"), "utf8")).toBe("v1\n")
    expect(p.active("s")).toBeUndefined()
  })

  test("off twice stops at once; a stopping loop starts no new experiment", async () => {
    const { dir, p } = await withBaseline()
    writeFileSync(join(dir, "code.txt"), "v2\n")
    await p.run("s")
    await p.cmd("s", "stop")
    expect(await p.run("s")).toContain("user turned the loop off")
    await p.cmd("s", "stop")
    expect(p.active("s")).toBeUndefined()
    expect(p.said("s").at(-1)).toContain("uncommitted changes")
  })
})

describe("keeping the loop going", () => {
  const continues = (p: Awaited<ReturnType<typeof boot>>, sid = "s") =>
    p.sent.filter((s) => s.kind === "synthetic" && s.sessionID === sid && s.delivery === "queue" && /Continue the experiment loop|Pick up where you left off/.test(s.text))

  test("a finished turn gets one continue; three turns without a logged run pause the loop", async () => {
    const { p } = await withBaseline()
    // The first turn logged the baseline; the next three log nothing.
    for (let i = 1; i <= 3; i++) {
      p.emit("session.execution.succeeded", "s")
      await until(() => continues(p).length === i)
    }
    p.emit("session.execution.succeeded", "s")
    await until(() => !p.active("s"))
    expect(continues(p)).toHaveLength(3)
    expect(p.said("s").at(-1)).toContain("no experiment was logged in 3 turns")
  })

  test("setup mode: no nudge while the agent may be waiting for answers; nudges once prompt.md and a config entry exist", async () => {
    const dir = repo()
    rmSync(join(dir, ".auto", "prompt.md"))
    g(dir, "commit", "-qam", "no prompt yet")
    const p = await boot(dir, { s: dir })
    await p.cmd("s", "goal")
    expect(p.sent.find((s) => s.kind === "prompt").text).toContain("Set up and start")

    p.emit("session.execution.succeeded", "s")
    await sleep(100)
    expect(continues(p)).toHaveLength(0)

    writeFileSync(join(dir, ".auto", "prompt.md"), "rules\n")
    p.emit("session.execution.succeeded", "s")
    await sleep(100)
    expect(continues(p)).toHaveLength(0) // prompt.md alone isn't the end of setup

    await p.init("s")
    // The old bug: the agent ends its turn here, before any run is logged, and nothing ever nudged it.
    p.emit("session.execution.succeeded", "s")
    await until(() => continues(p).length === 1)
    expect(p.active("s").setup).toBeUndefined()
  })

  test("a failed turn is retried with backoff; one failure more than there are delays pauses the loop", async () => {
    timing.retryDelaysMs = [30, 30, 30]
    try {
      const { p } = await withBaseline()
      for (let i = 1; i <= 3; i++) {
        p.emit("session.execution.failed", "s", { error: { type: "x", message: "overloaded" } })
        await until(() => continues(p).length === i)
        expect(p.active("s").failures).toBe(i)
        expect(continues(p).at(-1).text).toContain("previous turn failed")
      }
      p.emit("session.execution.failed", "s", { error: { type: "x", message: "overloaded" } })
      await until(() => !p.active("s"))
      expect(p.said("s").at(-1)).toContain("4 turns in a row failed")
      expect(p.said("s").at(-1)).toContain("overloaded")
      expect(p.sent.at(-1).resume).toBe(false) // no new turn for a notice that would fail again
      expect(continues(p)).toHaveLength(3)
    } finally {
      timing.retryDelaysMs = [30_000, 120_000, 300_000]
    }
  })

  test("a turn that succeeds resets the failure count; off cancels a pending retry", async () => {
    timing.retryDelaysMs = [200, 200, 200]
    try {
      const { p } = await withBaseline()
      p.emit("session.execution.failed", "s", { error: { message: "x" } })
      await until(() => p.active("s")?.failures === 1)
      p.emit("session.execution.succeeded", "s")
      await until(() => p.active("s")?.failures === 0)
      await sleep(300)
      expect(continues(p).filter((c) => c.text.includes("previous turn failed"))).toHaveLength(0)

      p.emit("session.execution.failed", "s", { error: { message: "x" } })
      await until(() => p.active("s")?.failures === 1)
      await p.cmd("s", "off")
      const n = continues(p).length
      await sleep(300)
      expect(continues(p)).toHaveLength(n)
    } finally {
      timing.retryDelaysMs = [30_000, 120_000, 300_000]
    }
  })

  test("unloading the plugin clears retry timers", async () => {
    timing.retryDelaysMs = [100]
    try {
      const { p } = await withBaseline()
      p.emit("session.execution.failed", "s", { error: { message: "x" } })
      await until(() => p.active("s")?.failures === 1)
      await p.cleanup()
      await sleep(250)
      expect(continues(p)).toHaveLength(0)
    } finally {
      timing.retryDelaysMs = [30_000, 120_000, 300_000]
    }
  })

  test("an interrupt turns the loop off and says so", async () => {
    const { p } = await withBaseline()
    p.emit("session.execution.interrupted", "s")
    await until(() => !p.active("s"))
    expect(p.said("s").at(-1)).toContain("session was stopped")
    // The reason stays available even if that notice is never seen.
    await p.cmd("s", "status")
    expect(p.said("s").at(-1)).toContain("Last stop (")
    expect(p.said("s").at(-1)).toContain("session was stopped")
  })

  test("plugin start: one queued continue for each active loop of this project, none for setup or other projects", async () => {
    timing.startupDelayMs = 20
    try {
      const dir = repo()
      const other = repo()
      const storage = new Map<string, any>()
      const loop = (directory: string, extra = {}) => ({ directory, startRunCount: 0, lastRunCount: 0, stalls: 0, failures: 0, ...extra })
      storage.set("active/mine", loop(dir))
      storage.set("active/setting-up", loop(dir, { setup: true }))
      storage.set("active/elsewhere", loop(other))
      const p = await boot(dir, { mine: dir, "setting-up": dir, elsewhere: other }, storage)
      await until(() => continues(p, "mine").length === 1)
      await sleep(100)
      expect(continues(p, "mine")).toHaveLength(1)
      expect(continues(p, "setting-up")).toHaveLength(0)
      expect(continues(p, "elsewhere")).toHaveLength(0)
    } finally {
      timing.startupDelayMs = 5_000
    }
  })

  test("events of loops in other projects are ignored", async () => {
    const dir = repo()
    const other = repo()
    const p = await boot(dir, { s: other })
    p.storage.set("active/s", { directory: other, startRunCount: 0, lastRunCount: 0, stalls: 0, failures: 0 })
    p.emit("session.execution.succeeded", "s")
    p.emit("session.execution.failed", "s", { error: { message: "x" } })
    await sleep(100)
    expect(continues(p)).toHaveLength(0)
    expect(p.active("s").failures).toBe(0)
  })
})

describe("compaction hook", () => {
  test("passes the working tree and the pending run to the summary", async () => {
    const { dir, p } = await withBaseline()
    writeFileSync(join(dir, "code.txt"), "v2 in progress\n")
    setValue(dir, 90)
    await p.run("s")
    const event: any = { sessionID: "s", messages: [{ role: "user", content: [{ type: "text", text: "focus on parsing" }] }] }
    await p.hooks.compaction(event)
    expect(event.result.summary).toContain("code.txt")
    expect(event.result.summary).toContain("measured but not logged yet")
    expect(event.result.summary).toContain("focus on parsing")
    // Loop off: the default summary is used.
    await p.cmd("s", "off")
    await p.cmd("s", "off")
    const untouched: any = { sessionID: "s", messages: [] }
    await p.hooks.compaction(untouched)
    expect(untouched.result).toBeUndefined()
  })
})

describe("tool output", () => {
  test("a benchmark that prints megabytes doesn't reach the model whole", async () => {
    const { dir, p } = await withBaseline()
    writeFileSync(join(dir, ".auto", "measure.sh"), `#!/bin/bash\nhead -c 3000000 /dev/zero | tr '\\0' x\necho\necho METRIC ms=5\n`)
    commitBenchmark(dir)
    await p.init("s")
    const out = await p.run("s")
    expect(out).toContain("ms: 5")
    expect(out.length).toBeLessThan(5_000)
    expect(out).toContain("line cut")
  })
})

// ── v0.2.1: paired confirmation ───────────────────────────

/** Every file below `dir` with its content and executable bit (not .git, .bench or the log). */
function snapshot(dir: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix + entry.name
    if (entry.name === ".git" || entry.name === ".bench" || rel.endsWith(".auto/log.jsonl")) continue
    if (entry.isDirectory()) Object.assign(out, snapshot(dir, `${rel}/`))
    else out[rel] = `${statSync(join(dir, rel)).mode & 0o111 ? "x" : "-"} ${readFileSync(join(dir, rel), "utf8")}`
  }
  return out
}

// Besides its number, each benchmark call records what the project looked like to it.
const STATE_LINE =
  'echo "$(cat perf.txt) new=$([ -e new/deep/file.txt ] && echo y || echo n) lib=$([ -e lib.txt ] && echo y || echo n) ' +
  'old=$([ -e old-name.txt ] && echo y || echo n) x=$([ -x tool.sh ] && echo y || echo n) ' +
  'ign=$([ -e ignored/node_modules/pkg.js ] && echo y || echo n) prompt=$(cat .auto/prompt.md)" >> $b/state'
const MEASURE_WITH_STATE = MEASURE.replace('echo "run', `${STATE_LINE}\necho "run`)
const states = (dir: string) => readFileSync(join(dir, ".bench", "state"), "utf8").split("\n").filter(Boolean)
const swapMarkers = (p: Awaited<ReturnType<typeof boot>>) => [...p.storage.keys()].filter((k) => k.startsWith("swap/"))

/** An experiment that changes files in every way git knows: edit, add, delete, rename, mode, untracked folder. */
function changeEverything(dir: string) {
  setPerf(dir, 90)
  writeFileSync(join(dir, "code.txt"), "v2\n")
  mkdirSync(join(dir, "new", "deep"), { recursive: true })
  writeFileSync(join(dir, "new", "deep", "file.txt"), "untracked, in a new folder\n")
  rmSync(join(dir, "lib.txt"))
  renameSync(join(dir, "old-name.txt"), join(dir, "new-name.txt"))
  chmodSync(join(dir, "tool.sh"), 0o755)
  // Not part of the experiment, and must come through every swap untouched:
  mkdirSync(join(dir, "ignored", "node_modules"), { recursive: true })
  writeFileSync(join(dir, "ignored", "node_modules", "pkg.js"), "an installed dependency\n")
  writeFileSync(join(dir, ".auto", "prompt.md"), "edited")
  writeFileSync(join(dir, ".auto", "ideas.md"), "- an idea\n")
}

describe("paired confirmation", () => {
  const HEAD_STATE = "100 new=n lib=y old=y x=n ign=y prompt=edited"
  const CANDIDATE_STATE = "90 new=y lib=n old=n x=y ign=y prompt=edited"
  const PAIRED_STATES = [HEAD_STATE, HEAD_STATE, HEAD_STATE, CANDIDATE_STATE, CANDIDATE_STATE, CANDIDATE_STATE, HEAD_STATE, HEAD_STATE, HEAD_STATE]

  test("measures HEAD, the candidate and HEAD again on the right files, then commits the candidate exactly", async () => {
    const { dir, p } = await withBaseline({ measure: MEASURE_WITH_STATE })
    changeEverything(dir)
    expect(await p.run("s")).toContain("9 more benchmark runs")
    const before = snapshot(dir)
    const measuredTree = p.storage.get("run/s").fingerprint.tree
    const n = calls(dir)

    const out = await p.log("s", { status: "keep" })
    expect(out).toContain("logged as keep")
    expect(out).toContain("candidate 90 vs HEAD 100, measured back to back: 10.0% better")
    // 3 runs on HEAD, 3 on the candidate, 3 on HEAD: the HEAD runs bracket the candidate's.
    expect(states(dir).slice(n)).toEqual(PAIRED_STATES)
    expect(runsOf(dir).at(-1)).toMatchObject({ status: "keep", samples: [90, 90, 90], current_samples: [100, 100, 100, 100, 100, 100], vs: 100, metric: 90, first_metric: 90 })

    expect(snapshot(dir)).toEqual(before) // every file as the agent left it, ignored and .auto files included
    expect(await headTree(dir)).toBe(measuredTree)
    expect(g(dir, "status", "--short", "--", ".", ":(exclude).auto").trim()).toBe("")
    expect(g(dir, "show", "--name-status", "--no-renames", "--format=", "HEAD").trim().split("\n").sort()).toEqual([
      "A\tnew-name.txt",
      "A\tnew/deep/file.txt",
      "D\tlib.txt",
      "D\told-name.txt",
      "M\tcode.txt",
      "M\tperf.txt",
      "M\ttool.sh",
    ])
    expect(swapMarkers(p)).toEqual([])
  })

  test("the logged current plays no part: a slow logged baseline doesn't let a no-op through, a fast one doesn't block a gain", async () => {
    // Baseline logged at 100 while the machine was slow; it's at 80 now. A no-op measures
    // 80, "20 % better" than the log, and used to be kept.
    const { dir, p } = await withBaseline()
    writeFileSync(join(dir, "code.txt"), "a no-op\n")
    setQueue(dir, [80, 81, 79, 80, 81, 79, 80.5, 81, 79.5, 80, 80, 80])
    expect(await p.run("s")).toContain("20.0% better")
    expect(await p.log("s", { status: "keep" })).toContain("NOT confirmed")
    expect(runsOf(dir).at(-1)).toMatchObject({ status: "discard", vs: 80, metric: 80.5, first_metric: 80 })

    // Now the machine is 5 % slower than when the baseline was logged (HEAD measures 105).
    // A real 10 % gain measures 94.5: only 5.5 % better than the log, but 10 % better than
    // HEAD right now, and that is what's judged and recorded.
    writeFileSync(join(dir, "code.txt"), "a real gain\n")
    setQueue(dir, [94.5, 95, 94, 105, 106, 104, 94.5, 95, 94, 105, 105, 105])
    await p.run("s")
    const out = await p.log("s", { status: "keep" })
    expect(out).toContain("logged as keep")
    expect(out).toContain("candidate 94.5 vs HEAD 105, measured back to back: 10.0% better")
  })

  test("a session in a monorepo subfolder: only its files are swapped and committed", async () => {
    const root = mkdtempSync(join(tmpdir(), "ar-mono-"))
    g(root, "init", "-q", "-b", "main")
    g(root, "config", "user.email", "t@t")
    g(root, "config", "user.name", "t")
    const dir = join(root, "packages", "app")
    mkdirSync(dir, { recursive: true })
    project(dir, MEASURE_WITH_STATE)
    mkdirSync(join(root, "packages", "other", ".auto"), { recursive: true })
    writeFileSync(join(root, "packages", "other", "file.txt"), "committed\n")
    writeFileSync(join(root, "packages", "other", ".auto", "prompt.md"), "another session\n")
    g(root, "add", "-A")
    g(root, "commit", "-qm", "init")
    g(root, "checkout", "-q", "-b", "autoresearch/app")
    mkdirSync(join(dir, ".bench"))
    setValue(dir, 100)
    // The user's uncommitted work elsewhere in the repo, staged and unstaged.
    writeFileSync(join(root, "packages", "other", "file.txt"), "the user's uncommitted work\n")
    writeFileSync(join(root, "packages", "other", "staged.txt"), "staged by the user\n")
    g(root, "add", "packages/other/staged.txt")
    writeFileSync(join(root, "packages", "other", ".auto", "prompt.md"), "another session, edited\n")

    const p = await boot(dir, { s: dir })
    await p.cmd("s", "goal")
    expect(await p.init("s")).toContain("Initialized")
    await p.run("s")
    await p.log("s", { status: "keep" })
    changeEverything(dir)
    await p.run("s")
    const before = snapshot(root)
    const n = calls(dir)
    expect(await p.log("s", { status: "keep" })).toContain("logged as keep")
    expect(states(dir).slice(n)).toEqual(PAIRED_STATES)
    expect(snapshot(root)).toEqual(before)
    expect(g(root, "show", "--name-only", "--format=", "HEAD").trim().split("\n").every((f) => f.startsWith("packages/app/"))).toBe(true)
    expect(g(root, "status", "--short").trim().split("\n").map((l) => l.trim()).sort()).toEqual([
      "A  packages/other/staged.txt",
      "M packages/other/.auto/prompt.md",
      "M packages/other/file.txt",
      "M packages/app/.auto/prompt.md",
      "?? packages/app/.auto/ideas.md",
      "?? packages/app/.auto/log.jsonl",
    ].sort())
  })

  test("the benchmark fails on HEAD: the candidate is restored, an error is returned, nothing is logged", async () => {
    const { dir, p } = await withBaseline({ measure: MEASURE_WITH_STATE })
    changeEverything(dir)
    await p.run("s")
    const before = snapshot(dir)
    for (const queue of [["FAIL"], [100, 100, 100, 90, 90, 90, 100, "FAIL"]]) {
      setQueue(dir, queue)
      const out = await p.log("s", { status: "keep" })
      expect(out).toContain("ERROR")
      expect(out).toContain("on the last commit the benchmark exited with code 1")
      expect(out).toContain("boom")
      expect(snapshot(dir)).toEqual(before)
      expect(runsOf(dir)).toHaveLength(1)
      expect(swapMarkers(p)).toEqual([])
      expect(p.active("s")).toBeDefined()
    }
    // The run is still pending: once HEAD measures, the keep goes through.
    expect(await p.log("s", { status: "keep" })).toContain("logged as keep")
  })

  test("an abort in the middle of each phase puts the candidate back at once; the keep can be proposed again", async () => {
    // Call numbers within the confirmation: 1–3 HEAD, 4–6 candidate, 7–9 HEAD again.
    for (const abortAt of [1, 5, 8]) {
      const { dir, p } = await withBaseline({ measure: MEASURE_WITH_STATE })
      changeEverything(dir)
      await p.run("s")
      const before = snapshot(dir)
      const n = calls(dir)
      writeFileSync(join(dir, ".bench", "sleep"), "0.4\n")
      const controller = new AbortController()
      const logging = p.log("s", { status: "keep" }, controller.signal)
      await until(() => calls(dir) >= n + abortAt, 20_000)
      controller.abort()
      const out = await logging
      expect(out).toContain("ERROR: Interrupted")
      expect(calls(dir)).toBe(n + abortAt) // stopped in that run
      expect(snapshot(dir)).toEqual(before)
      expect(swapMarkers(p)).toEqual([])
      expect(runsOf(dir)).toHaveLength(1)
      // The next tool call finds everything in place.
      rmSync(join(dir, ".bench", "sleep"))
      expect(await p.log("s", { status: "keep" })).toContain("logged as keep")
      expect(snapshot(dir)).toEqual(before)
    }
  })

  test("commands that arrive during a confirmation don't 'recover' the live swap", async () => {
    const { dir, p } = await withBaseline()
    setPerf(dir, 90)
    await p.run("s")
    const n = calls(dir)
    writeFileSync(join(dir, ".bench", "sleep"), "0.4\n")
    const logging = p.log("s", { status: "keep" })
    await until(() => calls(dir) >= n + 1, 20_000) // HEAD is being measured
    expect(swapMarkers(p)).toHaveLength(1)
    await p.cmd("s", "status")
    expect(readFileSync(join(dir, "perf.txt"), "utf8")).toBe("100\n") // still HEAD's files
    expect(p.said("s").at(-1)).not.toContain("cut off")
    expect(await logging).toContain("logged as keep")
    expect(seen(dir).slice(n)).toEqual(["100", "100", "100", "90", "90", "90", "100", "100", "100"])
  })

  test("the first run after each swap may pay for a rebuild: with 3 runs per half the median shrugs it off", async () => {
    const { dir, p } = await withBaseline()
    writeFileSync(join(dir, "code.txt"), "a real 10 % gain\n")
    //            first look    HEAD (cold first)  candidate (cold first)  HEAD (cold first)
    setQueue(dir, [90, 90, 90, 110, 100, 100, 99, 90, 90, 110, 100, 100])
    await p.run("s")
    const out = await p.log("s", { status: "keep" })
    expect(out).toContain("candidate 90 vs HEAD 100, measured back to back: 10.0% better")
    expect(runsOf(dir).at(-1)).toMatchObject({ status: "keep", vs: 100, metric: 90 })
  })

  test("a file edited while the keep is being confirmed is never overwritten, and nothing is logged", async () => {
    // Before the first swap (e.g. during the permission prompt): a plain "run again".
    const early = await withBaseline()
    setPerf(early.dir, 90)
    await early.p.run("s")
    const realAssert = early.p.sent.push.bind(early.p.sent)
    early.p.sent.push = (...items: any[]) => {
      // The edit lands between the fingerprint check and the swap.
      if (items[0]?.kind === "assert" && items[0].resources.some((r: string) => r.includes("read-tree"))) {
        writeFileSync(join(early.dir, "code.txt"), "edited during the prompt\n")
      }
      return realAssert(...items)
    }
    const n = calls(early.dir)
    const refused = await early.p.log("s", { status: "keep" })
    expect(refused).toContain("ERROR: Files changed since the measurement")
    expect(refused).toContain("code.txt")
    expect(calls(early.dir)).toBe(n)
    expect(readFileSync(join(early.dir, "code.txt"), "utf8")).toBe("edited during the prompt\n")
    expect(readFileSync(join(early.dir, "perf.txt"), "utf8")).toBe("90\n")
    expect(swapMarkers(early.p)).toEqual([])
    expect(early.p.active("s")).toBeDefined()

    // While HEAD is being measured: the edit stays, the experiment's files are not put on
    // top of it, the loop pauses, and the experiment comes back once the edit is gone.
    const { dir, p } = await withBaseline()
    setPerf(dir, 90)
    writeFileSync(join(dir, "new.txt"), "part of the experiment\n")
    await p.run("s")
    const candidate = snapshot(dir)
    const m = calls(dir)
    writeFileSync(join(dir, ".bench", "sleep"), "0.4\n")
    const logging = p.log("s", { status: "keep" })
    await until(() => calls(dir) >= m + 1, 20_000)
    writeFileSync(join(dir, "code.txt"), "edited while HEAD was measured\n")
    const out = await logging
    expect(out).toContain("ERROR")
    expect(out).toContain("code.txt")
    expect(out).toContain("Nothing was overwritten")
    expect(readFileSync(join(dir, "code.txt"), "utf8")).toBe("edited while HEAD was measured\n")
    expect(runsOf(dir)).toHaveLength(1)
    expect(p.active("s")).toBeUndefined()
    expect(swapMarkers(p)).toHaveLength(1)
    writeFileSync(join(dir, "code.txt"), "v1\n")
    rmSync(join(dir, ".bench", "sleep"))
    await p.cmd("s", "")
    expect(snapshot(dir)).toEqual(candidate)
    expect(swapMarkers(p)).toEqual([])
  })
})

describe("a confirmation cut off by a crash (the swap marker)", () => {
  /** The state a killed process leaves: files at HEAD (or partly), marker in storage, run pending. */
  async function crashed() {
    const { dir, p } = await withBaseline({ measure: MEASURE_WITH_STATE })
    changeEverything(dir)
    await p.run("s")
    const candidate = snapshot(dir)
    const fp = p.storage.get("run/s").fingerprint
    p.storage.set(swapKey(dir), { directory: dir, sessionID: "s", tree: fp.tree, head: fp.head, branch: fp.branch, at: "2026-01-01T00:00:00.000Z" })
    return { dir, p, candidate, fp }
  }
  const toHead = async (dir: string) => expect((await swapScope(dir, (await headTree(dir))!)).ok).toBe(true)

  test("files at HEAD: the next tool call puts the experiment back exactly, and the keep goes on", async () => {
    const { dir, p, candidate } = await crashed()
    await toHead(dir)
    expect(g(dir, "status", "--short", "--", ".", ":(exclude).auto").trim()).toBe("") // looks clean: that's the danger
    expect(existsSync(join(dir, "ignored", "node_modules", "pkg.js"))).toBe(true)
    const out = await p.log("s", { status: "keep" })
    expect(out).toStartWith("NOTE: A keep was being confirmed when the plugin was cut off")
    expect(out).toContain("logged as keep")
    expect(snapshot(dir)).toEqual(candidate)
    expect(swapMarkers(p)).toEqual([])
  })

  test("half-swapped files (killed during the swap itself) are completed", async () => {
    const { dir, p, candidate } = await crashed()
    // Some files already at HEAD's version, others still the candidate's.
    writeFileSync(join(dir, "perf.txt"), "100\n")
    writeFileSync(join(dir, "lib.txt"), "a\nb\nc\nd\ne\n")
    rmSync(join(dir, "new"), { recursive: true })
    expect(await p.pause("s", "stopping")).toContain("Loop paused")
    expect(snapshot(dir)).toEqual(candidate)
    expect(swapMarkers(p)).toEqual([])
    expect(p.said("s").at(-1)).toContain("uncommitted changes")
  })

  test("only the marker is left (killed right after the files were put back): nothing to do, nothing said", async () => {
    const { dir, p, candidate } = await crashed()
    const out = await p.log("s", { status: "keep" })
    expect(out).not.toContain("NOTE")
    expect(out).toContain("logged as keep")
    expect(snapshot(dir)).toEqual(candidate)
  })

  test("someone edited a file since: nothing is overwritten, the loop pauses, and it works once the edit is gone", async () => {
    const { dir, p, candidate } = await crashed()
    await toHead(dir)
    writeFileSync(join(dir, "code.txt"), "edited after the crash\n")
    const out = await p.run("s")
    expect(out).toContain("ERROR")
    expect(out).toContain("could not be put back")
    expect(out).toContain("code.txt")
    expect(readFileSync(join(dir, "code.txt"), "utf8")).toBe("edited after the crash\n")
    expect(readFileSync(join(dir, "perf.txt"), "utf8")).toBe("100\n")
    expect(p.active("s")).toBeUndefined()
    expect(p.said("s").at(-1)).toContain("saved in git as tree")
    expect(swapMarkers(p)).toHaveLength(1)
    // `/autoresearch` doesn't start over a tree that isn't what it seems…
    p.sent.length = 0
    await p.cmd("s", "")
    expect(p.active("s")).toBeUndefined()
    expect(p.said("s").join("\n")).toContain("Not started")
    // …and once the edit is out of the way, it puts the experiment back and says so.
    writeFileSync(join(dir, "code.txt"), "v1\n")
    await p.cmd("s", "")
    expect(snapshot(dir)).toEqual(candidate)
    expect(swapMarkers(p)).toEqual([])
    expect(p.said("s").at(-1)).toContain("put back exactly as measured")
    expect(p.said("s").at(-1)).toContain("uncommitted changes") // an unfinished experiment: the user decides
  })

  test("the commit changed since: nothing is touched, the marker is dropped and the tree id is given", async () => {
    const { dir, p, fp } = await crashed()
    await toHead(dir)
    writeFileSync(join(dir, "user.txt"), "the user's commit\n")
    g(dir, "add", "user.txt")
    g(dir, "commit", "-qm", "user commit")
    await p.cmd("s", "status")
    const text = p.said("s").at(-1)!
    expect(text).toContain("was not restored")
    expect(text).toContain(fp.tree)
    expect(readFileSync(join(dir, "perf.txt"), "utf8")).toBe("100\n")
    expect(swapMarkers(p)).toEqual([])
    // The tree really holds the experiment.
    expect(g(dir, "show", `${fp.tree}:perf.txt`)).toBe("90\n")
  })

  test("plugin start: the experiment is put back before the loop is continued", async () => {
    timing.startupDelayMs = 20
    try {
      const { dir, p, candidate } = await crashed()
      await toHead(dir)
      const q = await boot(dir, { s: dir }, p.storage) // the restarted process
      await until(() => q.said("s").some((t) => t.includes("Continue the experiment loop")))
      expect(q.said("s").at(-1)).toContain("put back exactly as measured")
      expect(snapshot(dir)).toEqual(candidate)
    } finally {
      timing.startupDelayMs = 5_000
    }
  })
})

// ── v0.2.1: frozen inputs and the other fixes ─────────────

describe("helper files under .auto/ are frozen with the benchmark", () => {
  test("editing a file the benchmark reads is refused like an edited measure.sh; session notes aren't frozen", async () => {
    const dir = repo()
    writeFileSync(join(dir, ".auto", "scale"), "1000\n")
    mkdirSync(join(dir, ".auto", "data"))
    writeFileSync(join(dir, ".auto", "data", "input.json"), "[1,2,3]\n")
    const p = await boot(dir, { s: dir })
    await p.cmd("s", "goal")
    const init = await p.init("s")
    expect(init).toContain("data/input.json, scale")
    await p.run("s")
    await p.log("s", { status: "keep" })

    // prompt.md, ideas.md and config.json change during a session by design.
    writeFileSync(join(dir, ".auto", "prompt.md"), "rules, updated\n")
    writeFileSync(join(dir, ".auto", "ideas.md"), "- idea\n")
    writeFileSync(join(dir, ".auto", "config.json"), '{"maxIterations": 40}')
    setPerf(dir, 90)
    expect(await p.run("s")).toContain("Log `keep`")

    // The cheat from the live test: make the workload smaller instead of the code faster.
    writeFileSync(join(dir, ".auto", "scale"), "10\n")
    expect(await p.log("s", { status: "keep" })).toContain("benchmark files changed (under .auto/: scale)")
    const n = calls(dir)
    const out = await p.run("s")
    expect(out).toContain("ERROR: The benchmark changed: a helper file under .auto/")
    expect(calls(dir)).toBe(n)
    await p.cmd("s", "status")
    expect(p.said("s").at(-1)).toContain("Warning: The benchmark files differ")
    writeFileSync(join(dir, ".auto", "scale"), "1000\n")
    expect(await p.run("s")).toContain("Log `keep`")
    writeFileSync(join(dir, ".auto", "data", "input.json"), "[1]\n")
    expect(await p.run("s")).toContain("The benchmark changed")
  })

  test("a benchmark that writes under .auto/ is told so (not 'the benchmark changed' one run later)", async () => {
    const { dir, p } = await started({ measure: MEASURE + "echo $RANDOM$RANDOM > .auto/last-output\n" })
    await p.init("s")
    const out = await p.run("s")
    expect(out).toContain("The benchmark itself changed files: .auto/last-output")
    expect(out).toContain("gitignored path or outside the project")
    expect(await p.log("s", { status: "keep" })).toContain("benchmark changed files while measuring (.auto/last-output)")
    expect(runsOf(dir)).toHaveLength(0)
  })

  test("a segment started before v0.2.1 (no inputs_hash) keeps working", async () => {
    const { dir, p } = await withBaseline()
    const log = join(dir, ".auto", "log.jsonl")
    writeFileSync(log, readFileSync(log, "utf8").replace(/,"inputs_hash":"[0-9a-f]+"/, ""))
    expect(logOf(dir)[0].inputs_hash).toBeUndefined()
    writeFileSync(join(dir, ".auto", "notes.txt"), "x\n")
    setPerf(dir, 90)
    expect(await p.run("s")).toContain("Log `keep`")
  })
})

describe("v0.2.1 fixes", () => {
  const continues = (p: Awaited<ReturnType<typeof boot>>, sid = "s") =>
    p.sent.filter((s) => s.kind === "synthetic" && s.sessionID === sid && s.delivery === "queue" && /Continue the experiment loop/.test(s.text))

  test("unknown tool arguments are rejected by name, and nothing runs", async () => {
    const { dir, p } = await withBaseline()
    const n = calls(dir)
    const out = await p.run("s", { command: "./fast.sh", repeat: 1 })
    expect(out).toContain("ERROR: Unknown arguments `command`, `repeat`")
    expect(out).toContain("always ./.auto/measure.sh")
    expect(calls(dir)).toBe(n)
    expect(await p.init("s", { command: "x" })).toContain("Unknown argument `command`")
    expect(logOf(dir).filter((e) => e.type === "config")).toHaveLength(1)
    expect(await p.pause("s", "why")).toContain("Loop paused")
  })

  test("/autoresearch on trunk without session files, while an autoresearch branch holds the session: points there, starts nothing", async () => {
    const dir = repo()
    g(dir, "checkout", "-q", "main")
    g(dir, "rm", "-rq", ".auto")
    g(dir, "commit", "-qm", "main has no session files")
    g(dir, "branch", "autoresearch/unrelated", "main") // an autoresearch/* branch without this folder's session
    const p = await boot(dir, { s: dir })
    await p.cmd("s", "make it faster")
    expect(p.active("s")).toBeUndefined()
    const said = p.said("s").join("\n")
    expect(said).toContain("exists on `autoresearch/test`")
    expect(said).toContain("git switch autoresearch/test")
    expect(said).not.toContain("autoresearch/unrelated")
    expect(p.sent.some((s) => s.kind === "prompt")).toBe(false)
    // A separate new session is still possible: on its own branch.
    g(dir, "checkout", "-q", "-b", "autoresearch/second")
    await p.cmd("s", "another goal")
    expect(p.active("s")).toMatchObject({ setup: true })
  })

  test("start-up continue: not for a loop turned on after the plugin started, nor for one that stopped meanwhile", async () => {
    timing.startupDelayMs = 150
    try {
      // The live bug: fresh project, plugin loads, the command turns the loop on right away.
      const dir = repo()
      const p = await boot(dir, { s: dir })
      await p.cmd("s", "goal")
      await sleep(400)
      expect(continues(p)).toHaveLength(0)

      // On at start, off (or off and on again) before the timer fires.
      const storage = new Map<string, any>()
      const loop = { directory: dir, startRunCount: 0, lastRunCount: 0, stalls: 0, failures: 0, since: "2026-01-01T00:00:00.000Z" }
      storage.set("active/paused", loop)
      storage.set("active/restarted", loop)
      storage.set("active/steady", loop)
      const q = await boot(dir, { paused: dir, restarted: dir, steady: dir }, storage)
      storage.delete("active/paused")
      storage.set("active/restarted", { ...loop, since: "2026-01-02T00:00:00.000Z" })
      await until(() => continues(q, "steady").length === 1)
      await sleep(100)
      expect(continues(q, "paused")).toHaveLength(0)
      expect(continues(q, "restarted")).toHaveLength(0)
    } finally {
      timing.startupDelayMs = 5_000
    }
  })

  test("a stop nobody may have seen (interrupt) is repeated by the next /autoresearch, once", async () => {
    const { p } = await withBaseline()
    p.emit("session.execution.interrupted", "s")
    await until(() => !p.active("s"))
    p.sent.length = 0
    await p.cmd("s", "")
    expect(p.active("s")).toBeDefined()
    expect(p.said("s").join("\n")).toContain("why the loop had stopped before this start")
    expect(p.said("s").join("\n")).toContain("session was stopped")
    // A stop the user was told about in a turn of its own isn't repeated.
    await p.cmd("s", "off")
    p.sent.length = 0
    await p.cmd("s", "")
    expect(p.said("s").join("\n")).not.toContain("why the loop had stopped")
  })

  test("the user's git hooks don't run on the plugin's git calls", async () => {
    const { dir, p } = await withBaseline()
    for (const name of ["post-index-change", "post-checkout", "post-commit"]) {
      const hook = join(dir, ".git", "hooks", name)
      writeFileSync(hook, "#!/bin/sh\necho ran >> .bench/hook-ran\n")
      chmodSync(hook, 0o755)
    }
    g(dir, "reset", "-q") // the hook is live: git writes the index here
    expect(existsSync(join(dir, ".bench", "hook-ran"))).toBe(true)
    rmSync(join(dir, ".bench", "hook-ran"))

    setPerf(dir, 90)
    await p.run("s")
    expect(await p.log("s", { status: "keep" })).toContain("logged as keep")
    writeFileSync(join(dir, "code.txt"), "worse\n")
    await p.run("s")
    expect(await p.log("s", { status: "discard" })).toContain("logged as discard")
    await p.cmd("s", "status")
    expect(existsSync(join(dir, ".bench", "hook-ran"))).toBe(false)
  })

  test("status covers the whole session: one line per segment, kept counts without baselines, compounded gain", async () => {
    const { dir, p } = await withBaseline()
    setPerf(dir, 90)
    await p.run("s")
    await p.log("s", { status: "keep" })
    setPerf(dir, 81)
    await p.run("s")
    const kept = await p.log("s", { status: "keep" })
    // 100 → 90 and 90 → 81, each measured back to back: 0.9 × 0.9 = 0.81.
    expect(kept).toContain("Segment 1 so far: 2 kept, 19.0% better overall")
    writeFileSync(join(dir, "code.txt"), "worse\n")
    setValue(dir, 120)
    await p.run("s")
    const discarded = await p.log("s", { status: "discard" })
    expect(discarded).toContain("runs without a keep since the loop was last started: 1 (the loop pauses at 10)")

    writeFileSync(join(dir, ".auto", "measure.sh"), MEASURE + "# a new workload\n")
    commitBenchmark(dir)
    expect(await p.init("s", { name: "second" })).toContain("segment 2")
    setValue(dir, "CODE")
    await p.run("s")
    await p.log("s", { status: "keep" })
    await p.cmd("s", "status")
    const text = p.said("s").at(-1)!
    expect(text).toContain('Segment 1 "t": 4 runs, 2 kept, 19.0% better overall')
    expect(text).toContain("measured at the time: baseline 100, current 81")
    expect(text).toContain('Segment 2 "second" (current): 1 run, 0 kept · measured at the time: baseline 81, current 81')
    expect(text).toContain("Runs: 5/50 in total · 2 kept experiments in 2 segments")
    expect(text).not.toMatch(/[+-]\d+(\.\d+)?%/)
  })

  test("the pinned rules: a permission error or rejection, net deletion, frozen helper files", async () => {
    const { p } = await started()
    const pinned = p.sent.find((s) => s.kind === "instruction").value as string
    expect(pinned).toContain("a permission error or rejection")
    expect(pinned).not.toContain("Permission denied")
    expect(pinned).toContain("removes more lines than it adds")
    expect(pinned).toContain("any helper file under .auto/")
  })
})
