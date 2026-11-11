import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildCompactionSummary } from "./compaction.ts"

function project(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "ar-compact-"))
  mkdirSync(join(dir, ".auto"))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, ".auto", name), body)
  return dir
}

const jsonl = (...entries: object[]) => entries.map((e) => JSON.stringify(e)).join("\n") + "\n"
const config = { type: "config", segment: 1, name: "speed up tests", metric_name: "total_s", metric_unit: "s", direction: "lower", timestamp: "" }
const run = (n: number, status: string, metric: number, description: string, asi = {}) =>
  ({ type: "run", segment: 1, run: n, status, metric, metrics: {}, description, asi, commit: null, confidence: null, timestamp: "" })

describe("buildCompactionSummary", () => {
  test("carries goal, best, rules, ideas, runs with notes, and the user's own messages", async () => {
    const dir = project({
      "log.jsonl": jsonl(
        config,
        run(1, "keep", 40, "baseline"),
        run(2, "discard", 41, "swap runner", { hypothesis: "threads faster", learned: "IPC overhead dominates" }),
        run(3, "keep", 30, "parallel db tests", { next_focus: "fixtures" }),
        run(4, "crash", 0, "native addon"),
      ),
      "prompt.md": "# Autoresearch: tests\n\n## Off Limits\nsrc/legacy/",
      "ideas.md": "- cache fixtures",
    })
    const s = await buildCompactionSummary(dir, [
      "Set up and start an autoresearch session. Goal: speed up tests",
      "[autoresearch] Continue the experiment loop.",
      "please don't touch the e2e folder",
    ])

    expect(s).toContain("Goal: speed up tests")
    expect(s).toContain("Best: 30s (-25.0%)")
    expect(s).toContain("1 discard")
    expect(s).toContain("src/legacy/") // rules from prompt.md
    expect(s).toContain("- cache fixtures") // ideas backlog
    expect(s).toContain("learned: IPC overhead dominates")
    expect(s).toContain("next: fixtures")
    expect(s).toMatch(/#4 crash\s+—/) // crash's placeholder metric isn't shown as a value
    expect(s).toContain("please don't touch the e2e folder")
    // the plugin's own auto-continue prompts are filtered out of the user's messages
    const userSection = s.split("## What the user said")[1].split("\n## ")[0]
    expect(userSection).not.toContain("[autoresearch]")
  })

  test("works before any run, and without optional files", async () => {
    const s = await buildCompactionSummary(project({}), [])
    expect(s).toContain("No `init_experiment` yet")
    expect(s).toContain("No runs yet")
    expect(s).not.toContain("Ideas backlog")
    expect(s).not.toContain("What the user said")
  })

  test("truncates a huge prompt.md", async () => {
    const s = await buildCompactionSummary(project({ "prompt.md": "x".repeat(50_000) }), [])
    expect(s.length).toBeLessThan(15_000)
    expect(s).toContain("truncated; read .auto/prompt.md")
  })
})
