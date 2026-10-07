import { describe, expect, test } from 'bun:test'
import { AsyncBoundary } from '../errors.ts'
import { Async, catchAll, flatMap, map, suspend, sync, type Fx } from '../fx.ts'
import { fx, gen } from '../gen.ts'
import { err, ok, type Result } from '../result.ts'
import { interpretSync } from '../interpreter.ts'
import { runExit, runSync, runSyncExit } from '../run.ts'
import { services } from '../service_map.ts'
import { service } from '../service.ts'

class DbError {
  readonly _tag = 'DbError' as const
  constructor(readonly id: string) {}
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

describe('primitives', () => {
  test('succeed', () => {
    expect(value(runSync(ok(42), []))).toBe(42)
  })

  test('fail short-circuits into the error channel', () => {
    expect(failure(runSync(err(new DbError('x')), [])).id).toBe('x')
  })

  test('sync runs its thunk exactly once, lazily', () => {
    let calls = 0
    const effect = sync(() => {
      calls += 1
      return calls
    })
    expect(calls).toBe(0)
    expect(value(runSync(effect, []))).toBe(1)
    expect(calls).toBe(1)
  })

  test('an effect is re-runnable and produces the same result', () => {
    const effect = gen(function* () {
      const a = yield* ok(1)
      return a + 1
    })
    expect(value(runSync(effect, []))).toBe(2)
    expect(value(runSync(effect, []))).toBe(2)
  })

  test('suspend defers construction', () => {
    let built = 0
    const effect = suspend(() => {
      built += 1
      return ok(7)
    })
    expect(built).toBe(0)
    expect(value(runSync(effect, []))).toBe(7)
  })
})

describe('combinators', () => {
  test('map transforms success', () => {
    expect(value(runSync(map((n: number) => n * 2)(ok(21)), []))).toBe(42)
  })

  test('map is skipped on failure', () => {
    let applied = false
    const effect = map(() => {
      applied = true
    })(err(new DbError('x')))
    expect(failure(runSync(effect, [])).id).toBe('x')
    expect(applied).toBe(false)
  })

  test('flatMap sequences', () => {
    const effect = flatMap((n: number) => ok(n + 1))(ok(1))
    expect(value(runSync(effect, []))).toBe(2)
  })

  test('catchAll recovers an expected failure', () => {
    const effect = catchAll((e: DbError) => ok(`recovered:${e.id}`))(err(new DbError('x')))
    expect(value(runSync(effect, []))).toBe('recovered:x')
  })

  test('catchAll is skipped when nothing fails', () => {
    let handled = false
    const effect = catchAll(() => {
      handled = true
      return ok('no')
    })(ok('yes'))
    expect(value(runSync(effect, []))).toBe('yes')
    expect(handled).toBe(false)
  })
})

describe('generators', () => {
  test('threads values through successive yields', () => {
    const effect = gen(function* () {
      const a = yield* ok(1)
      const b = yield* ok(2)
      return a + b
    })
    expect(value(runSync(effect, []))).toBe(3)
  })

  test('a failing yield* short-circuits the rest of the body', () => {
    let reached = false
    const effect = gen(function* () {
      yield* err(new DbError('stop'))
      reached = true
      return 'unreachable'
    })
    expect(failure(runSync(effect, [])).id).toBe('stop')
    expect(reached).toBe(false)
  })

  test('yield* on a plain Result is the missing `?` operator', () => {
    const parse = (raw: string): Result<number, DbError> =>
      Number.isNaN(Number(raw)) ? err(new DbError(raw)) : ok(Number(raw))

    const effect = fx(function* (raw: string) {
      const parsed = yield* parse(raw)
      return parsed * 2
    })
    expect(value(runSync(effect('21'), []))).toBe(42)
    expect(failure(runSync(effect('nope'), [])).id).toBe('nope')
  })

  test('generators compose across nested fx calls', () => {
    const inner = fx(function* (n: number) {
      return (yield* ok(n)) + 1
    })
    const outer = gen(function* () {
      const a = yield* inner(1)
      const b = yield* inner(a)
      return b
    })
    expect(value(runSync(outer, []))).toBe(3)
  })

  test('a finally block runs when a later effect fails', () => {
    // Without iterator.return() on unwind this is silently skipped, which is
    // exactly when cleanup matters.
    const cleaned: string[] = []
    const effect = gen(function* () {
      try {
        yield* ok(1)
        yield* err(new DbError('boom'))
        return 'unreachable'
      } finally {
        cleaned.push('inner')
      }
    })
    expect(failure(runSync(effect, [])).id).toBe('boom')
    expect(cleaned).toEqual(['inner'])
  })

  test('nested finally blocks run innermost first', () => {
    const cleaned: string[] = []
    const inner = gen(function* () {
      try {
        yield* err(new DbError('boom'))
      } finally {
        cleaned.push('inner')
      }
    })
    const outer = gen(function* () {
      try {
        yield* inner
      } finally {
        cleaned.push('outer')
      }
    })
    runSyncExit(outer, [])
    expect(cleaned).toEqual(['inner', 'outer'])
  })
})

describe('defects', () => {
  test('a throw inside sync becomes a defect, not a typed failure', () => {
    const boom = new Error('kaboom')
    const effect = sync(() => {
      throw boom
    })
    const exit = runSyncExit(effect, [])
    expect(exit.ok).toBe(false)
    expect(failure(exit)._tag).toBe('Die')
    expect(() => runSync(effect, [])).toThrow('kaboom')
  })

  test('catchAll does not swallow a defect', () => {
    let handled = false
    const effect = catchAll(() => {
      handled = true
      return ok('recovered')
    })(
      sync(() => {
        throw new Error('bug')
      })
    )
    expect(failure(runSyncExit(effect, []))._tag).toBe('Die')
    expect(handled).toBe(false)
  })

  test('a throw inside a generator body becomes a defect', () => {
    const effect = gen(function* () {
      yield* ok(1)
      throw new Error('bug')
    })
    expect(failure(runSyncExit(effect, []))._tag).toBe('Die')
  })
})

describe('runSync and asynchrony', () => {
  test('reaching an async operation is a defect naming the escape route', () => {
    const effect = new Async<number, never>((resume) => {
      resume(ok(1))
      return undefined
    })
    const exit = runSyncExit(effect as Fx<number, never, never>, [])
    const cause = failure(exit)
    expect(cause._tag).toBe('Die')
    expect((cause as { defect: unknown }).defect).toBeInstanceOf(AsyncBoundary)
    expect(() => runSync(effect as Fx<number, never, never>, [])).toThrow(
      'Use run() instead'
    )
  })
})

describe('the trampoline', () => {
  test('a hundred thousand sequential yields do not grow the JS stack', () => {
    const sum = fx(function* (n: number) {
      let total = 0
      for (let i = 0; i < n; i++) {
        total += yield* ok(i)
      }
      return total
    })
    expect(value(runSync(sum(100_000), []))).toBe(4999950000)
  })

  test('nesting deeper than the native stack does not overflow', () => {
    // Measured native recursion limit on this runtime is ~45,600 frames, so
    // 60,000 is genuinely beyond what a recursive interpreter could do. Each
    // level costs one entry in the fiber's array instead.
    //
    // Cost is also linear in depth, measured across 10k-80k. Were native
    // yield* delegation being re-walked per step it would be quadratic; it is
    // not, because every Fx hands out a single-shot iterator, so the
    // interpreter holds the chain rather than the engine.
    const countdown = (n: number): Fx<number> =>
      gen(function* () {
        if (n === 0) {
          return 0
        }
        return 1 + (yield* countdown(n - 1))
      })
    expect(value(runSync(countdown(60_000), []))).toBe(60_000)
  })

  test('a flatMap chain longer than the native stack does not overflow', () => {
    let effect: Fx<number> = ok(0)
    for (let i = 0; i < 100_000; i++) {
      effect = flatMap((n: number) => ok(n + 1))(effect)
    }
    expect(value(runSync(effect, []))).toBe(100_000)
  })
})

// ===========================================================================
// The three-service example, end to end
// ===========================================================================

interface CfgSvc {
  readonly url: string
  readonly level: 'info' | 'silent'
}
interface LogSvc {
  info(message: string): Fx<void>
}
interface DbSvc {
  query(id: string): Fx<{ readonly id: string; readonly name: string }, DbError>
}

const Config = service<CfgSvc>()('Config')
const Logger = service<LogSvc>()('Logger')
const Db = service<DbSvc>()('Db')

describe('three services, one depending on two', () => {
  const logged: string[] = []
  const rows = new Map([['1', 'Ada']])

  const ConfigLive = Config.of({ url: 'postgres://', level: 'info' as const })

  const LoggerLive = Logger.make(function* () {
    const cfg = yield* Config
    return {
      info: (message: string) =>
        sync(() => {
          if (cfg.level === 'info') {
            logged.push(message)
          }
        }),
    }
  })

  const DbLive = Db.make(function* () {
    const cfg = yield* Config
    const log = yield* Logger
    yield* log.info(`connected to ${cfg.url}`)
    return {
      query: (id: string) => {
        const name = rows.get(id)
        return name === undefined ? err(new DbError(id)) : ok({ id, name })
      },
    }
  })

  const getUser = fx(function* (id: string) {
    const db = yield* Db
    const log = yield* Logger
    yield* log.info(`load ${id}`)
    return yield* db.query(id)
  })

  test('resolves a user, with providers in arbitrary order', () => {
    logged.length = 0
    const result = runSync(getUser('1'), [DbLive, ConfigLive, LoggerLive])
    expect(value(result)).toEqual({ id: '1', name: 'Ada' })
    expect(logged).toEqual(['connected to postgres://', 'load 1'])
  })

  test('order of the provider list is irrelevant', () => {
    for (const providers of [
      [ConfigLive, LoggerLive, DbLive],
      [LoggerLive, DbLive, ConfigLive],
      [DbLive, LoggerLive, ConfigLive],
    ] as const) {
      expect(value(runSync(getUser('1'), providers))).toEqual({ id: '1', name: 'Ada' })
    }
  })

  test("a service's own failure reaches the caller typed", () => {
    expect(failure(runSync(getUser('missing'), [DbLive, ConfigLive, LoggerLive])).id).toBe(
      'missing'
    )
  })

  test('a provider is built exactly once even when two services need it', () => {
    let configBuilds = 0
    const CountedConfig = Config.make(function* () {
      configBuilds += 1
      return { url: 'x', level: 'silent' as const }
    })
    runSync(getUser('1'), [DbLive, CountedConfig, LoggerLive])
    expect(configBuilds).toBe(1)
  })

  test('a failing provider surfaces its error in the channel', () => {
    const BrokenConfig = Config.make(function* () {
      return yield* err(new DbError('config'))
    })
    const result = runSync(getUser('1'), [DbLive, BrokenConfig, LoggerLive])
    expect(failure(result).id).toBe('config')
  })

  test('services can be overridden for a test without touching the graph', () => {
    const stub = Db.of({
      query: () => ok({ id: 'stub', name: 'Stub' }),
    })
    expect(value(runSync(getUser('1'), [stub, ConfigLive, LoggerLive]))).toEqual({
      id: 'stub',
      name: 'Stub',
    })
  })
})

describe('the synchronous path allocates no cancellation machinery', () => {
  // A one-service run used to cost ~400ns, a quarter of it the fiber's eager
  // AbortController. Timing would flake in CI, so pin the structure instead:
  // a run that never parks, forks or is interrupted constructs no controller.
  // `bun run bench` has the numbers.
  const counting = <Value>(body: () => Value): { value: Value; constructed: number } => {
    const Original = globalThis.AbortController
    let constructed = 0
    globalThis.AbortController = class extends Original {
      constructor() {
        super()
        constructed += 1
      }
    }
    try {
      return { value: body(), constructed }
    } finally {
      globalThis.AbortController = Original
    }
  }

  interface Codec {
    len(text: string): number
  }
  const Codec = service<Codec>()('Codec')
  const measure = fx(function* (text: string) {
    return (yield* Codec).len(text)
  })

  test('a service lookup and a nested fx construct no AbortController', () => {
    const map = services([Codec, { len: (text: string) => text.length }])
    const outer = gen(function* () {
      return (yield* measure('hello')) + (yield* measure('hi'))
    })
    const { value, constructed } = counting(() => interpretSync(outer, map))
    expect(value).toEqual(ok(7))
    expect(constructed).toBe(0)
  })

  test('the signal is still there for whoever asks for it', async () => {
    const seen = await runExit(
      new Async<boolean, never>((resume, signal) => {
        resume(ok(signal instanceof AbortSignal && !signal.aborted))
        return undefined
      }),
      []
    )
    expect(seen).toEqual(ok(true))
  })
})

describe('a run nested inside user code', () => {
  // The drive loop hands payloads around through one module-level register.
  // A nested run writes it too, so the outer run must not read it back late.
  test('keeps its own value', () => {
    const outer = gen(function* () {
      const first = yield* sync(() => {
        runSync(sync(() => 'inner'), [])
        return 'outer'
      })
      return [first, runSync(sync(() => 'inner'), [])]
    })
    expect(runSyncExit(outer, [])).toEqual(ok(['outer', ok('inner')]))
  })

  test('keeps its own failure', () => {
    const boom = new Error('boom')
    const outer = sync((): string => {
      runSyncExit(sync(() => 'nested'), [])
      throw boom
    })
    const exit = runSyncExit(outer, [])
    expect(exit.ok).toBe(false)
    expect(exit.ok ? undefined : (exit.error as { defect?: unknown }).defect).toBe(boom)
  })
})
