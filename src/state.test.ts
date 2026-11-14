import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  compoundedLevel,
  DEFAULT_SETTINGS,
  gainText,
  keepRatio,
  keptRuns,
  levelText,
  median,
  medianPairGain,
  noImprovementStreak,
  pairGain,
  parseMetrics,
  pText,
  readSettings,
  relativeGain,
  segmentSummaries,
  summarize,
  type LogEntry,
  type Pair,
  type RunEntry,
} from "./state.ts"
import { buildCompactionSummary } from "./compaction.ts"

const run = (metric: number | null, status: RunEntry["status"], extra: Partial<RunEntry> = {}) =>
  ({ type: "run", metric, status, ...extra }) as RunEntry

describe("parseMetrics", () => {
  test("reads METRIC lines and ignores noise", () => {
    const out = "building...\nMETRIC total_ms=41.5\nMETRIC heap_mb=120\nMETRIC bad=abc\nnot METRIC x=1\n"
    expect(parseMetrics(out)).toEqual({ total_ms: 41.5, heap_mb: 120 })
  })
})

describe("summarize", () => {
  test("baseline is the first keep, current the last keep; no best-of-all", () => {
    // 80 was measured once and discarded; 70 is a crash placeholder. Neither may become "current".
    const runs = [run(100, "keep"), run(80, "discard"), run(90, "keep"), run(70, "crash"), run(95, "keep")]
    expect(summarize(runs, "lower")).toEqual({ baseline: 100, current: 95, best: 95 })
    // Direction doesn't matter: current is positional, not the best value seen.
    expect(summarize(runs, "higher")).toEqual({ baseline: 100, current: 95, best: 95 })
  })
  test("no keep yet", () => {
    expect(summarize([run(null, "crash")])).toEqual({ baseline: null, current: null, best: null })
  })
})

describe("noImprovementStreak", () => {
  const entries = [
    run(100, "keep", { baseline: true }),
    run(99, "keep"),
    run(101, "discard"),
    run(null, "crash"),
    run(100, "keep", { baseline: true }), // a new segment's baseline isn't an improvement
  ] as LogEntry[]
  test("counts trailing runs without a keep; baselines are neither", () => {
    expect(noImprovementStreak(entries)).toBe(2)
    expect(noImprovementStreak([...entries, run(98, "keep")] as LogEntry[])).toBe(0)
  })
  test("starts fresh from the run count at which the loop was turned on", () => {
    expect(noImprovementStreak(entries, 3)).toBe(1)
    expect(noImprovementStreak(entries, 4)).toBe(0)
  })
})

describe("pairs", () => {
  test("pairGain: how much better the candidate run was than the HEAD run next to it", () => {
    expect(pairGain([100, 92], "lower")).toBeCloseTo(0.08)
    expect(pairGain([100, 92], "higher")).toBeCloseTo(-0.08)
    expect(pairGain([100, 100], "lower")).toBe(0)
    expect(pairGain([0, 5], "higher")).toBe(Infinity) // from zero: no NaN
    expect(pairGain([0, 0], "lower")).toBe(0)
  })
  test("medianPairGain: the median of the pairs' results, so one burst doesn't move it", () => {
    const pairs: Pair[] = [[100, 95], [140, 96], [100, 94]] // a burst on HEAD's run in pair 2
    expect(medianPairGain(pairs, "lower")).toBeCloseTo(0.06)
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 2, 3])).toBe(2.5)
  })
  test("pText: the wording of a p-value", () => {
    expect([1 / 256, 0.0005, 0.21, 0.098].map(pText)).toEqual(["p = 0.004", "p < 0.001", "p = 0.21", "p = 0.098"])
  })
})

describe("compounded level", () => {
  /** A keep as v0.2.2 writes it: `gain` from its decision pairs. */
  const keep = (gain: number, extra: Partial<RunEntry> = {}) => run(100, "keep", { gain, ...extra })
  /** A keep as v0.2.1 wrote it: candidate and HEAD medians, no `gain`. */
  const oldKeep = (metric: number, vs: number, extra: Partial<RunEntry> = {}) => run(metric, "keep", { vs, ...extra })

  test("lower is better: 100 → 90 → 81 is 19 % lower, not 21 % better; and not current / baseline", () => {
    // The baseline was logged at 100 on a slow day; the two keeps were each 10 % lower
    // than HEAD in their own pairs, at whatever speed the machine had then.
    const runs = [run(100, "keep", { baseline: true }), keep(0.1, { metric: 72 }), run(70, "discard", { gain: 0.03 }), keep(0.1, { metric: 108 })]
    const g = compoundedLevel(runs, "lower")
    expect(g.level).toBeCloseTo(0.81)
    expect(g).toMatchObject({ keeps: 2, skipped: 0, simplifications: 0 })
    expect(levelText(g.level, "lower")).toBe("19.0% lower than the baseline")
    // current / baseline would say "8 % worse".
    expect(summarize(runs)).toMatchObject({ baseline: 100, current: 108 })
    // Two halvings are 75 % lower; the old product of (1 + gain) said "125 % better".
    expect(levelText(compoundedLevel([keep(0.5), keep(0.5)], "lower").level, "lower")).toBe("75.0% lower than the baseline")
  })

  test("higher is better: 100 → 110 → 121 is 21 % higher", () => {
    const g = compoundedLevel([run(100, "keep", { baseline: true }), keep(0.1), keep(0.1)], "higher")
    expect(g.level).toBeCloseTo(1.21)
    expect(levelText(g.level, "higher")).toBe("21.0% higher than the baseline")
  })

  test("a simplification keep counts as no change: its measured difference is noise", () => {
    const runs = [run(100, "keep", { baseline: true }), keep(0.1), keep(-0.008, { neutral: true }), keep(0.004, { neutral: true }), keep(0.1)]
    const g = compoundedLevel(runs, "lower")
    expect(g.level).toBeCloseTo(0.81)
    expect(g).toMatchObject({ keeps: 2, simplifications: 2 })
    expect(levelText(g.level, "lower")).toBe("19.0% lower than the baseline")
    expect(keptRuns(runs)).toHaveLength(4) // they are kept experiments all the same
  })

  test("levelText: the metric's own direction, and \"(worse)\" on the wrong side", () => {
    expect(levelText(0.95, "lower")).toBe("5.0% lower than the baseline")
    expect(levelText(1.05, "lower")).toBe("5.0% higher than the baseline (worse)")
    expect(levelText(1.05, "higher")).toBe("5.0% higher than the baseline")
    expect(levelText(0.95, "higher")).toBe("5.0% lower than the baseline (worse)")
    expect(levelText(1, "lower")).toBe("no change from the baseline")
    expect(levelText(0.9996, "lower")).toBe("0.04% lower than the baseline") // not "0.0%"
    // A lower-is-better level can't read more than 100 % lower: it is a product of positive ratios.
    expect(levelText(compoundedLevel([keep(0.9), keep(0.9)], "lower").level, "lower")).toBe("99.0% lower than the baseline")
    // Net worse from keeps: one 10 % worse, one 2 % better.
    expect(levelText(compoundedLevel([keep(-0.1), keep(0.02)], "lower").level, "lower")).toBe("7.8% higher than the baseline (worse)")
  })

  test("keepRatio: candidate / HEAD from `gain`, from the pairs, or from metric / vs", () => {
    expect(keepRatio(keep(0.1), "lower")).toBeCloseTo(0.9)
    expect(keepRatio(keep(0.1), "higher")).toBeCloseTo(1.1)
    // The logged `gain` of a lower-is-better pair is (HEAD − candidate) / HEAD, i.e. the reduction 1 − r.
    expect(pairGain([100, 90], "lower")).toBeCloseTo(0.1)
    expect(keepRatio(run(90, "keep", { pairs: [[100, 90]] }), "lower")).toBeCloseTo(0.9)
    expect(keepRatio(oldKeep(72, 80), "lower")).toBeCloseTo(0.9)
    expect(keepRatio(oldKeep(72, 80), "higher")).toBeCloseTo(0.9) // a ratio has no direction
    expect(keepRatio(keep(1), "lower")).toBeUndefined() // a candidate of zero: no ratio to multiply with
    expect(keepRatio(run(5, "keep"), "lower")).toBeUndefined()
  })

  test("`gain` missing: taken from the pairs; a keep without a usable number is skipped", () => {
    const fromPairs = run(95, "keep", { pairs: [[100, 95], [100, 94], [100, 96]] })
    expect(compoundedLevel([fromPairs], "lower").level).toBeCloseTo(0.95)
    expect(compoundedLevel([keep(null as never), run(200, "keep")], "lower")).toMatchObject({ level: 1, keeps: 0, skipped: 2 })
    expect(compoundedLevel([run(100, "keep", { baseline: true })], "lower")).toMatchObject({ level: 1, keeps: 0 })
  })

  test("keeps written before v0.2.2 count with metric / vs, and mix with new ones", () => {
    const old = [run(100, "keep", { baseline: true }), oldKeep(72, 80), run(70, "discard", { vs: 72 }), oldKeep(108, 120)]
    expect(compoundedLevel(old, "lower").level).toBeCloseTo(0.81)
    expect(compoundedLevel([...old, keep(0.1)], "lower").level).toBeCloseTo(0.729)
    const higher = [run(50, "keep", { baseline: true, vs: 1 }), oldKeep(110, 100), oldKeep(5, 0), run(200, "keep"), run(999, "discard", { vs: 1 })]
    const g = compoundedLevel(higher, "higher")
    expect(g.level).toBeCloseTo(1.1)
    expect(g).toMatchObject({ keeps: 1, skipped: 2 })
  })

  test("status and compaction read the same number from the same log", async () => {
    // Lower is better: two confirmed keeps of 10 % each, a simplification between them, a
    // keep that wasn't confirmed, and one that crashed while it was measured again.
    const ps = (head: number, gain: number, n = 8) => Array.from({ length: n }, () => [head, head * (1 - gain)] as Pair)
    const entry = (n: number, status: string, head: number, gain: number | null, extra: object = {}) => ({
      type: "run", segment: 1, run: n, status, metric: head * (1 - (gain ?? 0)), description: "d", asi: {}, commit: null,
      pairs: ps(head, gain ?? 0.136, gain === null ? 2 : 8), gain, p: gain === null ? null : 0.004, vs: head, ...extra,
    })
    const entries = [
      { type: "config", segment: 1, name: "t", metric_name: "ms", metric_unit: "ms", direction: "lower", repeat: 5 },
      { type: "run", segment: 1, run: 1, status: "keep", metric: 100, baseline: true, description: "baseline", asi: {} },
      entry(2, "keep", 100, 0.1),
      entry(3, "keep", 90, -0.008, { neutral: true }),
      entry(4, "keep", 90, 0.1),
      entry(5, "discard", 81, 0.006, { p: 0.21, note: "keep not confirmed" }),
      entry(6, "discard", 81, null, { metric: null, note: "keep not confirmed: crash while the candidate was measured again (pair 3)" }),
    ]
    const dir = mkdtempSync(join(tmpdir(), "ar-level-"))
    mkdirSync(join(dir, ".auto"))
    writeFileSync(join(dir, ".auto", "log.jsonl"), entries.map((e) => JSON.stringify(e)).join("\n") + "\n")

    const [seg] = segmentSummaries(entries as LogEntry[])
    expect(seg.level).toBeCloseTo(0.81)
    expect(seg).toMatchObject({ kept: 3, gains: 2, simplifications: 1 })
    const status = levelText(seg.level, "lower")
    expect(status).toBe("19.0% lower than the baseline")
    const summary = await buildCompactionSummary(dir, [])
    const compaction = /^Improvement: (.*?)\. /m.exec(summary)?.[1]
    expect(compaction).toBe("19.0 % lower than the baseline")
    expect(compaction!.replace(" %", "%")).toBe(status)
  })

  test("segmentSummaries: one per segment, kept without the baseline", () => {
    const config = (segment: number, name: string) => ({ type: "config", segment, name, direction: "lower", metric_unit: "ms" }) as LogEntry
    const entries = [
      config(1, "first"),
      run(100, "keep", { segment: 1, baseline: true }),
      keep(0.1, { segment: 1, metric: 90, run: 2, p: 1 / 256 }),
      run(95, "discard", { segment: 1 }),
      config(2, "second"),
      run(50, "keep", { segment: 2, baseline: true }),
    ] as LogEntry[]
    const [a, b] = segmentSummaries(entries)
    expect(a).toMatchObject({ runs: 3, kept: 1, gains: 1, simplifications: 0, baseline: 100, current: 90 })
    expect(a.lastKeep).toMatchObject({ run: 2, gain: 0.1 })
    expect(b.lastKeep).toBeUndefined()
    expect(a.level).toBeCloseTo(0.9)
    expect(b).toMatchObject({ runs: 1, kept: 0, level: 1, baseline: 50, current: 50 })
  })

  test("gainText: one wording, never a sign", () => {
    expect(gainText(0.0812)).toBe("8.1% better")
    expect(gainText(-0.699)).toBe("69.9% worse")
    expect(gainText(0)).toBe("no change")
    expect(gainText(-0.0004)).toBe("0.04% worse") // not "0.0%"
    expect(gainText(Infinity)).toContain("better")
    expect(relativeGain(90, 100, "lower")).toBeCloseTo(0.1)
    expect(relativeGain(90, 100, "higher")).toBeCloseTo(-0.1)
  })
})

describe("readSettings", () => {
  const dirWith = (content?: string) => {
    const dir = mkdtempSync(join(tmpdir(), "ar-settings-"))
    mkdirSync(join(dir, ".auto"))
    if (content !== undefined) writeFileSync(join(dir, ".auto", "config.json"), content)
    return dir
  }

  test("defaults when there's no file: a budget always exists", async () => {
    expect(await readSettings(dirWith())).toEqual({ ...DEFAULT_SETTINGS, warnings: [] })
    expect(DEFAULT_SETTINGS).toEqual({ maxIterations: 50, maxNoImprovement: 10, minImprovement: 0.01 })
  })

  test("reads valid values, also numeric strings", async () => {
    const s = await readSettings(dirWith('{"maxIterations": "120", "maxNoImprovement": 4, "minImprovement": 0.05}'))
    expect(s).toEqual({ maxIterations: 120, maxNoImprovement: 4, minImprovement: 0.05, warnings: [] })
  })

  test("invalid values warn and fall back to the default, never to 'no limit'", async () => {
    const s = await readSettings(dirWith('{"maxIterations": 0, "maxNoImprovement": "many", "minImprovement": 5, "maxIteration": 9}'))
    expect(s).toMatchObject(DEFAULT_SETTINGS)
    expect(s.warnings).toHaveLength(4)
    expect(s.warnings.join("\n")).toContain("maxIterations")
    expect(s.warnings.join("\n")).toContain('Unknown key "maxIteration"')
    expect((await readSettings(dirWith('{"maxIterations": null}'))).warnings).toHaveLength(1)
  })

  test("broken JSON warns and uses the defaults", async () => {
    const s = await readSettings(dirWith("{nope"))
    expect(s).toMatchObject(DEFAULT_SETTINGS)
    expect(s.warnings[0]).toContain("valid JSON")
    expect((await readSettings(dirWith("[1]"))).warnings[0]).toContain("JSON object")
  })
})
