/**
 * The kernel's view of time, identity and chance. Everything in `src/kernel/` reads these through an injected `Env`, never
 * `Date.now()` or `Math.random()`, so tests drive time by hand and replay the same random choices from a seed.
 */

/** Wall-clock time in epoch milliseconds. */
export interface Clock { now(): number }
/** Unique ids that sort in the order they were made, within one process; across restarts they stay unique. */
export interface Ids { next(prefix?: string): string }
/** Uniform numbers in `[0, 1)`. */
export interface Random { next(): number }
export interface Env { readonly clock: Clock; readonly ids: Ids; readonly random: Random }

/** The real clock and `Math.random`, for production. */
export function systemEnv(): Env {
  const clock: Clock = { now: () => Date.now() }
  const random: Random = { next: () => Math.random() }
  return { clock, random, ids: sortableIds(clock, random) }
}

/** A clock that moves only when told to; it starts at `start` (epoch ms). */
export class TestClock implements Clock {
  private at: number
  constructor(start = Date.UTC(2026, 0, 1)) { this.at = start }
  now(): number { return this.at }
  /** Moves the clock forward by `ms`; a negative `ms` moves it back, as a wall clock can be corrected. */
  advance(ms: number): void { this.at += ms }
  set(at: number): void { this.at = at }
}

/** A deterministic generator (mulberry32): the same seed gives the same sequence. */
export function seededRandom(seed: number): Random {
  let state = seed >>> 0
  return {
    next() {
      state = (state + 0x6d2b79f5) >>> 0
      let t = state
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    },
  }
}

/** A test environment: a hand-driven clock and a seeded generator. */
export function testEnv(seed = 1, start?: number): Env & { clock: TestClock } {
  const clock = new TestClock(start)
  const random = seededRandom(seed)
  return { clock, random, ids: sortableIds(clock, random) }
}

const TIME_DIGITS = 9 // base 36: 36^9 ms reaches past the year 5000
const COUNT_DIGITS = 4
const TAIL_DIGITS = 6
const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz'

/**
 * Ids of a time part, a counter and a random tail, each fixed-width base 36, so string order is creation order. The time never
 * goes back, even when the clock does, and the counter orders ids made in the same millisecond; the random tail keeps ids unique
 * after a restart within the same millisecond.
 */
export function sortableIds(clock: Clock, random: Random): Ids {
  let lastTime = 0
  let count = 0
  const digits = (value: number, width: number) => value.toString(36).padStart(width, '0')
  return {
    next(prefix = '') {
      const now = Math.max(Math.floor(clock.now()), lastTime)
      count = now === lastTime ? count + 1 : 0
      lastTime = now
      if (count >= 36 ** COUNT_DIGITS) throw new Error('More ids in one millisecond than the id format orders')
      let tail = ''
      for (let index = 0; index < TAIL_DIGITS; index++) tail += BASE36[Math.floor(random.next() * 36)]
      return `${prefix}${digits(now, TIME_DIGITS)}${digits(count, COUNT_DIGITS)}${tail}`
    },
  }
}
