import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  compoundedGain,
  CONFIRM_AT,
  DEFAULT_SETTINGS,
  gainText,
  halfRuns,
  judge,
  keptRuns,
  median,
  noImprovementStreak,
  parseMetrics,
  readSettings,
  relativeGain,
  sampleList,
  segmentSummaries,
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

describe("compounded gain", () => {
  const keep = (metric: number, vs: number, extra: Partial<RunEntry> = {}) => run(metric, "keep", { vs, ...extra })

  test("the product of the keeps' back-to-back ratios, not current / baseline", () => {
    // The baseline was logged at 100 on a slow day; the two keeps were each 10 % better
    // than HEAD when measured next to it, at whatever speed the machine had then.
    const runs = [run(100, "keep", { baseline: true }), keep(72, 80), run(70, "discard", { vs: 72 }), keep(108, 120)]
    const g = compoundedGain(runs, "lower")
    expect(g.ratio).toBeCloseTo(0.81)
    expect(g.gain).toBeCloseTo(0.19)
    expect(g).toMatchObject({ keeps: 2, skipped: 0 })
    // current / baseline would say "8 % worse".
    expect(summarize(runs)).toMatchObject({ baseline: 100, current: 108 })
  })

  test("direction higher; baselines, discards and keeps without a usable ratio don't count", () => {
    const runs = [run(50, "keep", { baseline: true, vs: 1 }), keep(110, 100), keep(5, 0), run(200, "keep"), run(999, "discard", { vs: 1 })]
    const g = compoundedGain(runs, "higher")
    expect(g.gain).toBeCloseTo(0.1)
    expect(g).toMatchObject({ keeps: 1, skipped: 2 })
    expect(keptRuns(runs)).toHaveLength(3)
    expect(compoundedGain([run(100, "keep", { baseline: true })], "lower")).toMatchObject({ ratio: 1, gain: 0, keeps: 0 })
  })

  test("segmentSummaries: one per segment, kept without the baseline", () => {
    const config = (segment: number, name: string) => ({ type: "config", segment, name, direction: "lower", metric_unit: "ms" }) as LogEntry
    const entries = [
      config(1, "first"),
      run(100, "keep", { segment: 1, baseline: true }),
      keep(90, 100, { segment: 1 }),
      run(95, "discard", { segment: 1 }),
      config(2, "second"),
      run(50, "keep", { segment: 2, baseline: true }),
    ] as LogEntry[]
    const [a, b] = segmentSummaries(entries)
    expect(a).toMatchObject({ runs: 3, kept: 1, baseline: 100, current: 90 })
    expect(a.gain).toBeCloseTo(0.1)
    expect(b).toMatchObject({ runs: 1, kept: 0, gain: 0, baseline: 50, current: 50 })
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

describe("judge", () => {
  const base = { direction: "lower" as const, minImprovement: 0.01 }

  test("a clear gain over the noise is confirmed, with a per-keep confidence", () => {
    const v = judge({ ...base, current: [100, 101, 99, 100.5, 99.5], candidate: [90, 91, 89, 90.5, 89.5] })
    expect(v.confirmed).toBe(true)
    expect(v.gain).toBeCloseTo(10)
    expect(v.relGain).toBeCloseTo(0.1)
    expect(v.confidence!).toBeGreaterThan(CONFIRM_AT)
    expect(v.reason).toContain("Confirmed")
    expect(v.reason).toContain("10.0% better")
  })

  test("a gain inside the noise is not confirmed", () => {
    const v = judge({ ...base, current: [100, 104, 96, 102, 98], candidate: [99, 103, 95, 101, 97] })
    expect(v.confirmed).toBe(false)
    expect(v.confidence!).toBeLessThan(CONFIRM_AT)
    expect(v.reason).toContain("Not confirmed")
  })

  test("the threshold is 2.5 standard errors (see the simulation below)", () => {
    expect(CONFIRM_AT).toBe(2.5)
    // 2.2 standard errors: passed at 2, doesn't pass now.
    const current = [100, 101, 99, 100.5, 99.5, 100]
    const candidate = [98.76, 99.76, 97.76, 99.26, 98.26]
    const v = judge({ ...base, current, candidate })
    expect(v.confidence!).toBeGreaterThan(2)
    expect(v.confidence!).toBeLessThan(2.5)
    expect(v.confirmed).toBe(false)
    expect(judge({ ...base, current, candidate, confirmAt: 2 }).confirmed).toBe(true)
  })

  test("direction higher: more is better", () => {
    const v = judge({ ...base, direction: "higher", current: [100, 101, 99], candidate: [120, 121, 119] })
    expect(v.confirmed).toBe(true)
    expect(v.gain).toBeCloseTo(20)
    expect(judge({ ...base, direction: "higher", current: [100, 101, 99], candidate: [80, 81, 79] }).confirmed).toBe(false)
  })

  test("the wording never mixes a signed percentage with better/worse", () => {
    const worse = judge({ ...base, current: [77.4, 77.5, 77.3], candidate: [131.6, 131.5, 131.7] })
    expect(worse.reason).toContain("70.0% worse")
    expect(worse.reason).not.toMatch(/[+-]\d+(\.\d+)?%/)
    expect(worse.reason).toContain("below HEAD")
  })

  test("deterministic metric: exact comparison, confidence reported as exact (null)", () => {
    const better = judge({ ...base, current: [1000, 1000, 1000], candidate: [999, 999, 999] })
    expect(better).toMatchObject({ confirmed: true, exact: true, confidence: null, se: 0 })
    const same = judge({ ...base, current: [1000, 1000, 1000], candidate: [1000, 1000, 1000] })
    expect(same.confirmed).toBe(false)
    expect(judge({ ...base, neutral: true, current: [1000, 1000, 1000], candidate: [1000, 1000, 1000] }).confirmed).toBe(true)
    expect(judge({ ...base, neutral: true, current: [1000, 1000, 1000], candidate: [1001, 1001, 1001] }).confirmed).toBe(false)
  })

  test("zero spread from ties in a coarse metric is NOT treated as exact", () => {
    // MAD is 0 on both sides although the samples differ (integer milliseconds).
    const v = judge({ ...base, current: [100, 100, 100, 101, 99], candidate: [100, 100, 100, 99, 99.9] })
    expect(v.exact).toBe(false)
    expect(v.confirmed).toBe(false) // falls back to minImprovement: 0 % < 1 %
  })

  test("fewer than 3 samples: the paired gain must reach minImprovement", () => {
    expect(judge({ ...base, current: [100], candidate: [98] }).confirmed).toBe(true)
    expect(judge({ ...base, current: [100], candidate: [99.5] }).confirmed).toBe(false)
    const v = judge({ ...base, current: [100, 101], candidate: [90, 91] })
    expect(v).toMatchObject({ confirmed: true, se: null, confidence: null })
  })

  test("simplification: not worse beyond the noise AND not worse by more than minImprovement", () => {
    const current = [100, 101, 99, 100.5, 99.5]
    expect(judge({ ...base, neutral: true, current, candidate: [100.2, 101.1, 99.3, 100.4, 99.8] }).confirmed).toBe(true)
    expect(judge({ ...base, neutral: true, current, candidate: [110, 111, 109, 110.5, 109.5] }).confirmed).toBe(false)
    // A noisy benchmark: 3 % slower is "within the noise", and used to pass as a simplification.
    const noisy = judge({ ...base, neutral: true, current: [100, 110, 90, 105, 95], candidate: [103, 113, 93, 108, 98] })
    expect(noisy.confidence!).toBeGreaterThan(-CONFIRM_AT)
    expect(noisy.confirmed).toBe(false)
    expect(noisy.reason).toContain("may not cost more than 1%")
    expect(judge({ ...base, minImprovement: 0.05, neutral: true, current: [100, 110, 90, 105, 95], candidate: [103, 113, 93, 108, 98] }).confirmed).toBe(true)
    // few samples: not worse by more than minImprovement
    expect(judge({ ...base, neutral: true, current: [100], candidate: [100.5] }).confirmed).toBe(true)
    expect(judge({ ...base, neutral: true, current: [100], candidate: [102] }).confirmed).toBe(false)
  })

  test("a zero current value doesn't produce NaN", () => {
    const v = judge({ ...base, current: [0], candidate: [0] })
    expect(v.relGain).toBe(0)
    expect(v.confirmed).toBe(false)
  })
})

// The procedure the tools apply, simulated with the real judge(), as docs/design.md asks:
// experiments that change NOTHING, uniform ±2 % noise, a keep proposed whenever the first
// measurement looks better than current's logged samples, then HEAD / candidate / HEAD
// measured fresh and judged. Every no-op counts in the denominator, proposed or not.
//
// Two versions of "current's logged samples":
// - fresh: an unbiased measurement of the same code (the state after a baseline or a real
//   keep). This is the rate that decides the threshold: it's what a session's first no-ops see.
// - ratchet: after a false keep its (lucky) samples become the logged current, so later
//   no-ops rarely even pass the first look. Over a long run of no-ops the rate drops far
//   below the fresh one; it's reported, but nothing relies on it.
describe("judge: simulation of the paired confirmation", () => {
  test("halfRuns: equal halves around the candidate, at least 3 each once repeat ≥ 3", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 10].map(halfRuns)).toEqual([1, 1, 3, 3, 3, 3, 4, 5])
  })

  function simulate(opts: { repeat: number; effect: number; confirmAt: number; trials: number; seed: number; ratchet?: boolean }) {
    let seed = opts.seed
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 2 ** 32)
    const draw = (mean: number, n: number) => Array.from({ length: n }, () => mean * (1 + 0.02 * (2 * rnd() - 1)))
    const half = halfRuns(opts.repeat)
    const candidateMean = 100 * (1 - opts.effect)
    let kept = 0
    let logged = draw(100, opts.repeat)
    for (let i = 0; i < opts.trials; i++) {
      if (!opts.ratchet) logged = draw(100, opts.repeat)
      const first = median(draw(candidateMean, opts.repeat))
      if (!(first < median(logged))) continue // the pre-filter: the agent logs a discard
      const headBefore = draw(100, half)
      const candidate = draw(candidateMean, opts.repeat)
      const headAfter = draw(100, half)
      const v = judge({ current: [...headBefore, ...headAfter], candidate, direction: "lower", minImprovement: 0.01, confirmAt: opts.confirmAt })
      if (!v.confirmed) continue
      kept++
      if (opts.ratchet) logged = candidate
    }
    return kept / opts.trials
  }
  const noop = { effect: 0, trials: 400_000, seed: 42 }

  test("no-ops, repeat 5: 2 standard errors lets through more than 3 %, so the threshold is 2.5", () => {
    // Measured (400 000 no-ops, standard error of the estimate ≈ 0.03 points): 4.9 % at 2, 3.2 % at 2.5.
    const at2 = simulate({ ...noop, repeat: 5, confirmAt: 2 })
    const at25 = simulate({ ...noop, repeat: 5, confirmAt: CONFIRM_AT })
    expect(at2).toBeGreaterThan(0.045)
    expect(at2).toBeLessThan(0.053)
    expect(at2).toBeGreaterThan(0.03) // the design's condition for raising the threshold
    expect(at25).toBeGreaterThan(0.029)
    expect(at25).toBeLessThan(0.036)
  })

  test("no-ops, other repeat counts (measured: repeat 3 ≈ 4.2 %, repeat 10 ≈ 1.7 %)", () => {
    // Repeat 3 judges on 6 + 3 samples; the candidate's spread estimate is rough there.
    expect(simulate({ ...noop, repeat: 3, confirmAt: CONFIRM_AT })).toBeLessThan(0.05)
    expect(simulate({ ...noop, repeat: 10, confirmAt: CONFIRM_AT })).toBeLessThan(0.025)
  })

  test("no-ops in a row with the ratchet: far fewer (measured ≈ 0.05 % per no-op)", () => {
    expect(simulate({ ...noop, repeat: 5, confirmAt: CONFIRM_AT, ratchet: true })).toBeLessThan(0.003)
  })

  test("a real 5 % gain, repeat 5: practically always confirmed (measured: 100 %); a 2 % gain about half the time (≈ 48 %)", () => {
    expect(simulate({ repeat: 5, effect: 0.05, confirmAt: CONFIRM_AT, trials: 100_000, seed: 7 })).toBeGreaterThan(0.999)
    const small = simulate({ repeat: 5, effect: 0.02, confirmAt: CONFIRM_AT, trials: 100_000, seed: 7 })
    expect(small).toBeGreaterThan(0.4)
    expect(small).toBeLessThan(0.56)
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
