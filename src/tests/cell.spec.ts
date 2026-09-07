import { describe, expect, test } from 'bun:test'
import {
  AsyncBoundary,
  CyclicDependency,
  DuplicateProvider,
  MissingProvider,
  ProviderFailed,
  acquire,
  catchAll,
  err,
  fork,
  gen,
  interruptFiber,
  join,
  lazy,
  memo,
  ok,
  run,
  runExit,
  runSync,
  runtime,
  scoped,
  service,
  sleep,
  sync,
  type Fx,
  type NeedsOf,
  type Result,
} from '../index.ts'
import { assertType, type Equals } from '../types.ts'

/**
 * Demand-driven construction and `memo` share one cell. These tests pin the
 * behaviour the design note promises for both: built on first demand, never
 * twice, concurrent demands join, failure resets, the scope is the one the
 * cell was created in, and a waiting demander can be interrupted without
 * cancelling the shared run.
 */

class Boom {
  readonly _tag = 'Boom' as const
  constructor(readonly why: string) {}
}

interface Config {
  readonly url: string
}
const Config = service<Config>()('Config')

interface Logger {
  info(message: string): Fx<void>
}
const Logger = service<Logger>()('Logger')

interface Db {
  query(id: string): Fx<string>
}
const Db = service<Db>()('Db')

const value = <Value, Error>(result: Result<Value, Error>): Value => {
  if (!result.ok) throw new Error(`expected Ok, received Err(${JSON.stringify(result.error)})`)
  return result.value
}

const useDb = gen(function* () {
  const db = yield* Db
  return yield* db.query('1')
})

describe('demand-driven construction', () => {
  test('builds a provider on first demand, exactly once, in dependency order', async () => {
    const built: string[] = []
    const ConfigLive = Config.make(function* () {
      built.push('config')
      return { url: 'x' }
    })
    const LoggerLive = Logger.make(function* () {
      yield* Config
      built.push('logger')
      return { info: () => sync(() => {}) }
    })
    const DbLive = Db.make(function* () {
      const config = yield* Config
      yield* Logger
      built.push('db')
      return { query: (id) => ok(config.url + '/' + id) }
    })

    // Db first in the list: its body demands Config and Logger before it can
    // finish, so the observed order is dependency order without a sort.
    const rt = await runtime([DbLive, ConfigLive, LoggerLive])
    expect(built).toEqual(['config', 'logger', 'db'])
    expect(value(await rt.run(useDb))).toBe('x/1')
    expect(built).toHaveLength(3)

    const graph = rt.graph()
    expect(graph['Db']).toEqual({ status: 'done', lazy: false, demanded: ['Config', 'Logger'] })
    expect(graph['Logger']).toEqual({ status: 'done', lazy: false, demanded: ['Config'] })
    expect(graph['Config']).toEqual({ status: 'done', lazy: false, demanded: [] })
    await rt.close()
  })

  test('a lazy provider is skipped by the warm-up and built by its first user', async () => {
    let builds = 0
    const DbLive = Db.make(function* () {
      builds += 1
      return { query: (id) => ok(id) }
    })

    const rt = await runtime([lazy(DbLive)])
    expect(builds).toBe(0)
    expect(rt.graph()['Db']).toEqual({ status: 'empty', lazy: true, demanded: [] })

    expect(value(await rt.run(useDb))).toBe('1')
    expect(value(await rt.run(useDb))).toBe('1')
    expect(builds).toBe(1)
    expect(rt.graph()['Db']?.status).toBe('done')
    await rt.close()
  })

  test('concurrent demands join one construction', async () => {
    let builds = 0
    const DbLive = Db.make(function* () {
      builds += 1
      yield* sleep(5)
      return { query: (id) => ok(id) }
    })

    const both = gen(function* () {
      const first = yield* fork(useDb)
      const second = yield* fork(useDb)
      return [yield* join<string, never>(first), yield* join<string, never>(second)]
    })

    expect(value(await run(both, [lazy(DbLive)]))).toEqual(['1', '1'])
    expect(builds).toBe(1)
  })

  test('a construction cycle is a defect naming the loop', async () => {
    const A = service<{ readonly a: true }>()('A')
    const B = service<{ readonly b: true }>()('B')
    const ALive = A.make(function* () {
      yield* B
      return { a: true }
    })
    const BLive = B.make(function* () {
      yield* A
      return { b: true }
    })

    await expect(runtime([ALive, BLive])).rejects.toMatchObject({
      _tag: 'CyclicDependency',
      cycle: ['A', 'B', 'A'],
    })
    expect(() =>
      runSync(
        gen(function* () {
          return yield* A
        }),
        [ALive, BLive]
      )
    ).toThrow(CyclicDependency)
  })

  test('a lazy provider that fails reaches its first user as a defect, then retries', async () => {
    let attempts = 0
    const DbLive = Db.make(function* () {
      attempts += 1
      if (attempts === 1) {
        return yield* err(new Boom('first time'))
      }
      return { query: (id) => ok(id) }
    })

    const rt = await runtime([lazy(DbLive)])
    const first = await rt.runExit(useDb)
    expect(first.ok).toBe(false)
    if (!first.ok) {
      expect(first.error._tag).toBe('Die')
      const defect = (first.error as { defect: unknown }).defect
      expect(defect).toBeInstanceOf(ProviderFailed)
      expect((defect as ProviderFailed).service).toBe('Db')
      expect((defect as ProviderFailed).error).toMatchObject({ why: 'first time' })
    }
    // The cell reset, so the next demand tries again.
    expect(value(await rt.run(useDb))).toBe('1')
    expect(attempts).toBe(2)
    await rt.close()
  })

  test('an eager provider that fails keeps its typed failure', async () => {
    const DbLive = Db.make(function* () {
      return yield* err(new Boom('config'))
    })
    const result = await run(useDb, [DbLive])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.why).toBe('config')
  })

  test('two providers for one name is a defect, not two instances', async () => {
    const a = Config.of({ url: 'a' })
    const b = Config.of({ url: 'b' })
    await expect(runtime([a, b])).rejects.toBeInstanceOf(DuplicateProvider)
  })

  test('a service nothing supplies is a MissingProvider defect at runtime', async () => {
    // Only reachable by defeating the types: the list is checked statically.
    const exit = await runExit(useDb as never, [])
    expect(exit.ok).toBe(false)
    if (!exit.ok) {
      expect(exit.error._tag).toBe('Die')
      expect((exit.error as { defect: unknown }).defect).toBeInstanceOf(MissingProvider)
    }
  })

  test('teardown releases in reverse acquisition order, lazy providers included', async () => {
    const released: string[] = []
    const ConfigLive = Config.make(function* () {
      yield* acquire(
        () => 'cfg',
        () => void released.push('config')
      )
      return { url: 'x' }
    })
    const DbLive = Db.make(function* () {
      yield* Config
      yield* acquire(
        () => 'pool',
        () => void released.push('db')
      )
      return { query: (id) => ok(id) }
    })

    const rt = await runtime([ConfigLive, lazy(DbLive)])
    expect(released).toEqual([])
    await rt.run(useDb)
    await rt.close()
    expect(released).toEqual(['db', 'config'])
  })

  test('runSync builds synchronous providers without touching an async instruction', () => {
    const ConfigLive = Config.of({ url: 'x' })
    const DbLive = Db.make(function* () {
      const config = yield* Config
      return { query: (id) => ok(config.url + id) }
    })
    expect(value(runSync(useDb, [DbLive, ConfigLive]))).toBe('x1')
  })

  test('a provider that parks under runSync is an AsyncBoundary defect', () => {
    const DbLive = Db.make(function* () {
      yield* sleep(1)
      return { query: (id) => ok(id) }
    })
    expect(() => runSync(useDb, [DbLive])).toThrow(AsyncBoundary)
  })

  test('a defaulted service goes in as itself and is overridden with .of', async () => {
    const Clock = service('Clock', function* () {
      return { now: () => sync(() => 1) }
    })
    const readClock = gen(function* () {
      const clock = yield* Clock
      return yield* clock.now()
    })
    expect(value(await run(readClock, [Clock]))).toBe(1)
    expect(value(await run(readClock, [Clock.of({ now: () => sync(() => 2) })]))).toBe(2)
  })

  test('a demander interrupted while waiting does not cancel the construction', async () => {
    let builds = 0
    let finished = false
    const DbLive = Db.make(function* () {
      builds += 1
      yield* sleep(10)
      finished = true
      return { query: (id) => ok(id) }
    })

    const program = gen(function* () {
      const waiting = yield* fork(useDb)
      yield* sleep(1)
      yield* interruptFiber(waiting)
      // The build started by the interrupted fiber is still in flight; this
      // demand joins it rather than starting a second one.
      return yield* useDb
    })

    expect(value(await run(program, [lazy(DbLive)]))).toBe('1')
    expect(builds).toBe(1)
    expect(finished).toBe(true)
  })
})

describe('memo', () => {
  test('runs once and shares the value', async () => {
    let runs = 0
    const program = gen(function* () {
      const handle = yield* memo(sync(() => ++runs))
      const first = yield* handle
      const second = yield* handle
      return [first, second]
    })
    expect(value(await run(program, []))).toEqual([1, 1])
    expect(runs).toBe(1)
  })

  test('concurrent demands join one run', async () => {
    let runs = 0
    const program = gen(function* () {
      const handle = yield* memo(
        gen(function* () {
          runs += 1
          yield* sleep(5)
          return 'ready'
        })
      )
      const a = yield* fork(handle)
      const b = yield* fork(handle)
      return [yield* join<string, never>(a), yield* join<string, never>(b)]
    })
    expect(value(await run(program, []))).toEqual(['ready', 'ready'])
    expect(runs).toBe(1)
  })

  test('failure is not cached', async () => {
    let attempts = 0
    const program = gen(function* () {
      const handle = yield* memo(
        gen(function* () {
          attempts += 1
          if (attempts === 1) return yield* err(new Boom('cold'))
          return 'warm'
        })
      )
      const first = yield* catchAll((boom: Boom) => ok('recovered from ' + boom.why))(handle)
      const second = yield* handle
      return [first, second]
    })
    expect(value(await run(program, []))).toEqual(['recovered from cold', 'warm'])
    expect(attempts).toBe(2)
  })

  test('eager starts the run at creation, without waiting for a demand', async () => {
    let started = false
    const program = gen(function* () {
      yield* memo(
        sync(() => {
          started = true
          return 1
        }),
        { eager: true }
      )
      return started
    })
    expect(value(await run(program, []))).toBe(true)
  })

  test('captures the scope it was created in, not the scope of the first use', async () => {
    const released: string[] = []
    interface Store {
      use(): Fx<string>
    }
    const Store = service<Store>()('Store')
    const StoreLive = Store.make(function* () {
      const resource = yield* memo(
        acquire(
          () => 'handle',
          () => void released.push('handle')
        )
      )
      return {
        use: () =>
          gen(function* () {
            return yield* resource
          }),
      }
    })

    const rt = await runtime([StoreLive])
    // The first use happens inside a scoped request. Had the acquire
    // registered there, `scoped` would release it when the request ends.
    const inRequest = scoped(
      gen(function* () {
        const store = yield* Store
        return yield* store.use()
      })
    )
    expect(value(await rt.run(inRequest))).toBe('handle')
    expect(released).toEqual([])
    await rt.close()
    expect(released).toEqual(['handle'])
  })

  test('over a service key, defers the lookup to the point of use', async () => {
    let storeBuilds = 0
    interface Store {
      ingest(id: string): Fx<string>
    }
    const Store = service<Store>()('Store')
    const StoreLive = Store.make(function* () {
      storeBuilds += 1
      return { ingest: (id) => ok('stored ' + id) }
    })

    interface Sender {
      send(id: string): Fx<string>
    }
    const Sender = service<Sender>()('Sender')
    const SenderLive = Sender.make(function* () {
      const lazyStore = yield* memo(Store)
      return {
        send: (id) =>
          gen(function* () {
            const store = yield* lazyStore
            return yield* store.ingest(id)
          }),
      }
    })
    // 'Store' is a requirement of the Sender provider even though it is
    // resolved later: the list is still checked as a whole.
    assertType<Equals<NeedsOf<typeof SenderLive>, 'Store'>>()

    const rt = await runtime([SenderLive, lazy(StoreLive)])
    expect(storeBuilds).toBe(0)
    const sent = await rt.run(
      gen(function* () {
        return yield* (yield* Sender).send('1')
      })
    )
    expect(value(sent)).toBe('stored 1')
    expect(storeBuilds).toBe(1)
    await rt.close()
  })
})
