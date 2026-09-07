import { describe, expect, test } from 'bun:test'
import type { Exit } from '../cause.ts'
import { Fiber } from '../fiber.ts'
import { sync, type Fx } from '../fx.ts'
import { fx, gen } from '../gen.ts'
import {
  acquire,
  all,
  ensuring,
  fork,
  fromPromise,
  interruptFiber,
  join,
  joinExit,
  race,
  scoped,
  sleep,
  timeout,
} from '../ops.ts'
import { err, ok, type Result } from '../result.ts'
import { run, runExit, runtime } from '../run.ts'
import { ServiceMap } from '../service_map.ts'
import { start } from '../interpreter.ts'
import { service } from '../service.ts'

class Boom {
  readonly _tag = 'Boom' as const
  constructor(readonly why: string) {}
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

describe('asynchrony', () => {
  test('sleep suspends and resumes', async () => {
    const started = Date.now()
    expect(value(await run(sleep(25), []))).toBeUndefined()
    expect(Date.now() - started).toBeGreaterThanOrEqual(20)
  })

  test('fromPromise resolves', async () => {
    const effect = fromPromise(async () => 'resolved')
    expect(value(await run(effect, []))).toBe('resolved')
  })

  test('fromPromise maps a rejection into the error channel', async () => {
    const effect = fromPromise(
      async () => {
        throw new Error('network')
      },
      (reason) => new Boom(String(reason))
    )
    expect(failure(await run(effect, [])).why).toContain('network')
  })

  test('a promise that is already resolved does not need a park', async () => {
    const effect = gen(function* () {
      const a = yield* fromPromise(async () => 1)
      const b = yield* fromPromise(async () => 2)
      return a + b
    })
    expect(value(await run(effect, []))).toBe(3)
  })

  test('generators interleave sync and async freely', async () => {
    const effect = gen(function* () {
      const a = yield* ok(1)
      yield* sleep(1)
      const b = yield* fromPromise(async () => 2)
      const c = yield* sync(() => 3)
      return a + b + c
    })
    expect(value(await run(effect, []))).toBe(6)
  })
})

describe('fibers and structured concurrency', () => {
  test('fork runs work concurrently and join collects it', async () => {
    const effect = gen(function* () {
      const first = yield* fork(gen(function* () {
        yield* sleep(10)
        return 'a'
      }))
      const second = yield* fork(gen(function* () {
        yield* sleep(10)
        return 'b'
      }))
      return `${yield* join<string, never>(first)}${yield* join<string, never>(second)}`
    })
    const started = Date.now()
    expect(value(await run(effect, []))).toBe('ab')
    // Concurrent, not sequential: two 10ms sleeps in well under 20ms.
    expect(Date.now() - started).toBeLessThan(19)
  })

  test('a child cannot outlive its parent', async () => {
    let childFinished = false
    const effect = gen(function* () {
      yield* fork(gen(function* () {
        yield* sleep(50)
        childFinished = true
        return 'late'
      }))
      return 'parent done'
    })
    expect(value(await run(effect, []))).toBe('parent done')
    // The parent waited for the child to unwind before completing, and the
    // child was interrupted rather than allowed to finish.
    expect(childFinished).toBe(false)
  })

  test('interrupting a fiber runs its finalizers', async () => {
    const cleaned: string[] = []
    const effect = gen(function* () {
      const child = yield* fork(
        scoped(
          gen(function* () {
            yield* acquire(
              () => 'resource',
              () => {
                cleaned.push('released')
              }
            )
            yield* sleep(1000)
            return 'never'
          })
        )
      )
      yield* sleep(5)
      yield* interruptFiber(child, 'no longer needed')
      return 'done'
    })
    expect(value(await run(effect, []))).toBe('done')
    expect(cleaned).toEqual(['released'])
  })

  test('joinExit reports interruption as a value', async () => {
    const effect = gen(function* () {
      const child = yield* fork(sleep(1000))
      yield* sleep(2)
      child.interrupt('cancelled')
      return yield* joinExit<void, never>(child)
    })
    const exit = value(await run(effect, []))
    expect(exit.ok).toBe(false)
    expect(failure(exit)._tag).toBe('Interrupt')
  })

  test('an AbortSignal reaches the underlying operation', async () => {
    let sawAbort = false
    const effect = gen(function* () {
      const child = yield* fork(
        fromPromise(
          (signal) =>
            new Promise<string>((_resolve, reject) => {
              signal.addEventListener('abort', () => {
                sawAbort = true
                reject(new Error('aborted'))
              })
            })
        )
      )
      yield* sleep(5)
      yield* interruptFiber(child)
      return 'done'
    })
    await run(effect, [])
    expect(sawAbort).toBe(true)
  })
})

describe('forking does not leak listeners', () => {
  test('ten thousand forks leave zero listeners on the parent signal', () => {
    // The reason `fork` links parent and child with an explicit listener pair
    // rather than AbortSignal.any: the listener has to come off
    // deterministically when the child settles. Relying on the composite
    // signal being collected would leak one listener per request on a
    // long-lived server.
    const parent = new Fiber(ok('root'), ServiceMap.empty())
    const signal = parent.signal
    let added = 0
    let removed = 0

    const nativeAdd = signal.addEventListener.bind(signal)
    const nativeRemove = signal.removeEventListener.bind(signal)
    Object.defineProperty(signal, 'addEventListener', {
      value: (...args: Parameters<typeof nativeAdd>) => {
        added += 1
        return nativeAdd(...args)
      },
      configurable: true,
    })
    Object.defineProperty(signal, 'removeEventListener', {
      value: (...args: Parameters<typeof nativeRemove>) => {
        removed += 1
        return nativeRemove(...args)
      },
      configurable: true,
    })

    for (let index = 0; index < 10_000; index++) {
      start(parent.fork(ok(index)), true)
    }

    expect(added).toBe(10_000)
    expect(removed).toBe(10_000)
    expect(parent.children.size).toBe(0)
  })
})

describe('race', () => {
  test('the winner decides the result', async () => {
    const fast = gen(function* () {
      yield* sleep(5)
      return 'fast'
    })
    const slow = gen(function* () {
      yield* sleep(200)
      return 'slow'
    })
    expect(value(await run(race(fast, slow), []))).toBe('fast')
  })

  test("the loser is interrupted, and its finalizer observes Exit = Interrupt", async () => {
    let observed: Exit<unknown, unknown> | undefined
    const slow = scoped(
      gen(function* () {
        yield* acquire(
          () => 'connection',
          (_resource, exit) => {
            observed = exit
          }
        )
        yield* sleep(500)
        return 'slow'
      })
    )
    const fast = gen(function* () {
      yield* sleep(5)
      return 'fast'
    })

    expect(value(await run(race(fast, slow), []))).toBe('fast')

    // The race waits for the loser to finish unwinding, so this is settled by
    // the time the winner's value is returned - no polling, no flake.
    expect(observed).toBeDefined()
    expect(observed?.ok).toBe(false)
    expect(failure(observed as Exit<unknown, unknown>)._tag).toBe('Interrupt')
  })

  test('a losing failure does not override the winner', async () => {
    const winner = gen(function* () {
      yield* sleep(5)
      return 'winner'
    })
    const loser = gen(function* () {
      yield* sleep(300)
      return yield* err(new Boom('late'))
    })
    expect(value(await run(race(winner, loser), []))).toBe('winner')
  })

  test('timeout is race with a clock', async () => {
    const slow = gen(function* () {
      yield* sleep(500)
      return 'slow'
    })
    const guarded = timeout(20, () => new Boom('timed out'))(slow)
    expect(failure(await run(guarded, [])).why).toBe('timed out')
  })

  test('timeout leaves a fast effect alone', async () => {
    const quick = gen(function* () {
      yield* sleep(1)
      return 'quick'
    })
    expect(value(await run(timeout(200, () => new Boom('nope'))(quick), []))).toBe('quick')
  })
})

describe('all', () => {
  test('runs concurrently and preserves positions', async () => {
    const started = Date.now()
    const collected = await run(
      all([
        gen(function* () {
          yield* sleep(15)
          return 1
        }),
        gen(function* () {
          yield* sleep(15)
          return 'two'
        }),
        gen(function* () {
          yield* sleep(15)
          return true
        }),
      ]),
      []
    )
    expect(value(collected)).toEqual([1, 'two', true])
    expect(Date.now() - started).toBeLessThan(35)
  })

  test('fails fast and interrupts the survivors', async () => {
    let survivorFinished = false
    const outcome = await run(
      all([
        gen(function* () {
          yield* sleep(5)
          return yield* err(new Boom('first'))
        }),
        gen(function* () {
          yield* sleep(300)
          survivorFinished = true
          return 'late'
        }),
      ]),
      []
    )
    expect(failure(outcome).why).toBe('first')
    expect(survivorFinished).toBe(false)
  })

  test('an empty list succeeds immediately', async () => {
    expect(value(await run(all([]), []))).toEqual([])
  })
})

describe('scopes and resources', () => {
  test('finalizers run in reverse acquisition order', async () => {
    const order: string[] = []
    const effect = scoped(
      gen(function* () {
        yield* acquire(() => 'a', () => void order.push('a'))
        yield* acquire(() => 'b', () => void order.push('b'))
        yield* acquire(() => 'c', () => void order.push('c'))
        return 'body'
      })
    )
    expect(value(await run(effect, []))).toBe('body')
    expect(order).toEqual(['c', 'b', 'a'])
  })

  test('a finalizer sees the failure that closed the scope', async () => {
    let observed: Exit<unknown, unknown> | undefined
    const effect = scoped(
      gen(function* () {
        yield* acquire(() => 'r', (_r, exit) => void (observed = exit))
        return yield* err(new Boom('inner'))
      })
    )
    expect(failure(await run(effect, [])).why).toBe('inner')
    expect(observed?.ok).toBe(false)
  })

  test('one broken finalizer does not strand the rest', async () => {
    const order: string[] = []
    const effect = scoped(
      gen(function* () {
        yield* acquire(() => 'a', () => void order.push('a'))
        yield* acquire(
          () => 'b',
          () => {
            throw new Error('finalizer bug')
          }
        )
        yield* acquire(() => 'c', () => void order.push('c'))
        return 'body'
      })
    )
    expect(value(await run(effect, []))).toBe('body')
    // 'b' threw; 'a' still released.
    expect(order).toEqual(['c', 'a'])
  })

  test('ensuring runs on success and on failure', async () => {
    const seen: string[] = []
    const record = (label: string) => () =>
      sync(() => {
        seen.push(label)
      })
    await run(ensuring(record('ok'))(ok('fine')), [])
    await runExit(ensuring(record('bad'))(err(new Boom('x'))), [])
    expect(seen).toEqual(['ok', 'bad'])
  })
})

// ===========================================================================
// The three-service example again - unchanged program, async providers
// ===========================================================================

interface CfgSvc {
  readonly url: string
}
interface LogSvc {
  info(message: string): Fx<void>
}
interface DbSvc {
  query(id: string): Fx<{ readonly id: string; readonly name: string }, Boom>
}

const Config = service<CfgSvc>()('Config')
const Logger = service<LogSvc>()('Logger')
const Db = service<DbSvc>()('Db')

/** Byte-for-byte the program from the synchronous phase-3 suite. */
const getUser = fx(function* (id: string) {
  const db = yield* Db
  const log = yield* Logger
  yield* log.info(`load ${id}`)
  return yield* db.query(id)
})

describe('async providers, unmodified program', () => {
  const logged: string[] = []
  const closed: string[] = []

  const ConfigLive = Config.make(function* () {
    // genuinely asynchronous construction
    yield* sleep(1)
    return yield* fromPromise(async () => ({ url: 'postgres://async' }))
  })

  const LoggerLive = Logger.make(function* () {
    yield* Config
    return { info: (message: string) => sync(() => void logged.push(message)) }
  })

  const DbLive = Db.make(function* () {
    const cfg = yield* Config
    const log = yield* Logger
    const pool = yield* acquire(
      async () => ({ url: cfg.url }),
      () => void closed.push('pool')
    )
    yield* log.info(`connected to ${pool.url}`)
    return {
      query: (id: string) =>
        id === '1'
          ? ok({ id, name: 'Ada' })
          : err(new Boom(id)),
    }
  })

  test('resolves through an asynchronously built graph', async () => {
    logged.length = 0
    closed.length = 0
    const result = await run(getUser('1'), [DbLive, ConfigLive, LoggerLive])
    expect(value(result)).toEqual({ id: '1', name: 'Ada' })
    expect(logged).toEqual(['connected to postgres://async', 'load 1'])
    // the pool acquired during construction was released with the run
    expect(closed).toEqual(['pool'])
  })

  test('a typed failure still reaches the caller', async () => {
    expect(failure(await run(getUser('nope'), [DbLive, ConfigLive, LoggerLive])).why).toBe(
      'nope'
    )
  })

  test('a runtime builds once and is reused across runs', async () => {
    logged.length = 0
    closed.length = 0
    const rt = await runtime([DbLive, ConfigLive, LoggerLive])
    expect(value(await rt.run(getUser('1')))).toEqual({ id: '1', name: 'Ada' })
    expect(value(await rt.run(getUser('1')))).toEqual({ id: '1', name: 'Ada' })
    // one connection message, two loads: the graph was built exactly once
    expect(logged.filter((line) => line.startsWith('connected'))).toHaveLength(1)
    expect(closed).toEqual([])
    await rt.close()
    expect(closed).toEqual(['pool'])
  })

  test('a runtime is an AsyncDisposable, releasing in reverse order', async () => {
    const order: string[] = []
    const A = Config.make(function* () {
      yield* acquire(() => 'a', () => void order.push('config'))
      return { url: 'x' }
    })
    const B = Logger.make(function* () {
      yield* Config
      return { info: () => sync(() => {}) }
    })
    const C = Db.make(function* () {
      yield* Config
      yield* Logger
      yield* acquire(() => 'c', () => void order.push('db'))
      return { query: () => ok({ id: '1', name: 'Ada' }) }
    })

    {
      await using rt = await runtime([C, A, B])
      expect(value(await rt.run(getUser('1')))).toEqual({ id: '1', name: 'Ada' })
      expect(order).toEqual([])
    }

    // Db is first in the list, but its body demands Config before it can
    // acquire anything, so Config was acquired first and is released last.
    expect(order).toEqual(['db', 'config'])
  })

  test('a provider failing during construction rejects and tears down', async () => {
    const closedDuringFailure: string[] = []
    const Good = Config.make(function* () {
      yield* acquire(() => 'cfg', () => void closedDuringFailure.push('cfg'))
      return { url: 'x' }
    })
    const Broken = Logger.make(function* () {
      yield* Config
      yield* sleep(1)
      return yield* err(new Boom('logger construction'))
    })
    await expect(runtime([Good, Broken])).rejects.toMatchObject({ why: 'logger construction' })
    expect(closedDuringFailure).toEqual(['cfg'])
  })
})

describe('run versus runtime', () => {
  test('run builds and tears down the graph on every call', async () => {
    const released: string[] = []
    const Cfg = Config.make(function* () {
      yield* acquire(() => 'cfg', () => void released.push('cfg'))
      return { url: 'x' }
    })
    const Log = Logger.make(function* () {
      yield* Config
      return { info: () => sync(() => {}) }
    })
    const Data = Db.make(function* () {
      yield* Config
      yield* Logger
      return { query: () => ok({ id: '1', name: 'Ada' }) }
    })

    await run(getUser('1'), [Cfg, Log, Data])
    await run(getUser('1'), [Cfg, Log, Data])
    // Two runs, two full build/teardown cycles. This is the reason `runtime`
    // exists: calling `run` per request would reconnect the pool per request.
    expect(released).toEqual(['cfg', 'cfg'])

    released.length = 0
    const rt = await runtime([Cfg, Log, Data])
    await rt.run(getUser('1'))
    await rt.run(getUser('1'))
    expect(released).toEqual([])
    await rt.close()
    expect(released).toEqual(['cfg'])
  })
})
