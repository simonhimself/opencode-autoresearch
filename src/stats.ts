// The keep decision: an exact paired test on HEAD/candidate pairs. Pure, no git, no OpenCode.
//
// Why pairs: machine speed drifts and bursts within minutes, so a number is only comparable
// with one measured right next to it. One pair = one HEAD run and one candidate run back
// to back; its result is their relative difference. The order inside the pairs alternates
// (HEAD first, candidate first, …), so a steady drift helps the candidate in one pair and
// hurts it in the next.
//
// Why an exact rank test: v0.2.1 estimated the noise from the spread of 5–6 samples and
// asked for "2.5 standard errors". That estimate is rough: a nominal 0.6 % false-keep rate
// was 6–9 % in practice. The Wilcoxon signed-rank test needs no noise estimate. If the
// change does nothing, each pair's difference is as likely to point one way as the other,
// whatever the noise looks like (uniform, heavy-tailed, bursty, a coarse metric full of
// ties). The p-value is counted from exactly that: of all 2^n ways to hand out the signs,
// how many give a result at least as good as the one seen. So the false-keep rate is
// bounded by construction, not by a simulation of one noise shape.
//
// What it assumes: under "no change", swapping the two labels of a pair doesn't change the
// odds. That holds for independent noise and for anything that hits both runs of a pair
// alike. A cost that only the run right after a file swap pays (a rebuild inside the timed
// part of measure.sh) alternates between helping and hurting the candidate; it can't cause
// a false keep, but it can hide a real gain smaller than itself (see swapOrderEffect).

import { gainText, median, pairGain, pText, type Direction, type Pair } from "./state.ts"

/** Pairs of the first look (autoresearch_run) in standard mode. A rough look, never part of a decision. */
export const LOOK_PAIRS = 3
/** Pairs per stage of a keep decision in standard mode: stage 1 measures this many, stage 2 as many again. */
export const CONFIRM_PAIRS = 8
/**
 * A stage confirms the keep when its one-sided p-value is at most this.
 *
 * The false-keep probability of a proposed no-op is at most the chance that stage 1
 * passes plus the chance that the test on all pairs passes: with 8 + 8 pairs that is
 * 1/256 + 301/65536 = 0.85 % (the p-values an exact test can take are discrete: with 8
 * pairs only "all 8 better" is ≤ 0.005). stats.test.ts counts both and simulates the
 * whole procedure (about 0.75 %, since stage 2 only runs after a promising stage 1).
 */
export const ALPHA_STAGE = 0.005
/**
 * Stage 1 with a p-value above this ends the decision: not confirmed. Between ALPHA_STAGE
 * and this, stage 2 is measured. 0.25 means: at most one clearly worse pair among the
 * first 8, or a few slightly worse ones. A no-op gets there one time in four.
 */
export const EXTEND_BELOW = 0.25
/** A simplification is refused when "the candidate is worse" has a p-value at or below this. */
export const WORSE_ALPHA = 0.05
/** `repeat` below this = slow mode: a few pairs, no test. */
export const SLOW_BELOW = 3

export const isSlow = (repeat: number) => repeat < SLOW_BELOW
/** Pairs of the first look. */
export const lookPairs = (repeat: number) => (isSlow(repeat) ? 1 : LOOK_PAIRS)
/** Pairs of one stage of a keep decision (slow mode has one stage of `repeat` pairs). */
export const stagePairs = (repeat: number) => (isSlow(repeat) ? Math.max(1, repeat) : CONFIRM_PAIRS)
/** Whether pair number `index` (0-based) measures HEAD first. The order alternates: HC, CH, HC, … */
export const headFirst = (index: number) => index % 2 === 0

/**
 * The number the test ranks: the pair's difference over the SUM of its two values,
 * positive = the candidate was better. Unlike `pairGain` (difference over HEAD's value)
 * it only changes sign when the two runs trade places. That symmetry is what the exact
 * test rests on: with (c − h) / h a slow HEAD run would weigh less than an equally slow
 * candidate run. Signs and medians agree with pairGain; only the ranks can differ.
 */
export function pairScore([head, candidate]: Pair, direction: Direction): number {
  const sum = Math.abs(head) + Math.abs(candidate)
  if (sum === 0) return 0
  return (direction === "lower" ? head - candidate : candidate - head) / sum
}

// Null distributions by rank pattern. Without ties the pattern only depends on n, so in
// practice this holds a handful of entries; coarse metrics add a few per tie pattern.
const tailCache = new Map<string, Float64Array>()

/**
 * Exact one-sided Wilcoxon signed-rank p-value for "the differences are positive".
 *
 * - Ranks are those of the absolute differences; ties share the average rank.
 * - The statistic is the rank sum of the positive differences.
 * - p = the share of all 2^n sign assignments whose rank sum is at least the observed one
 *   (counted exactly, with the ranks as they are, ties included).
 * - A zero difference keeps its rank and counts as "not positive". That is the
 *   conservative choice for the hypothesis under test: dropping zeros (the textbook
 *   variant) would let 3 better pairs and 13 identical ones look like a clean sweep.
 * For the opposite hypothesis pass the negated differences; zeros count against that one too.
 */
export function signedRankP(differences: number[]): number {
  const n = differences.length
  if (n === 0) return 1
  const order = differences.map((_, i) => i).sort((a, b) => Math.abs(differences[a]) - Math.abs(differences[b]))
  // Doubled ranks, so averaged ranks of ties stay whole numbers.
  const doubled = new Array<number>(n)
  for (let i = 0; i < n; ) {
    let j = i
    while (j + 1 < n && Math.abs(differences[order[j + 1]]) === Math.abs(differences[order[i]])) j++
    for (let k = i; k <= j; k++) doubled[k] = i + j + 2 // 2 × mean of ranks i+1 … j+1
    i = j + 1
  }
  let observed = 0
  for (let k = 0; k < n; k++) if (differences[order[k]] > 0) observed += doubled[k]

  const key = doubled.join(",")
  let tail = tailCache.get(key)
  if (!tail) {
    const max = n * (n + 1)
    // counts[s] = number of sign assignments with doubled rank sum s
    let counts = new Float64Array(max + 1)
    counts[0] = 1
    for (const r of doubled) {
      const next = new Float64Array(max + 1)
      for (let s = 0; s <= max; s++) {
        if (!counts[s]) continue
        next[s] += counts[s]
        next[s + r] += counts[s]
      }
      counts = next
    }
    tail = new Float64Array(max + 1)
    let above = 0
    for (let s = max; s >= 0; s--) {
      above += counts[s]
      tail[s] = above / 2 ** n
    }
    if (tailCache.size > 2000) tailCache.clear()
    tailCache.set(key, tail)
  }
  return tail[observed]
}

export interface DecisionInput {
  /** The decision pairs measured so far, in order. Never the look's pairs. */
  pairs: Pair[]
  direction: Direction
  /** The segment's `repeat`: sets the mode. */
  repeat: number
  /** settings.minImprovement. */
  minImprovement: number
  /** A simplification: "not worse" is enough. */
  neutral?: boolean
}

export interface Decision {
  /** Pairs still to measure before there is a verdict; 0 = decided. */
  more: number
  confirmed: boolean
  /** How many of `pairs` the verdict used (stage 1 alone, or both stages). */
  used: number
  stage: 1 | 2
  /** Median relative difference of the used pairs, positive = better. */
  gain: number
  /** One-sided p-value for "better"; null in slow mode. */
  p: number | null
  /** Simplifications in standard mode: one-sided p-value for "worse". */
  pWorse?: number
  /** Pairs in which the candidate was better. */
  better: number
  /** A sentence the tool shows the agent. */
  reason: string
}

const percent = (fraction: number) => `${(fraction * 100).toFixed(2).replace(/\.?0+$/, "")}%`

/**
 * Where a keep decision stands, as a function of the pairs measured so far. Called after
 * every batch: it either asks for more pairs or gives the verdict. Being a pure function
 * of the pairs is what makes a decision resumable: after an interruption the stored pairs
 * give the same answer, and nothing is rolled again.
 *
 * Standard mode (repeat ≥ 3), an improvement:
 *   stage 1 = the first CONFIRM_PAIRS pairs: p ≤ ALPHA_STAGE → confirmed; p > EXTEND_BELOW
 *   → not confirmed; otherwise stage 2 = CONFIRM_PAIRS more, all pairs tested together,
 *   confirmed when p ≤ ALPHA_STAGE.
 * Standard mode, a simplification: CONFIRM_PAIRS pairs, one stage. Confirmed unless the
 *   candidate is significantly worse (the same test the other way, p ≤ WORSE_ALPHA) or its
 *   median is worse by more than minImprovement.
 * Slow mode (repeat 1–2): `repeat` pairs, no test. Confirmed when every pair is better and
 *   the median gain reaches minImprovement (a simplification: when the median isn't worse
 *   by more than minImprovement).
 */
export function decide(input: DecisionInput): Decision {
  const { pairs, direction, repeat, minImprovement, neutral = false } = input
  const stage1 = stagePairs(repeat)
  const tolerance = percent(minImprovement)
  const view = (count: number) => {
    const used = pairs.slice(0, count)
    const gains = used.map((p) => pairGain(p, direction))
    return { used, gain: median(gains), better: gains.filter((g) => g > 0).length, scores: used.map((p) => pairScore(p, direction)) }
  }
  const tally = (v: ReturnType<typeof view>) =>
    `better in ${v.better} of ${v.used.length} pair${v.used.length === 1 ? "" : "s"}, median ${gainText(v.gain)}`

  if (pairs.length < stage1) {
    return { more: stage1 - pairs.length, confirmed: false, used: pairs.length, stage: 1, gain: 0, p: null, better: 0, reason: "" }
  }
  const first = view(stage1)
  const base = { more: 0, used: stage1, stage: 1 as const, gain: first.gain, better: first.better }

  if (isSlow(repeat)) {
    const confirmed = neutral ? first.gain >= -minImprovement : first.better === stage1 && first.gain >= minImprovement
    const noTest = "Slow mode: decided on a few pairs, with no statistical check."
    return {
      ...base,
      confirmed,
      p: null,
      reason: neutral
        ? confirmed
          ? `Confirmed as a simplification: not worse than the last commit by more than ${tolerance} (${tally(first)}). ${noTest}`
          : `Not confirmed: a simplification may not cost more than ${tolerance} (${tally(first)}). ${noTest}`
        : confirmed
          ? `Confirmed: ${tally(first)}; a keep needs every pair better and at least ${tolerance}. ${noTest}`
          : `Not confirmed: ${tally(first)}; a keep needs every pair better and a median of at least ${tolerance}. ${noTest}`,
    }
  }

  const p1 = signedRankP(first.scores)
  if (neutral) {
    const pWorse = signedRankP(first.scores.map((s) => -s))
    const significantlyWorse = pWorse <= WORSE_ALPHA
    const tooCostly = first.gain < -minImprovement
    const confirmed = !significantlyWorse && !tooCostly
    return {
      ...base,
      confirmed,
      p: p1,
      pWorse,
      reason: confirmed
        ? `Confirmed as a simplification: not measurably worse than the last commit (${tally(first)}; "worse" has ${pText(pWorse)}, refused at ${WORSE_ALPHA} or below).`
        : significantlyWorse
          ? `Not confirmed: measurably worse than the last commit (${tally(first)}; "worse" has ${pText(pWorse)}, a simplification is refused at ${WORSE_ALPHA} or below).`
          : `Not confirmed: a simplification may not cost more than ${tolerance} (${tally(first)}).`,
    }
  }

  const needs = `a keep needs p ≤ ${ALPHA_STAGE}`
  if (p1 <= ALPHA_STAGE) {
    return { ...base, confirmed: true, p: p1, reason: `Confirmed: ${tally(first)} (exact paired test, ${pText(p1)}; ${needs}).` }
  }
  if (p1 > EXTEND_BELOW) {
    return {
      ...base,
      confirmed: false,
      p: p1,
      reason:
        `Not confirmed: ${tally(first)} (exact paired test, ${pText(p1)}; ${needs}, and above ${EXTEND_BELOW} no more pairs are measured). ` +
        (first.gain > 0 ? "The gain doesn't stand out from the noise." : "The first look was a lucky draw."),
    }
  }
  const total = 2 * stage1
  if (pairs.length < total) {
    return { more: total - pairs.length, confirmed: false, used: pairs.length, stage: 2, gain: first.gain, p: p1, better: first.better, reason: "" }
  }
  const all = view(total)
  const p2 = signedRankP(all.scores)
  const confirmed = p2 <= ALPHA_STAGE
  const extended = `the first ${stage1} were promising but not enough (${pText(p1)}), so ${stage1} more were measured`
  return {
    more: 0,
    confirmed,
    used: total,
    stage: 2,
    gain: all.gain,
    better: all.better,
    p: p2,
    reason: confirmed
      ? `Confirmed: ${tally(all)} (exact paired test on all ${total} pairs, ${pText(p2)}; ${needs}; ${extended}).`
      : `Not confirmed: ${tally(all)} (exact paired test on all ${total} pairs, ${pText(p2)}; ${needs}; ${extended}). The gain doesn't stand out from the noise.`,
  }
}

/**
 * Does the run right after a file swap look slower than the other run of its pair?
 *
 * Files only change hands inside a pair, so from the second pair on it is always the
 * second run of a pair that follows a swap: the candidate in pairs 3, 5, … (0-based 2, 4, …)
 * and HEAD in pairs 2, 4, … If that run pays for something (measure.sh times a rebuild of
 * the swapped files), the candidate looks better in every even-numbered pair than in any
 * odd-numbered one. That can't confirm a no-op, but it buries a real gain smaller than the
 * cost. Returned as a hint for the agent when a keep wasn't confirmed; by chance alone it
 * shows up in about 3 % of 8-pair decisions.
 */
export function swapOrderEffect(pairs: Pair[], direction: Direction): boolean {
  const candidateAfterSwap: number[] = []
  const headAfterSwap: number[] = []
  pairs.forEach((p, i) => {
    if (i === 0) return // both runs of the first pair follow a swap
    ;(headFirst(i) ? candidateAfterSwap : headAfterSwap).push(pairGain(p, direction))
  })
  if (candidateAfterSwap.length < 3 || headAfterSwap.length < 3) return false
  return Math.max(...candidateAfterSwap) < Math.min(...headAfterSwap)
}

// ── Benchmark check at the baseline ───────────────────────

/** Relative spread between identical runs above which small gains get hard to confirm. */
export const SPREAD_WARN = 0.05
/** A warm-up this much worse than the median suggests a cold-start cost inside the timed part. */
export const WARMUP_WARN = 0.2

/**
 * Look at the baseline's runs (identical code, back to back) for signs of a benchmark that will
 * make the loop slow or blind. Costs no extra runs: it reuses the warm-up and the baseline
 * samples. Returns plain-language warnings for the agent to fix with the user before experimenting.
 * Never blocks: some workloads are noisy by nature, and the test stays honest either way.
 */
export function benchmarkCheck(input: { samples: number[]; warmup?: number; direction: Direction }): string[] {
  const { samples, warmup, direction } = input
  const warnings: string[] = []
  if (samples.length < 3) return warnings
  const mid = median(samples)
  if (mid === 0) return warnings
  const spread = median(samples.map((v) => Math.abs(v - mid))) / Math.abs(mid)

  if (spread > SPREAD_WARN) {
    warnings.push(
      `Identical runs differ by about ${(spread * 100).toFixed(0)} % (typical deviation from the median). ` +
        "Gains smaller than that will rarely be confirmed. Usual causes: a build, install or cache fill inside the timed part; " +
        "input that changes between runs; too little work per run; other load on the machine.",
    )
  }
  // Coarse numbers: a small integer metric (e.g. whole milliseconds of a 4 ms workload) can only
  // move in big relative steps, so pairs tie and small gains are invisible.
  const distinct = new Set(samples).size
  if (samples.every(Number.isInteger) && Math.abs(mid) < 50 && distinct > 1) {
    warnings.push(
      `The metric is coarse (whole numbers around ${mid}): one step is ${(100 / Math.abs(mid)).toFixed(0)} %. ` +
        "Do more work per run (repeat the workload inside measure.sh) or report a finer unit.",
    )
  }
  if (warmup !== undefined && Number.isFinite(warmup)) {
    const worse = direction === "lower" ? (warmup - mid) / Math.abs(mid) : (mid - warmup) / Math.abs(mid)
    if (worse > WARMUP_WARN) {
      warnings.push(
        `The first (warm-up) run was ${(worse * 100).toFixed(0)} % worse than the rest. Something in the timed part costs more ` +
          "on a cold start, like a build, a compile or a cache fill. Experiments swap files before many runs, so that cost can " +
          "come back and hide real gains. Do it before the clock starts.",
      )
    }
  }
  return warnings
}
