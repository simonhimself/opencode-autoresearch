// The keep decision (stats.ts): the exact test itself, the two-stage rule, and the proof
// that a proposed no-op is kept at most 1 % of the time, by counting and by simulating
// the whole procedure under several kinds of noise.

import { describe, expect, setDefaultTimeout, test } from "bun:test"
import type { Direction, Pair } from "./state.ts"
import {
  ALPHA_STAGE,
  CONFIRM_PAIRS,
  decide,
  EXTEND_BELOW,
  headFirst,
  isSlow,
  LOOK_PAIRS,
  lookPairs,
  pairScore,
  signedRankP,
  stagePairs,
  swapOrderEffect,
  WORSE_ALPHA,
} from "./stats.ts"

setDefaultTimeout(120_000)

describe("signedRankP: exact one-sided Wilcoxon signed-rank", () => {
  test("known values without ties", () => {
    expect(signedRankP([])).toBe(1)
    expect(signedRankP([1, 2, 3, 4, 5, 6, 7, 8])).toBe(1 / 256) // all positive
    expect(signedRankP([-1, 2, 3, 4, 5, 6, 7, 8])).toBe(2 / 256) // only the smallest is negative
    expect(signedRankP([1, 2, 3, 4, 5, 6, 7, -8])).toBe(25 / 256) // only the largest is negative
    expect(signedRankP([-1, -2, -3, -4, -5, -6, -7, -8])).toBe(1)
    // n = 5, W+ = 13 (ranks 1 and 2... negative: rank 2): P(W+ ≥ 13) = 3/32
    expect(signedRankP([1, -2, 3, 4, 5])).toBe(3 / 32)
  })

  test("it is the share of sign assignments at least as good, for any tie pattern (brute force)", () => {
    const cases = [
      [3, 3, 3, -3, 1, 1, -2, 5],
      [0.5, 0.5, 0.5, 0.5],
      [1, 0, 0, 2, -2, 2, 7],
      [4, -4, 4, -4, 4, 4, 9, -1, 0],
    ]
    for (const d of cases) {
      const n = d.length
      const order = d.map((_, i) => i).sort((a, b) => Math.abs(d[a]) - Math.abs(d[b]))
      const rank = new Array<number>(n)
      for (let i = 0; i < n; ) {
        let j = i
        while (j + 1 < n && Math.abs(d[order[j + 1]]) === Math.abs(d[order[i]])) j++
        for (let k = i; k <= j; k++) rank[order[k]] = (i + j + 2) / 2
        i = j + 1
      }
      const observed = d.reduce((sum, x, i) => sum + (x > 0 ? rank[i] : 0), 0)
      let atLeast = 0
      for (let mask = 0; mask < 2 ** n; mask++) {
        let w = 0
        for (let i = 0; i < n; i++) if (mask & (1 << i)) w += rank[i]
        if (w >= observed) atLeast++
      }
      expect(signedRankP(d)).toBe(atLeast / 2 ** n)
    }
  })

  test("ties and zeros are handled conservatively", () => {
    // A deterministic metric that got better in every pair: the smallest p there is.
    expect(signedRankP(Array(8).fill(0.001))).toBe(1 / 256)
    // No difference at all is evidence for nothing, in either direction.
    expect(signedRankP(Array(8).fill(0))).toBe(1)
    expect(signedRankP(Array(8).fill(-0))).toBe(1)
    // Zeros count against the hypothesis under test: 3 better pairs and 5 identical ones
    // are not a clean sweep (dropping the zeros would give 1/8).
    const some = [0, 0, 0, 0, 0, 2, 3, 4]
    expect(signedRankP(some)).toBeGreaterThan(1 / 8)
    // … and against the opposite hypothesis too, when that one is tested.
    expect(signedRankP(some.map((x) => -x))).toBe(1)
    // A zero is never better for the p-value than a small loss would be worse: p with a
    // zero lies between "that pair slightly positive" and the cautious end.
    expect(signedRankP([0, 2, 3, 4, 5, 6, 7, 8])).toBeGreaterThan(signedRankP([1, 2, 3, 4, 5, 6, 7, 8]))
    expect(signedRankP([0, 2, 3, 4, 5, 6, 7, 8])).toBe(signedRankP([-1, 2, 3, 4, 5, 6, 7, 8]))
  })

  test("pairScore: trading the two runs only flips the sign (what the exact test rests on)", () => {
    for (const direction of ["lower", "higher"] as Direction[]) {
      for (const [a, b] of [[100, 130], [92, 100], [0, 5], [-3, 4], [7, 7]] as Pair[]) {
        expect(pairScore([a, b], direction)).toBe(-pairScore([b, a], direction) + 0)
      }
    }
    expect(pairScore([100, 90], "lower")).toBeGreaterThan(0)
    expect(pairScore([100, 90], "higher")).toBeLessThan(0)
    expect(pairScore([0, 0], "lower")).toBe(0)
  })
})

describe("decide: the two-stage rule", () => {
  const base = { direction: "lower" as Direction, repeat: 5, minImprovement: 0.01 }
  const pairsOf = (candidates: number[], head = 100): Pair[] => candidates.map((c) => [head, c])

  test("modes and pair counts follow `repeat`", () => {
    expect([1, 2, 3, 5, 50].map(isSlow)).toEqual([true, true, false, false, false])
    expect([1, 2, 3, 5].map(lookPairs)).toEqual([1, 1, LOOK_PAIRS, LOOK_PAIRS])
    expect([1, 2, 3, 5].map(stagePairs)).toEqual([1, 2, CONFIRM_PAIRS, CONFIRM_PAIRS])
    expect([0, 1, 2, 3].map(headFirst)).toEqual([true, false, true, false])
    expect({ LOOK_PAIRS, CONFIRM_PAIRS, ALPHA_STAGE, EXTEND_BELOW, WORSE_ALPHA }).toEqual({
      LOOK_PAIRS: 3,
      CONFIRM_PAIRS: 8,
      ALPHA_STAGE: 0.005,
      EXTEND_BELOW: 0.25,
      WORSE_ALPHA: 0.05,
    })
  })

  test("asks for stage 1 first, and says how many pairs are missing", () => {
    expect(decide({ ...base, pairs: [] })).toMatchObject({ more: 8, stage: 1 })
    expect(decide({ ...base, pairs: pairsOf([90, 90, 90]) })).toMatchObject({ more: 5, stage: 1 })
  })

  test("stage 1: all 8 pairs better → confirmed", () => {
    const d = decide({ ...base, pairs: pairsOf([92, 93, 91, 92, 94, 90, 92, 93]) })
    expect(d).toMatchObject({ more: 0, confirmed: true, stage: 1, used: 8, p: 1 / 256, better: 8 })
    expect(d.gain).toBeCloseTo(0.08)
    expect(d.reason).toContain("Confirmed: better in 8 of 8 pairs, median 8.0% better (exact paired test, p = 0.004")
  })

  test("stage 1: clearly no gain → not confirmed, no stage 2", () => {
    const d = decide({ ...base, pairs: pairsOf([101, 99, 102, 98.5, 100.5, 101.5, 99.5, 100.2]) })
    expect(d).toMatchObject({ more: 0, confirmed: false, stage: 1, used: 8 })
    expect(d.p!).toBeGreaterThan(EXTEND_BELOW)
    expect(d.reason).toContain("Not confirmed")
  })

  test("stage 1 promising but not enough → 8 more pairs, then all 16 are tested together", () => {
    // 7 better, 1 clearly worse (a burst on the candidate's run): p = 25/256 ≈ 0.098.
    const first = pairsOf([95, 95.2, 94.8, 95.1, 94.9, 95.3, 94.7, 120])
    const waiting = decide({ ...base, pairs: first })
    expect(waiting).toMatchObject({ more: 8, stage: 2, confirmed: false, p: 25 / 256 })
    // Halfway through stage 2 it still waits, and the stage-1 verdict doesn't change.
    expect(decide({ ...base, pairs: [...first, ...pairsOf([95, 95])] })).toMatchObject({ more: 6, stage: 2 })
    const good = decide({ ...base, pairs: [...first, ...pairsOf([95.05, 94.95, 95.15, 94.85, 95.25, 94.75, 95.35, 94.65])] })
    expect(good).toMatchObject({ more: 0, confirmed: true, stage: 2, used: 16, better: 15 })
    expect(good.p!).toBeLessThanOrEqual(ALPHA_STAGE)
    expect(good.reason).toContain("on all 16 pairs")
    const bad = decide({ ...base, pairs: [...first, ...pairsOf([101, 99, 102, 98, 100.5, 99.5, 101.5, 98.5])] })
    expect(bad).toMatchObject({ more: 0, confirmed: false, stage: 2, used: 16 })
    expect(bad.reason).toContain("Not confirmed")
  })

  test("a deterministic metric: better in every pair is a keep, identical is not", () => {
    expect(decide({ ...base, pairs: Array(8).fill([1000, 999]) })).toMatchObject({ confirmed: true, p: 1 / 256 })
    expect(decide({ ...base, pairs: Array(8).fill([1000, 1000]) })).toMatchObject({ confirmed: false, p: 1, gain: 0 })
    expect(decide({ ...base, pairs: Array(8).fill([1000, 1001]) })).toMatchObject({ confirmed: false, p: 1 })
  })

  test("direction higher", () => {
    expect(decide({ ...base, direction: "higher", pairs: pairsOf([108, 107, 109, 108, 106, 110, 108, 107]) })).toMatchObject({ confirmed: true })
    expect(decide({ ...base, direction: "higher", pairs: pairsOf([92, 93, 91, 92, 94, 90, 92, 93]) })).toMatchObject({ confirmed: false, p: 1 })
  })

  test("simplification: kept unless significantly worse or more than minImprovement worse", () => {
    const neutral = { ...base, neutral: true }
    // About equal.
    const same = decide({ ...neutral, pairs: pairsOf([100.2, 99.9, 100.1, 99.7, 100.3, 100.0, 99.8, 100.4]) })
    expect(same).toMatchObject({ more: 0, confirmed: true, stage: 1, used: 8 })
    expect(same.reason).toContain("Confirmed as a simplification")
    // Identical values (a deterministic metric): nothing says "worse".
    expect(decide({ ...neutral, pairs: Array(8).fill([1000, 1000]) })).toMatchObject({ confirmed: true, pWorse: 1 })
    // Consistently a little worse, though under minImprovement: significant, so refused.
    const worse = decide({ ...neutral, pairs: pairsOf([100.5, 100.4, 100.6, 100.5, 100.3, 100.7, 100.5, 100.6]) })
    expect(worse).toMatchObject({ confirmed: false, pWorse: 1 / 256 })
    expect(worse.reason).toContain("measurably worse")
    // Noisy, not significant, but the median costs 2 %: refused too.
    const costly = decide({ ...neutral, pairs: pairsOf([102, 92, 113, 102, 91, 112, 102, 93]) })
    expect(costly.pWorse!).toBeGreaterThan(WORSE_ALPHA)
    expect(costly).toMatchObject({ confirmed: false })
    expect(costly.reason).toContain("may not cost more than 1%")
    // A simplification never goes to stage 2.
    expect(decide({ ...neutral, pairs: pairsOf([95, 95.2, 94.8, 95.1, 94.9, 95.3, 94.7, 120]) })).toMatchObject({ more: 0, confirmed: true })
  })

  test("slow mode: `repeat` pairs, every pair better and the median at least minImprovement; no p-value", () => {
    const slow = { ...base, repeat: 2 }
    expect(decide({ ...slow, pairs: pairsOf([97]) })).toMatchObject({ more: 1 })
    const ok = decide({ ...slow, pairs: pairsOf([97, 98]) })
    expect(ok).toMatchObject({ more: 0, confirmed: true, p: null, used: 2 })
    expect(ok.reason).toContain("no statistical check")
    expect(decide({ ...slow, pairs: pairsOf([90, 100.5]) })).toMatchObject({ confirmed: false }) // one pair worse
    expect(decide({ ...slow, pairs: pairsOf([99.6, 99.7]) })).toMatchObject({ confirmed: false }) // under 1 %
    expect(decide({ ...base, repeat: 1, pairs: pairsOf([98]) })).toMatchObject({ more: 0, confirmed: true, used: 1 })
    expect(decide({ ...slow, neutral: true, pairs: pairsOf([100.5, 100.2]) })).toMatchObject({ confirmed: true })
    expect(decide({ ...slow, neutral: true, pairs: pairsOf([102, 103]) })).toMatchObject({ confirmed: false })
  })

  test("swapOrderEffect: the run after a swap is consistently the slower one", () => {
    // Candidate 5 % better, but whichever run comes second in a pair costs 10 % more.
    const pairs: Pair[] = [[110, 104.5], [110, 95], [100, 104.5], [110, 95], [100, 104.5], [110, 95], [100, 104.5], [110, 95]]
    expect(swapOrderEffect(pairs, "lower")).toBe(true)
    expect(decide({ ...base, pairs })).toMatchObject({ confirmed: false })
    expect(swapOrderEffect(pairsOf([92, 93, 91, 92, 94, 90, 92, 93]), "lower")).toBe(false)
    expect(swapOrderEffect(pairs.slice(0, 4), "lower")).toBe(false) // too few pairs to say
  })
})

// ── The guarantee ─────────────────────────────────────────
//
// "A proposed no-op is kept at most 1 % of the time."
//
// By counting: a keep needs stage 1 to pass (p ≤ ALPHA_STAGE on 8 pairs) or the test on all
// 16 pairs to pass. If the change does nothing, every assignment of signs to the pairs is
// equally likely, so each of the two has exactly the probability counted below, and the
// chance of either is at most their sum.
//
// By simulation: the whole procedure (alternating order inside the pairs, both stages, the
// real decide()) on no-op changes under several kinds of noise. The first look and its
// pre-filter are left out on purpose: they use other runs than the decision, so they only
// decide WHETHER a keep is proposed, and the rate per proposal is the one measured here.

/** A small seeded generator (mulberry32), so the rates below are reproducible. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The factor one benchmark run is off by. `afterSwap`: this run directly follows a file swap. */
type Noise = (rand: () => number, run: number, afterSwap: boolean) => number
const uniform2: Noise = (r) => 1 + (r() * 2 - 1) * 0.02
const noises: Record<string, Noise> = {
  "uniform ±2 %": uniform2,
  // 20 % of runs are slowed by 10–40 %, each run on its own (the worst case for pairs).
  "bursty (20 % of runs +10–40 %)": (r) => uniform2(r, 0, false) * (r() < 0.2 ? 1.1 + r() * 0.3 : 1),
  // Heavy tails: now and then a run is off by a lot, in either direction.
  "heavy-tailed": (r) => 1 + 0.01 * Math.tan(Math.PI * (r() - 0.5) * 0.98),
  // The machine gets steadily slower while the pairs are measured.
  "uniform ±2 % + steady drift (0.5 % per run)": (r, run) => uniform2(r, 0, false) * (1 + 0.005 * run),
  // measure.sh times a rebuild: the run right after a swap takes 5 % longer.
  "uniform ±2 % + 5 % on the run after a swap": (r, _run, afterSwap) => uniform2(r, 0, false) * (afterSwap ? 1.05 : 1),
}

interface Sim {
  noise: Noise
  /** True relative gain of the candidate (0 = a no-op). */
  gain?: number
  direction?: Direction
  /** Round every measured value (a coarse metric: ties and zero differences). */
  round?: boolean
  /** Load periods instead of independent bursts: several runs in a row are slowed alike. */
  periods?: boolean
  trials: number
  seed: number
}

/** Run the keep decision `trials` times. Returns the share confirmed and the mean number of benchmark runs. */
function simulate(sim: Sim) {
  const { noise, gain = 0, direction = "lower", trials } = sim
  const rand = rng(sim.seed)
  const candidateLevel = direction === "lower" ? 100 * (1 - gain) : 100 * (1 + gain)
  let kept = 0
  let runs = 0
  for (let t = 0; t < trials; t++) {
    const pairs: Pair[] = []
    let run = 0
    let load = 1
    let left = 0
    const one = (level: number, afterSwap: boolean) => {
      if (sim.periods) {
        if (left > 0) left--
        else if (rand() < 0.05) {
          left = 2 + Math.floor(rand() * 6)
          load = 1.1 + rand() * 0.3
        } else load = 1
      }
      const v = level * noise(rand, run++, afterSwap) * (sim.periods ? load : 1)
      return sim.round ? Math.round(v) : v
    }
    for (;;) {
      const d = decide({ pairs, direction, repeat: 5, minImprovement: 0.01 })
      if (!d.more) {
        if (d.confirmed) kept++
        break
      }
      for (let i = 0; i < d.more; i++) {
        const k = pairs.length
        // As in experiment.ts: the files change hands before the first run of a batch that
        // starts with HEAD, and between the two runs of every pair.
        let head: number, candidate: number
        if (headFirst(k)) {
          head = one(100, i === 0)
          candidate = one(candidateLevel, true)
        } else {
          candidate = one(candidateLevel, false)
          head = one(100, true)
        }
        pairs.push([head, candidate])
      }
    }
    runs += 2 * pairs.length
  }
  return { rate: kept / trials, runs: runs / trials }
}

describe("false keeps: a proposed no-op is confirmed at most 1 % of the time", () => {
  test("by counting: stage 1 passes with 1/256, the test on 16 pairs with at most 0.5 %; together under 1 %", () => {
    const level = (n: number) => {
      let pass = 0
      for (let mask = 0; mask < 2 ** n; mask++) {
        const d = Array.from({ length: n }, (_, i) => (mask & (1 << i) ? i + 1 : -(i + 1)))
        if (signedRankP(d) <= ALPHA_STAGE) pass++
      }
      return pass / 2 ** n
    }
    const stage1 = level(CONFIRM_PAIRS)
    const both = level(2 * CONFIRM_PAIRS)
    expect(stage1).toBe(1 / 256) // only "all 8 pairs better"
    expect(both).toBeLessThanOrEqual(ALPHA_STAGE)
    expect(both).toBe(301 / 65536) // 0.46 %: the largest level an exact test on 16 pairs reaches under 0.5 %
    expect(stage1 + both).toBeLessThanOrEqual(0.01) // 0.85 %
  })

  const TRIALS = 200_000
  const cases: [string, Omit<Sim, "trials" | "seed">][] = [
    ...Object.entries(noises).map(([name, noise]) => [name, { noise }] as [string, Omit<Sim, "trials" | "seed">]),
    ["bursty, higher is better", { noise: noises["bursty (20 % of runs +10–40 %)"], direction: "higher" }],
    ["uniform ±2 %, a coarse metric (rounded: ties and zero differences)", { noise: uniform2, round: true }],
    ["uniform ±2 % with load periods (several runs in a row slowed 10–40 %)", { noise: uniform2, periods: true }],
  ]
  for (const [i, [name, sim]] of cases.entries()) {
    test(`simulated, ${TRIALS} no-op proposals: ${name}`, () => {
      const { rate } = simulate({ ...sim, trials: TRIALS, seed: 1000 + i })
      console.log(`false keeps, ${name}: ${(rate * 100).toFixed(2)} %`)
      expect(rate).toBeLessThanOrEqual(0.01)
    })
  }
})

describe("power: how often a real gain is confirmed (8 + 8 pairs)", () => {
  const TRIALS = 50_000
  const table: Record<string, Record<string, string>> = {}
  const rows: [string, Omit<Sim, "trials" | "seed" | "gain">][] = [
    ["uniform ±2 %", { noise: uniform2 }],
    ["bursty, independent runs", { noise: noises["bursty (20 % of runs +10–40 %)"] }],
    ["load periods (runs in a row)", { noise: uniform2, periods: true }],
  ]
  const power = (row: number, gain: number) => {
    const [name, sim] = rows[row]
    const r = simulate({ ...sim, gain, trials: TRIALS, seed: 77 + row })
    ;(table[name] ??= {})[`${gain * 100} %`] = `${(r.rate * 100).toFixed(1)} % (${r.runs.toFixed(0)} runs)`
    return r.rate
  }

  test("uniform ±2 % noise: a 3 % gain is practically always confirmed, a 1 % gain about a third of the time", () => {
    expect(power(0, 0.01)).toBeGreaterThan(0.25)
    expect(power(0, 0.03)).toBeGreaterThan(0.99)
    expect(power(0, 0.05)).toBeGreaterThan(0.999)
    expect(power(0, 0.1)).toBeGreaterThan(0.999)
  })

  test("independent bursts (20 % of runs slowed by 10–40 %) are the hard case: pairing can't cancel them", () => {
    // One burst on a candidate run is a pair that is worse by more than any gain here, and
    // with 16 pairs two or three of those are expected. Recorded, not hidden: under this
    // noise most real gains under 10 % need a second proposal or a quieter machine.
    expect(power(1, 0.01)).toBeLessThan(0.2)
    const three = power(1, 0.03)
    expect(three).toBeGreaterThan(0.2)
    expect(three).toBeLessThan(0.5)
    expect(power(1, 0.05)).toBeGreaterThan(0.25)
    expect(power(1, 0.1)).toBeGreaterThan(0.45)
  })

  test("load that lasts several runs hits both runs of a pair: gains of 3 % and more are mostly confirmed", () => {
    power(2, 0.01)
    expect(power(2, 0.03)).toBeGreaterThan(0.8)
    expect(power(2, 0.05)).toBeGreaterThan(0.8)
    expect(power(2, 0.1)).toBeGreaterThan(0.9)
    console.table(table)
  })

  test("a rebuild timed on the run after each swap hides a gain smaller than it (and a larger one survives)", () => {
    const withPenalty = (penalty: number): Noise => (r, _run, afterSwap) => uniform2(r, 0, false) * (afterSwap ? 1 + penalty : 1)
    const at = (penalty: number) => simulate({ noise: withPenalty(penalty), gain: 0.05, trials: 20_000, seed: 5 }).rate
    const rates = { "1 %": at(0.01), "3 %": at(0.03), "5 %": at(0.05), "8 %": at(0.08), "12 %": at(0.12) }
    console.log("5 % gain confirmed, by cost of the run after a swap:", JSON.stringify(rates))
    expect(rates["1 %"]).toBeGreaterThan(0.99)
    expect(rates["8 %"]).toBeLessThan(0.2)
    expect(rates["12 %"]).toBeLessThan(0.01)
  })
})
