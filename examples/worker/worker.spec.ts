import { describe, expect, test } from 'bun:test'
import { fx, gen } from '../../src/gen.ts'
import { fork, interruptFiber, join, race, scoped, sleep } from '../../src/ops.ts'
import { err, ok, type Result } from '../../src/result.ts'
import { run, runtime } from '../../src/run.ts'
import { sync } from '../../src/fx.ts'
import { Heavy, HeavyError } from './contract.ts'
import {
  HeavyOnMainThread,
  HeavyOnWorker,
  HeavyStub,
  decodeHeavyError,
} from './providers.ts'
import { call, openLink } from './client.ts'
import { service } from '../../src/service.ts'
import type { Fx } from '../../src/fx.ts'

/**
 * A second service over the same worker, exposing the protocol's failure
 * paths. Kept out of `HeavySvc` so the real contract stays honest - a service
 * interface should not carry test hooks.
 */
interface ProbeSvc {
  readonly crash: () => Fx<never, HeavyError>
  readonly missing: () => Fx<never, HeavyError>
}
const Probe = service<ProbeSvc>()('Probe')
type Probe = typeof Probe

const ProbeLive = Probe.make(function* () {
  const link = yield* openLink(new URL('./heavy.worker.ts', import.meta.url))
  return {
    crash: () => call<never, HeavyError>(link, 'crash', [], decodeHeavyError),
    missing: () => call<never, HeavyError>(link, 'noSuchMethod', [], decodeHeavyError),
  }
})

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

/**
 * The program under test. It never mentions workers, messages or threads - it
 * just uses the `Heavy` service. Which side of the boundary the work happens
 * on is decided entirely by which provider is supplied.
 */
const fingerprint = fx(function* (input: string, rounds: number) {
  const heavy = yield* Heavy
  const digest = yield* heavy.digest(input, rounds)
  return `${input.length}:${digest}`
})

describe('the same program, either side of the boundary', () => {
  test('produces identical results on the main thread and on a worker', async () => {
    const onMain = await run(fingerprint('hello', 2_000), [HeavyOnMainThread])
    const onWorker = await run(fingerprint('hello', 2_000), [HeavyOnWorker])
    expect(value(onWorker)).toBe(value(onMain))
  })

  test('a stub is a third implementation of the same contract', async () => {
    expect(value(await run(fingerprint('hello', 1), [HeavyStub]))).toBe('5:stubbed')
  })

  test('choosing a thread is a one-line change to the provider list', async () => {
    // Nothing in `fingerprint` changes. That is the whole point of routing
    // this through DI rather than importing a worker directly.
    for (const providers of [[HeavyOnMainThread], [HeavyOnWorker]] as const) {
      expect(value(await run(fingerprint('abc', 500), providers))).toContain('3:')
    }
  })
})

describe('offloading keeps the calling thread responsive', () => {
  /** Counts event-loop turns while an effect runs. */
  const withTicks = <Value, Error, Dependency extends string>(
    effect: Fx<Value, Error, Dependency>
  ) =>
    gen(function* () {
      let ticks = 0
      const subject = yield* fork(effect)
      const ticker = yield* fork(
        gen(function* () {
          while (true) {
            yield* sleep(2)
            ticks += 1
          }
        })
      )
      const result = yield* join<Value, Error>(subject)
      yield* interruptFiber(ticker)
      return { result, ticks }
    })

  test('the event loop keeps turning while the worker computes', async () => {
    const heavy = fx(function* () {
      const service = yield* Heavy
      return yield* service.countPrimes(3_000_000)
    })

    const observed = value(
      await run(withTicks(heavy()), [HeavyOnWorker])
    )
    expect(observed.result).toBe(216_816)
    // Timers fired *during* the computation: the main thread was never blocked.
    expect(observed.ticks).toBeGreaterThan(2)
  })

  test('the same work inline blocks the event loop completely', async () => {
    const heavy = fx(function* () {
      const service = yield* Heavy
      return yield* service.countPrimes(3_000_000)
    })

    const observed = value(
      await run(withTicks(heavy()), [HeavyOnMainThread])
    )
    expect(observed.result).toBe(216_816)
    // Same answer, but nothing else got a turn while it ran.
    expect(observed.ticks).toBe(0)
  })
})

describe('interruption crosses the thread boundary', () => {
  test('cancelling the caller aborts the work in the worker', async () => {
    // If cancellation stopped at the boundary, the worker would still be
    // churning on the abandoned request and the follow-up call would queue
    // behind it. Timing the follow-up is what proves the abort landed.
    const program = gen(function* () {
      const service = yield* Heavy

      const abandoned = yield* fork(service.digest('x'.repeat(64), 10_000_000))
      yield* sleep(20)
      yield* interruptFiber(abandoned, 'user navigated away')

      const started = Date.now()
      const quick = yield* service.digest('hello', 1_000)
      return { quick, elapsed: Date.now() - started }
    })

    const observed = value(await run(program, [HeavyOnWorker]))
    expect(observed.quick).toHaveLength(8)
    // A worker still grinding through 20M rounds could not answer this fast.
    expect(observed.elapsed).toBeLessThan(250)
  })

  test('race interrupts the losing worker call', async () => {
    const program = gen(function* () {
      const service = yield* Heavy
      return yield* race(
        gen(function* () {
          yield* sleep(10)
          return 'timeout won'
        }),
        gen(function* () {
          return yield* service.digest('y'.repeat(64), 10_000_000)
        })
      )
    })
    expect(value(await run(program, [HeavyOnWorker]))).toBe('timeout won')
  })
})

describe('failures across the boundary', () => {
  test('an expected failure stays in the error channel, typed', async () => {
    // countPrimes rejects a nonsense limit. The worker throws plain cloneable
    // data; structured clone drops prototypes, so the class is rebuilt here.
    const program = fx(function* (limit: number) {
      const service = yield* Heavy
      return yield* service.countPrimes(limit)
    })
    const error = failure(await run(program(1), [HeavyOnWorker]))
    expect(error).toBeInstanceOf(HeavyError)
    expect(error.reason).toContain('at least 2')
  })

  test('both implementations agree on failures, not just on values', async () => {
    const program = fx(function* (limit: number) {
      const service = yield* Heavy
      return yield* service.countPrimes(limit)
    })
    const onWorker = failure(await run(program(1), [HeavyOnWorker]))
    const onMain = failure(await run(program(1), [HeavyOnMainThread]))
    // Swapping providers is only transparent if the failure paths match too.
    expect(onWorker.reason).toBe(onMain.reason)
    expect(onMain).toBeInstanceOf(HeavyError)
  })

  test('a bug in the worker arrives as a defect, not a typed failure', async () => {
    const program = gen(function* () {
      const probe = yield* Probe
      return yield* probe.crash()
    })
    // run() rejects on defects: a worker bug is a bug here too, and must not
    // be quietly absorbed into the error channel.
    await expect(run(program, [ProbeLive])).rejects.toThrow('worker bug')
  })

  test('an unknown method is a defect', async () => {
    const program = gen(function* () {
      const probe = yield* Probe
      return yield* probe.missing()
    })
    await expect(run(program, [ProbeLive])).rejects.toThrow('no method')
  })
})

describe('worker lifetime is tied to the scope', () => {
  test('a runtime keeps one worker across many calls and terminates it on close', async () => {
    const rt = await runtime([HeavyOnWorker])
    const first = await rt.run(fingerprint('a', 100))
    const second = await rt.run(fingerprint('b', 100))
    expect(value(first)).toContain('1:')
    expect(value(second)).toContain('1:')
    await rt.close()

    // After close the worker is gone; a fresh runtime starts a new one.
    const revived = await runtime([HeavyOnWorker])
    expect(value(await revived.run(fingerprint('c', 100)))).toContain('1:')
    await revived.close()
  })

  test('the worker is terminated even when the program fails', async () => {
    const failing = gen(function* () {
      const service = yield* Heavy
      yield* service.digest('a', 10)
      return yield* err(new HeavyError('deliberate'))
    })
    // No leak, no hang: the scope closes on the failure path too. If the
    // worker were not terminated this test would keep the process alive.
    expect(failure(await run(failing, [HeavyOnWorker])).reason).toBe('deliberate')
  })
})
