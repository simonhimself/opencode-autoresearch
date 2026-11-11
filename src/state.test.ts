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
  test("big gain over a quiet benchmark is confident", () => {
    const c = computeConfidence([100, 101, 99, 100, 80], 100, 80)
    expect(c).not.toBeNull()
    expect(c!).toBeGreaterThanOrEqual(2)
  })
  test("gain inside the noise is not", () => {
    const c = computeConfidence([100, 120, 85, 110, 95], 100, 95)
    expect(c).not.toBeNull()
    expect(c!).toBeLessThan(1)
  })
  test("too little data or no improvement → null", () => {
    expect(computeConfidence([100, 90], 100, 90)).toBeNull()
    expect(computeConfidence([100, 100, 100], 100, 100)).toBeNull()
  })
})
