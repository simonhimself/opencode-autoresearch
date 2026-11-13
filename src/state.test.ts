import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_SETTINGS,
  judge,
  median,
  noImprovementStreak,
  parseMetrics,
  readSettings,
  sampleList,
  summarize,
  type LogEntry,
  type RunEntry,
} from "./state.ts"

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

describe("sampleList", () => {
  test("uses the stored samples, or the metric for entries that only stored a count", () => {
    expect(sampleList({ samples: [1, 2, 3], metric: 2 })).toEqual([1, 2, 3])
    expect(sampleList({ samples: 5 as never, metric: 2 })).toEqual([2])
    expect(sampleList({ samples: undefined as never, metric: null })).toEqual([])
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

describe("judge", () => {
  const base = { direction: "lower" as const, minImprovement: 0.01 }

  test("a clear gain over the noise is confirmed, with a per-keep confidence", () => {
    const v = judge({ ...base, current: [100, 101, 99, 100.5, 99.5], candidate: [90, 91, 89, 90.5, 89.5], firstMetric: 90 })
    expect(v.confirmed).toBe(true)
    expect(v.gain).toBeCloseTo(10)
    expect(v.relGain).toBeCloseTo(0.1)
    expect(v.confidence!).toBeGreaterThan(2)
    expect(v.reason).toContain("Confirmed")
  })

  test("a gain inside the noise is not confirmed", () => {
    const v = judge({ ...base, current: [100, 104, 96, 102, 98], candidate: [99, 103, 95, 101, 97], firstMetric: 97 })
    expect(v.confirmed).toBe(false)
    expect(v.confidence!).toBeLessThan(2)
    expect(v.reason).toContain("Not confirmed")
  })

  test("direction higher: more is better", () => {
    const v = judge({ ...base, direction: "higher", current: [100, 101, 99], candidate: [120, 121, 119], firstMetric: 120 })
    expect(v.confirmed).toBe(true)
    expect(v.gain).toBeCloseTo(20)
    expect(judge({ ...base, direction: "higher", current: [100, 101, 99], candidate: [80, 81, 79], firstMetric: 80 }).confirmed).toBe(false)
  })

  test("a confirmation that looks good doesn't rescue a first measurement that wasn't better", () => {
    const v = judge({ ...base, current: [100, 101, 99, 100.5, 99.5], candidate: [90, 91, 89, 90.5, 89.5], firstMetric: 100.2 })
    expect(v.confirmed).toBe(false)
    expect(v.reason).toContain("first measurement")
  })

  test("deterministic metric: exact comparison, confidence reported as exact (null)", () => {
    const better = judge({ ...base, current: [1000, 1000, 1000], candidate: [999, 999, 999], firstMetric: 999 })
    expect(better).toMatchObject({ confirmed: true, exact: true, confidence: null, se: 0 })
    const same = judge({ ...base, current: [1000, 1000, 1000], candidate: [1000, 1000, 1000], firstMetric: 1000 })
    expect(same.confirmed).toBe(false)
    expect(judge({ ...base, neutral: true, current: [1000, 1000, 1000], candidate: [1000, 1000, 1000] }).confirmed).toBe(true)
    expect(judge({ ...base, neutral: true, current: [1000, 1000, 1000], candidate: [1001, 1001, 1001] }).confirmed).toBe(false)
  })

  test("zero spread from ties in a coarse metric is NOT treated as exact", () => {
    // MAD is 0 on both sides although the samples differ (integer milliseconds).
    const v = judge({ ...base, current: [100, 100, 100, 101, 99], candidate: [100, 100, 100, 99, 99.9], firstMetric: 99.9 })
    expect(v.exact).toBe(false)
    expect(v.confirmed).toBe(false) // falls back to minImprovement: 0 % < 1 %
  })

  test("fewer than 3 samples: needs minImprovement in BOTH measurements", () => {
    expect(judge({ ...base, current: [100], candidate: [98], firstMetric: 97 }).confirmed).toBe(true)
    expect(judge({ ...base, current: [100], candidate: [99.5], firstMetric: 97 }).confirmed).toBe(false)
    expect(judge({ ...base, current: [100], candidate: [97], firstMetric: 99.5 }).confirmed).toBe(false)
    const v = judge({ ...base, current: [100, 101], candidate: [90, 91], firstMetric: 90 })
    expect(v).toMatchObject({ confirmed: true, se: null, confidence: null })
  })

  test("simplification: confirmed unless worse beyond the noise", () => {
    const current = [100, 101, 99, 100.5, 99.5]
    expect(judge({ ...base, neutral: true, current, candidate: [100.2, 101.1, 99.3, 100.4, 99.8] }).confirmed).toBe(true)
    expect(judge({ ...base, neutral: true, current, candidate: [110, 111, 109, 110.5, 109.5] }).confirmed).toBe(false)
    // few samples: not worse by more than minImprovement
    expect(judge({ ...base, neutral: true, current: [100], candidate: [100.5] }).confirmed).toBe(true)
    expect(judge({ ...base, neutral: true, current: [100], candidate: [102] }).confirmed).toBe(false)
  })

  test("a zero current value doesn't produce NaN", () => {
    const v = judge({ ...base, current: [0], candidate: [0], firstMetric: 0 })
    expect(v.relGain).toBe(0)
    expect(v.confirmed).toBe(false)
  })
})

// The reason judge() exists: under the old rules (keep whatever beats the best so far,
// confidence = cumulative gain / one MAD) experiments that changed NOTHING were kept and
// called "likely real" in 50–85 % of sessions. This simulates the new procedure the way
// the tools apply it: one fixed set of current samples per session, the agent proposes a
// keep only when its first measurement looks better, the plugin re-measures and judges,
// and a false keep becomes the new current.
describe("judge: simulation with 2 % noise", () => {
  function simulate(opts: { repeat: number; effectPct: number; attempts: number; sessions: number; seed: number }) {
    let seed = opts.seed
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 2 ** 32)
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-12)) * Math.cos(2 * Math.PI * rnd())
    const draw = (mean: number) => Array.from({ length: opts.repeat }, () => mean + 2 * gauss())
    let kept = 0
    let total = 0
    for (let s = 0; s < opts.sessions; s++) {
      let current = draw(100)
      for (let a = 0; a < opts.attempts; a++) {
        total++
        const candidateMean = 100 - opts.effectPct
        const first = median(draw(candidateMean))
        if (!(first < median(current))) continue // the agent logs a discard
        const confirmation = draw(candidateMean)
        const v = judge({ current, candidate: confirmation, firstMetric: first, direction: "lower", minImprovement: 0.01 })
        if (!v.confirmed) continue
        kept++
        if (opts.effectPct === 0) current = confirmation // a false keep moves the bar
      }
    }
    return kept / total
  }

  test("no-op experiments, repeat 5: only a few percent of attempts are kept", () => {
    const rate = simulate({ repeat: 5, effectPct: 0, attempts: 50, sessions: 2000, seed: 42 })
    // Measured ≈ 1 %. The bound leaves room for other seeds; the old rules gave ≈ 7 % per attempt.
    expect(rate).toBeLessThan(0.03)
  })

  test("no-op experiments, repeat 3 and 10: same picture", () => {
    expect(simulate({ repeat: 3, effectPct: 0, attempts: 50, sessions: 2000, seed: 7 })).toBeLessThan(0.04)
    expect(simulate({ repeat: 10, effectPct: 0, attempts: 50, sessions: 2000, seed: 7 })).toBeLessThan(0.03)
  })

  test("a real 5 % gain, repeat 5: mostly confirmed", () => {
    const rate = simulate({ repeat: 5, effectPct: 5, attempts: 1, sessions: 20000, seed: 42 })
    expect(rate).toBeGreaterThan(0.8) // measured ≈ 90 %
  })

  test("a real 10 % gain is practically always confirmed", () => {
    expect(simulate({ repeat: 5, effectPct: 10, attempts: 1, sessions: 5000, seed: 1 })).toBeGreaterThan(0.99)
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
