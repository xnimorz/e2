import { describe, expect, test } from 'bun:test'
import {
  acquire,
  allConcurrent,
  attemptFx,
  batch,
  err,
  gen,
  run,
  runExit,
  runSync,
  runtime,
  service,
  sleep,
  sync,
  type Fx,
  type Result,
} from '../index.ts'

class Boom {
  readonly _tag = 'Boom' as const
  constructor(readonly why: string) {}
}

const value = <Value, Error>(result: Result<Value, Error>): Value => {
  if (!result.ok) throw new Error(`expected Ok, received Err(${JSON.stringify(result.error)})`)
  return result.value
}

describe('batch', () => {
  test('add coalesces concurrent calls into one run and routes each result back', async () => {
    const runs: number[][] = []
    const program = gen(function* () {
      const double = yield* batch((items: readonly number[]) =>
        sync(() => {
          runs.push([...items])
          return items.map((n) => n * 2)
        })
      )
      return yield* allConcurrent([double.add(1), double.add(2), double.add(3)])
    })
    expect(value(await run(program, []))).toEqual([2, 4, 6])
    expect(runs).toEqual([[1, 2, 3]])
  })

  test('sequential adds each wait for their own run', async () => {
    const runs: number[][] = []
    const program = gen(function* () {
      const double = yield* batch((items: readonly number[]) =>
        sync(() => {
          runs.push([...items])
          return items.map((n) => n * 2)
        })
      )
      const first = yield* double.add(1)
      const second = yield* double.add(2)
      return [first, second]
    })
    expect(value(await run(program, []))).toEqual([2, 4])
    expect(runs).toEqual([[1], [2]])
  })

  test('enqueue returns at once; flush writes what is pending in one run', async () => {
    const runs: string[][] = []
    const program = gen(function* () {
      const writer = yield* batch((items: readonly string[]) =>
        sync(() => {
          runs.push([...items])
          return items
        })
      )
      for (const item of ['a', 'b', 'c']) yield* writer.enqueue(item)
      const pendingBefore = yield* writer.pending
      yield* writer.flush
      return { pendingBefore, pendingAfter: yield* writer.pending }
    })
    expect(value(await run(program, []))).toEqual({ pendingBefore: 3, pendingAfter: 0 })
    expect(runs).toEqual([['a', 'b', 'c']])
  })

  test('a synchronous burst of enqueues is one run when the window elapses', async () => {
    const runs: number[][] = []
    const program = gen(function* () {
      const writer = yield* batch((items: readonly number[]) =>
        sync(() => {
          runs.push([...items])
          return items
        })
      )
      for (let i = 0; i < 100; i++) yield* writer.enqueue(i)
      yield* sleep(5) // the 0 ms window fires on the next turn of the event loop
      return yield* writer.pending
    })
    expect(value(await run(program, []))).toBe(0)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toHaveLength(100)
  })

  test('maxSize closes a batch early', async () => {
    const runs: number[][] = []
    const program = gen(function* () {
      const writer = yield* batch(
        (items: readonly number[]) =>
          sync(() => {
            runs.push([...items])
            return items
          }),
        { maxSize: 4 }
      )
      for (let i = 0; i < 10; i++) yield* writer.enqueue(i)
      yield* writer.flush
    })
    await run(program, [])
    expect(runs.map((r) => r.length)).toEqual([4, 4, 2])
  })

  test('a failing run reaches every waiter; the next batch is independent', async () => {
    let attempts = 0
    const program = gen(function* () {
      const flaky = yield* batch((items: readonly number[]) =>
        gen(function* () {
          attempts += 1
          if (attempts === 1) return yield* err(new Boom('cold'))
          return items
        })
      )
      const first = yield* attemptFx(allConcurrent([flaky.add(1), flaky.add(2)]))
      const second = yield* flaky.add(3)
      return { first, second }
    })
    const outcome = value(await run(program, []))
    expect(outcome.first.ok).toBe(false)
    if (!outcome.first.ok) expect(outcome.first.error.why).toBe('cold')
    expect(outcome.second).toBe(3)
    expect(attempts).toBe(2)
  })

  test('a run that returns the wrong number of results is a defect', async () => {
    const program = gen(function* () {
      const broken = yield* batch((items: readonly number[]) => sync(() => items.slice(1)))
      return yield* broken.add(1)
    })
    const exit = await runExit(program, [])
    expect(exit.ok).toBe(false)
    if (!exit.ok) expect(exit.error._tag).toBe('Die')
  })

  test('whatever is pending is flushed when the owning scope closes', async () => {
    const runs: string[][] = []
    interface Log {
      readonly write: (line: string) => Fx<void>
    }
    const Log = service<Log>()('Log')
    const LogLive = Log.make(function* () {
      const writer = yield* batch((lines: readonly string[]) =>
        sync(() => {
          runs.push([...lines])
          return lines
        })
      )
      return { write: (line) => writer.enqueue(line) }
    })

    const rt = await runtime([LogLive])
    await rt.run(
      gen(function* () {
        const log = yield* Log
        yield* log.write('one')
        yield* log.write('two')
      })
    )
    // Not yet: the window has not elapsed and nobody flushed.
    expect(runs).toEqual([])
    await rt.close()
    expect(runs).toEqual([['one', 'two']])
  })

  test('the run happens against the scope the batcher was created in', async () => {
    const released: string[] = []
    interface Store {
      readonly save: (row: string) => Fx<void>
      readonly flush: Fx<void>
    }
    const Store = service<Store>()('Store')
    const StoreLive = Store.make(function* () {
      const writer = yield* batch((rows: readonly string[]) =>
        gen(function* () {
          // A resource acquired inside a run belongs to the runtime, not to
          // the request that happened to trigger the flush.
          yield* acquire(
            () => 'tx',
            () => void released.push('tx')
          )
          return rows
        })
      )
      return { save: (row) => writer.enqueue(row), flush: writer.flush }
    })

    const rt = await runtime([StoreLive])
    await rt.run(
      gen(function* () {
        const store = yield* Store
        yield* store.save('a')
        yield* store.flush
      })
    )
    expect(released).toEqual([])
    await rt.close()
    expect(released).toEqual(['tx'])
  })

  test('enqueue and flush work under runSync when the run is synchronous', () => {
    const runs: number[][] = []
    const program = gen(function* () {
      const writer = yield* batch((items: readonly number[]) =>
        sync(() => {
          runs.push([...items])
          return items
        })
      )
      yield* writer.enqueue(1)
      yield* writer.enqueue(2)
      yield* writer.flush
      return yield* writer.pending
    })
    expect(value(runSync(program, []))).toBe(0)
    expect(runs).toEqual([[1, 2]])
  })
})
