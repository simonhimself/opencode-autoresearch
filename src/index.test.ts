// The whole plugin, driven through a small fake of OpenCode's plugin context against real
// git repos. Each case is a way the earlier version could be made to lie about a result or
// to damage the user's work (see docs/design.md).

import { afterAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "./index.ts"
import { timing } from "./timing.ts"
import { headTree } from "./shell.ts"
import type { ConfigEntry, RunEntry } from "./state.ts"

const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" })

// The benchmark reads its numbers from .auto/ (outside the scope, so setting them doesn't
// change the measured tree): each call takes the next line of .auto/queue, or .auto/value
// when the queue is empty. "FAIL" exits 1; "NONE" prints no metric.
const MEASURE = `#!/bin/bash
q=.auto/queue
if [ -s "$q" ]; then v=$(head -n1 "$q"); tail -n +2 "$q" > "$q.tmp"; mv "$q.tmp" "$q"; else v=$(cat .auto/value); fi
echo run >> .auto/calls
[ "$v" = FAIL ] && { echo boom; exit 1; }
[ "$v" = NONE ] && exit 0
echo "METRIC ms=$v"
echo "METRIC extra=7"
`

/** A committed project on an experiment branch, with .auto/prompt.md and measure.sh committed. */
function repo(opts: { branch?: string; measure?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ar-plugin-"))
  g(dir, "init", "-q", "-b", "main")
  g(dir, "config", "user.email", "t@t")
  g(dir, "config", "user.name", "t")
  writeFileSync(join(dir, "code.txt"), "v1\n")
  writeFileSync(join(dir, ".gitignore"), "ignored/\n")
  mkdirSync(join(dir, ".auto"))
  writeFileSync(join(dir, ".auto", "prompt.md"), "rules\n")
  writeFileSync(join(dir, ".auto", "measure.sh"), opts.measure ?? MEASURE)
  chmodSync(join(dir, ".auto", "measure.sh"), 0o755)
  g(dir, "add", "-A")
  g(dir, "commit", "-qm", "init")
  if (opts.branch !== "main") g(dir, "checkout", "-q", "-b", opts.branch ?? "autoresearch/test")
  writeFileSync(join(dir, ".auto", "value"), "100\n")
  return dir
}

const setValue = (dir: string, v: string | number) => writeFileSync(join(dir, ".auto", "value"), `${v}\n`)
const setQueue = (dir: string, values: (string | number)[]) => writeFileSync(join(dir, ".auto", "queue"), values.map((v) => `${v}\n`).join(""))
const calls = (dir: string) => (existsSync(join(dir, ".auto", "calls")) ? readFileSync(join(dir, ".auto", "calls"), "utf8").split("\n").filter(Boolean).length : 0)
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
  const tctx = (sessionID: string) => ({
    sessionID,
    agent: "a",
    messageID: "m",
    id: "c",
    signal: new AbortController().signal,
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
    log: (sid: string, i: any) => text(tools.log.execute({ description: "an experiment", ...i }, tctx(sid))),
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
    writeFileSync(join(dir, "code.txt"), "experiment in progress\n") // dirty tree: normal mid-experiment
    setValue(dir, 90)
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
    g(dir, "checkout", "-q", "main")
    rmSync(join(dir, ".auto", "prompt.md"))
    g(dir, "commit", "-qam", "prompt removed")
    await p.cmd("s", "new goal") // setup mode, on main, config entry exists
    expect(p.active("s")).toMatchObject({ setup: true })
    writeFileSync(join(dir, "code.txt"), "edit on main\n")
    expect(await p.run("s")).toContain("call autoresearch_init first")
    expect(await p.log("s", { status: "discard" })).toContain("call autoresearch_init first")
    expect(readFileSync(join(dir, "code.txt"), "utf8")).toBe("edit on main\n")
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
    await p.init("s", { repeat: undefined })
    const config = logOf(dir)[0] as ConfigEntry
    expect(config).toMatchObject({ type: "config", segment: 1, name: "t", metric_name: "ms", direction: "lower", repeat: 5 })
    expect(config.measure_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(config.checks_hash).toMatch(/^[0-9a-f]{64}$/)
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
    setQueue(dir, [90, 91, 89, /* confirmation: */ 92, 93, 91])
    const runOut = await p.run("s")
    expect(runOut).toContain("better")
    expect(runOut).toContain("Log `keep`")
    const measuredTree = p.storage.get("run/s").fingerprint.tree
    const before = head(dir)

    const out = await p.log("s", { status: "keep", description: "use `fast` path $(touch INJ)", asi: { learned: "x" } })
    expect(out).toContain("logged as keep @")
    expect(out).toContain("Confirmed")
    expect(out).toContain("baseline 100 → current 92")

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
      first_metric: 90,
      vs: 100,
      commit: head(dir).slice(0, 7),
      asi: { learned: "x" },
    })
    expect(entry.confidence!).toBeGreaterThan(2)
    expect(entry.baseline).toBeUndefined()
    expect(p.active("s").head).toBe(head(dir))
    expect(p.storage.get("run/s")).toBeUndefined()
  })

  test("a keep that isn't confirmed is reverted and logged as discard with a note", async () => {
    const { dir, p } = await withBaseline()
    writeFileSync(join(dir, "code.txt"), "no-op change\n")
    writeFileSync(join(dir, "new-file.txt"), "new\n")
    setQueue(dir, [95, 96, 94, /* confirmation: back at the old level */ 100.5, 101, 99.5])
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
      first_metric: 95,
      vs: 100,
      commit: null,
      confidence: null,
      note: "keep not confirmed: first 95, confirmed 100.5, current 100",
    })
    // The same measurement can't be logged again.
    expect(await p.log("s", { status: "keep" })).toContain("No unlogged run")
  })

  test("a confirmation run that crashes counts as not confirmed", async () => {
    const { dir, p } = await withBaseline()
    writeFileSync(join(dir, "code.txt"), "flaky\n")
    setQueue(dir, [90, 90, 90, 90, "FAIL"])
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
    setValue(dir, 90)
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

  test("simplification: kept as neutral when not worse beyond the noise", async () => {
    const { dir, p } = await withBaseline()
    setQueue(dir, [100, 101, 99]) // (baseline samples were all 100: give current some spread via a first real keep)
    writeFileSync(join(dir, "code.txt"), "v2\n")
    setQueue(dir, [90, 91, 89, 90, 91, 89])
    await p.run("s")
    await p.log("s", { status: "keep" })

    writeFileSync(join(dir, "code.txt"), "v2, less code\n")
    setQueue(dir, [90.2, 91, 89.5, 90.3, 91.2, 89.4])
    await p.run("s")
    const out = await p.log("s", { status: "keep", simplification: true, description: "remove dead branch" })
    expect(out).toContain("(simplification)")
    expect(runsOf(dir)[2]).toMatchObject({ status: "keep", neutral: true, metric: 90.3 })
    expect(g(dir, "log", "-1", "--format=%s").trim()).toContain("simplification")

    // …and reverted when it's clearly worse.
    writeFileSync(join(dir, "code.txt"), "v2, simpler but slow\n")
    setQueue(dir, [99, 100, 98, 99, 100, 98])
    await p.run("s")
    expect(await p.log("s", { status: "keep", simplification: true })).toContain("NOT confirmed")
    expect(readFileSync(join(dir, "code.txt"), "utf8")).toBe("v2, less code\n")
  })

  test("the next candidate is compared with current (the last keep), not with a best-ever", async () => {
    const { dir, p } = await withBaseline()
    writeFileSync(join(dir, "code.txt"), "v2\n")
    setQueue(dir, [90, 91, 89, 90, 91, 89])
    await p.run("s")
    await p.log("s", { status: "keep" })
    writeFileSync(join(dir, "code.txt"), "v3\n")
    setValue(dir, 95) // better than the baseline, worse than current
    const out = await p.run("s")
    expect(out).toContain("current is 90")
    expect(out).toContain("worse")
  })

  test("deterministic metric with repeat 1 needs minImprovement twice", async () => {
    const { dir, p } = await withBaseline({}, { repeat: 1 })
    writeFileSync(join(dir, "code.txt"), "v2\n")
    setQueue(dir, [98, 99.5]) // first −2 %, confirmation only −0.5 %
    await p.run("s")
    expect(await p.log("s", { status: "keep" })).toContain("NOT confirmed")
    writeFileSync(join(dir, "code.txt"), "v3\n")
    setQueue(dir, [97, 98])
    await p.run("s")
    expect(await p.log("s", { status: "keep" })).toContain("logged as keep")
    expect(runsOf(dir).at(-1)).toMatchObject({ metric: 98, samples: [98], noise: null, confidence: null })
  })

  test("a failed commit doesn't re-roll the confirmation", async () => {
    const { dir, p } = await withBaseline()
    writeFileSync(join(dir, "code.txt"), "v2\n")
    setQueue(dir, [90, 91, 89, 92, 93, 91])
    await p.run("s")
    writeFileSync(join(dir, ".git", "index.lock"), "") // makes git add fail
    const n = calls(dir)
    expect(await p.log("s", { status: "keep" })).toContain("Couldn't commit")
    expect(calls(dir)).toBe(n + 3)
    rmSync(join(dir, ".git", "index.lock"))
    expect(await p.log("s", { status: "keep" })).toContain("logged as keep")
    expect(calls(dir)).toBe(n + 3) // judged on the stored confirmation
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
    // `metric` and `metrics` aren't inputs any more; extra fields are ignored.
    const out = await p.log("s", { status: "discard", metric: 1, metrics: { extra: 0 } })
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
    // The legitimate path: a new segment, visible in the log, with its own baseline.
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
    writeFileSync(join(dir, "code.txt"), "v2\n")
    setQueue(dir, [90, 91, 89, 90, 91, 89])
    p.sent.length = 0
    await p.run("s")
    await p.log("s", { status: "keep" })
    const asserts = p.sent.filter((s) => s.kind === "assert")
    expect(asserts[0]).toEqual({ kind: "assert", resources: ["./.auto/measure.sh"], save: ["./.auto/measure.sh"] })
    expect(asserts[1].resources[0]).toBe("./.auto/measure.sh")
    expect(asserts[1].resources[1]).toStartWith("git add -A -- .")
    expect(asserts[1].resources[2]).toStartWith("git -c commit.gpgsign=false -c core.hooksPath=/dev/null commit --no-verify")
    expect(asserts[1].save).toEqual(asserts[1].resources)
    expect(asserts[2].resources[0]).toStartWith("git restore --source=HEAD --staged --worktree -- .")
    expect(asserts[2].resources[1]).toStartWith("git clean -fd -- .")
    expect(asserts[2].save).toBeUndefined()
  })

  test("a denied permission propagates and nothing is changed or logged", async () => {
    const { dir, p } = await withBaseline()
    writeFileSync(join(dir, "code.txt"), "v2\n")
    setValue(dir, 120)
    await p.run("s")
    p.deny(/git clean/)
    await expect(p.log("s", { status: "discard" })).rejects.toThrow("Permission denied")
    expect(readFileSync(join(dir, "code.txt"), "utf8")).toBe("v2\n")
    expect(runsOf(dir)).toHaveLength(1)
    p.deny(null)
    // A keep asks for the revert permission up front, before spending time on confirmation.
    setValue(dir, 90)
    await p.run("s")
    const n = calls(dir)
    p.deny(/git restore/)
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
    expect(out).toContain("without an improvement")
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
    writeFileSync(join(dir, "code.txt"), "v2\n")
    setQueue(dir, [90, 91, 89, 90, 91, 89])
    await p.run("s")
    await p.log("s", { status: "keep" })
    writeFileSync(join(dir, ".auto", "config.json"), '{"maxIterations": "lots", "maxNoImprovement": 7}')
    writeFileSync(join(dir, ".auto", "measure.sh"), MEASURE + "# edited\n")
    await p.cmd("s", "status")
    const text = p.said("s").at(-1)!
    expect(text).toContain("Loop: ON · branch autoresearch/test")
    expect(text).toContain("baseline 100 → current 90 (-10.0%)")
    expect(text).toContain("Runs: 2/50")
    expect(text).toContain("maxNoImprovement 7 (now 0 in a row)")
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
    await p.init("s")
    const out = await p.run("s")
    expect(out).toContain("ms: 5")
    expect(out.length).toBeLessThan(5_000)
    expect(out).toContain("line cut")
  })
})
