import { describe, expect, test } from "bun:test"
import { computeConfidence, parseMetrics, summarize, type RunEntry } from "./state.ts"

const run = (metric: number, status: RunEntry["status"]) => ({ metric, status }) as RunEntry

describe("parseMetrics", () => {
  test("reads METRIC lines and ignores noise", () => {
    const out = "building...\nMETRIC total_ms=41.5\nMETRIC heap_mb=120\nMETRIC bad=abc\nnot METRIC x=1\n"
    expect(parseMetrics(out)).toEqual({ total_ms: 41.5, heap_mb: 120 })
  })
})

describe("summarize", () => {
  test("best only counts kept runs", () => {
    const runs = [run(100, "keep"), run(80, "discard"), run(90, "keep"), run(70, "crash")]
    expect(summarize(runs, "lower")).toEqual({ baseline: 100, best: 90 })
    expect(summarize(runs, "higher")).toEqual({ baseline: 100, best: 100 })
  })
})

describe("computeConfidence", () => {
  const withNoise = (...n: (number | null | undefined)[]) => n.map((noise) => ({ noise }))

  test("a gain far above the measured noise is confident", () => {
    expect(computeConfidence(withNoise(1, 1.2, 0.8), 100, 80)).toBeCloseTo(20)
  })
  test("a gain inside the noise is not", () => {
    expect(computeConfidence(withNoise(10, 12, 9), 100, 95)!).toBeLessThan(1)
  })
  test("two tiny gains are NOT 'likely real' just because they're steps (the old bug)", () => {
    // values 1000000 → 1000001 → 1000002 used to score 2.0×; with real noise of 45 it's tiny
    expect(computeConfidence(withNoise(45, 45), 1000000, 1000002)!).toBeLessThan(0.1)
  })
  test("no noise measured, or no improvement → null", () => {
    expect(computeConfidence(withNoise(null, undefined, 0), 100, 80)).toBeNull()
    expect(computeConfidence(withNoise(1, 1), 100, 100)).toBeNull()
  })
})
