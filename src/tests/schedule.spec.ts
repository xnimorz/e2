import { describe, expect, test } from 'bun:test'
import { sync, type Fx } from '../fx.ts'
import { gen } from '../gen.ts'
import { Schedule, forEach, repeat, retry, sleep } from '../ops.ts'
import { err, ok, type Result } from '../result.ts'
import { run, runExit } from '../run.ts'

class Boom {
  readonly _tag = 'Boom' as const
  constructor(readonly attempt: number) {}
}

function value<Value, Error>(result: Result<Value, Error>): Value {
  if (!result.ok) {
    throw new Error(`expected Ok, received Err(${JSON.stringify(result.error)})`)
  }
  return result.value
}

function failure<Value, Error>(result: Result<Value, Error>): Error {
  if (result.ok) {
    throw new Error(`expected Err, received Ok(${JSON.stringify(result.value)})`)
  }
  return result.error
}

/** Fails `failures` times, then succeeds. */
const flaky = (failures: number): { effect: Fx<string, Boom>; calls: () => number } => {
  let calls = 0
  const effect = gen(function* () {
    calls += 1
    if (calls <= failures) {
      return yield* err(new Boom(calls))
    }
    return `ok after ${calls}`
  })
  return { effect, calls: () => calls }
}

describe('Schedule', () => {
  test('recurs allows a bounded number of extra attempts', () => {
    const schedule = Schedule.recurs(3)
    expect([0, 1, 2, 3].map((n) => schedule.next(n, undefined))).toEqual([
      0,
      0,
      0,
      undefined,
    ])
  })

  test('spaced is a constant interval, unbounded', () => {
    const schedule = Schedule.spaced(50)
    expect([0, 1, 99].map((n) => schedule.next(n, undefined))).toEqual([50, 50, 50])
  })

  test('exponential doubles', () => {
    const schedule = Schedule.exponential(10)
    expect([0, 1, 2, 3].map((n) => schedule.next(n, undefined))).toEqual([10, 20, 40, 80])
  })

  test('maxDelay clamps runaway backoff', () => {
    const schedule = Schedule.exponential(10).maxDelay(35)
    expect([0, 1, 2, 3].map((n) => schedule.next(n, undefined))).toEqual([10, 20, 35, 35])
  })

  test('upTo bounds an otherwise unbounded policy', () => {
    const schedule = Schedule.spaced(5).upTo(2)
    expect([0, 1, 2].map((n) => schedule.next(n, undefined))).toEqual([5, 5, undefined])
  })

  test('jittered stays within [delay * (1 - factor), delay]', () => {
    const schedule = Schedule.spaced(100).jittered(0.5)
    for (let i = 0; i < 200; i++) {
      const delay = schedule.next(0, undefined) as number
      expect(delay).toBeGreaterThanOrEqual(50)
      expect(delay).toBeLessThanOrEqual(100)
    }
  })

  test('jitter actually varies, so a herd does not resynchronise', () => {
    const schedule = Schedule.spaced(100).jittered()
    const seen = new Set(
      Array.from({ length: 50 }, () => schedule.next(0, undefined) as number)
    )
    expect(seen.size).toBeGreaterThan(40)
  })

  test('whileError stops on a failure it does not recognise', () => {
    const schedule = Schedule.spaced(5).whileError(
      (error: never) => (error as Boom)._tag === 'Boom'
    )
    expect(schedule.next(0, new Boom(1))).toBe(5)
    expect(schedule.next(0, new Error('other'))).toBeUndefined()
  })

  test('stop never retries', () => {
    expect(Schedule.stop.next(0, undefined)).toBeUndefined()
  })
})

describe('retry', () => {
  test('succeeds once the effect stops failing', async () => {
    const { effect, calls } = flaky(2)
    expect(value(await run(retry(Schedule.recurs(5))(effect), []))).toBe('ok after 3')
    expect(calls()).toBe(3)
  })

  test('gives up and surfaces the last failure', async () => {
    const { effect, calls } = flaky(10)
    // 1 initial attempt + 2 retries
    expect(failure(await run(retry(Schedule.recurs(2))(effect), [])).attempt).toBe(3)
    expect(calls()).toBe(3)
  })

  test('does not retry a success', async () => {
    const { effect, calls } = flaky(0)
    await run(retry(Schedule.recurs(5))(effect), [])
    expect(calls()).toBe(1)
  })

  test('waits between attempts', async () => {
    const { effect } = flaky(2)
    const started = Date.now()
    await run(retry(Schedule.spaced(15).upTo(5))(effect), [])
    expect(Date.now() - started).toBeGreaterThanOrEqual(25)
  })

  test('retrying re-runs the description rather than a spent generator', async () => {
    // An Fx is a description, so retry is just reducing it again. A design
    // that stored the generator object would work exactly once.
    const { effect, calls } = flaky(3)
    expect(value(await run(retry(Schedule.recurs(9))(effect), []))).toBe('ok after 4')
    expect(calls()).toBe(4)
  })

  test('whileError lets an unexpected failure through immediately', async () => {
    let calls = 0
    const effect = gen(function* () {
      calls += 1
      return yield* err(new Error('not a Boom'))
    })
    const schedule = Schedule.spaced(1).whileError(
      (error: never) => (error as { _tag?: string })._tag === 'Boom'
    )
    await runExit(retry(schedule)(effect), [])
    expect(calls).toBe(1)
  })

  test('a defect is not retried', async () => {
    let calls = 0
    const effect = sync(() => {
      calls += 1
      throw new Error('bug')
    })
    await runExit(retry(Schedule.recurs(5))(effect), [])
    expect(calls).toBe(1)
  })
})

describe('repeat', () => {
  test('runs again while it keeps succeeding, returning the last value', async () => {
    let calls = 0
    const effect = sync(() => {
      calls += 1
      return calls
    })
    expect(value(await run(repeat(Schedule.recurs(3))(effect), []))).toBe(4)
    expect(calls).toBe(4)
  })

  test('stops at the first failure', async () => {
    const { effect, calls } = flaky(1)
    await runExit(repeat(Schedule.recurs(5))(effect), [])
    expect(calls()).toBe(1)
  })
})

describe('forEach', () => {
  test('is sequential by default', async () => {
    const active: number[] = []
    let peak = 0
    const effect = forEach((item: number) =>
      gen(function* () {
        active.push(item)
        peak = Math.max(peak, active.length)
        yield* sleep(5)
        active.pop()
        return item * 2
      })
    )([1, 2, 3])
    expect(value(await run(effect, []))).toEqual([2, 4, 6])
    expect(peak).toBe(1)
  })

  test('respects a concurrency limit', async () => {
    const active: number[] = []
    let peak = 0
    const effect = forEach(
      (item: number) =>
        gen(function* () {
          active.push(item)
          peak = Math.max(peak, active.length)
          yield* sleep(10)
          active.pop()
          return item
        }),
      { concurrency: 2 }
    )([1, 2, 3, 4, 5, 6])
    expect(value(await run(effect, []))).toEqual([1, 2, 3, 4, 5, 6])
    expect(peak).toBe(2)
  })

  test('unbounded runs everything at once', async () => {
    let peak = 0
    let active = 0
    const effect = forEach(
      () =>
        gen(function* () {
          active += 1
          peak = Math.max(peak, active)
          yield* sleep(10)
          active -= 1
          return 1
        }),
      { concurrency: 'unbounded' }
    )([1, 2, 3, 4, 5])
    await run(effect, [])
    expect(peak).toBe(5)
  })

  test('preserves input order regardless of completion order', async () => {
    const effect = forEach(
      (item: number) =>
        gen(function* () {
          yield* sleep(20 - item * 3)
          return item
        }),
      { concurrency: 'unbounded' }
    )([1, 2, 3, 4, 5])
    expect(value(await run(effect, []))).toEqual([1, 2, 3, 4, 5])
  })

  test('an empty input succeeds', async () => {
    expect(value(await run(forEach(() => ok(1))([]), []))).toEqual([])
  })

  test('a failure stops the rest', async () => {
    let processed = 0
    const effect = forEach((item: number) =>
      gen(function* () {
        processed += 1
        if (item === 2) {
          return yield* err(new Boom(item))
        }
        return item
      })
    )([1, 2, 3, 4])
    expect(failure(await run(effect, [])).attempt).toBe(2)
    expect(processed).toBe(2)
  })
})
