// Lazy initialisation: memo opens a resource once, on first use;
// lazy() keeps a whole provider out of the startup warm-up.
import { acquire, allConcurrent, gen, lazy, memo, runtime, service, sync, type Fx } from 'e2'

const start = performance.now()
const log = (...parts: unknown[]) =>
  console.log(`${String(Math.round(performance.now() - start)).padStart(5)}ms `, ...parts)

interface Store {
  get(key: string): Fx<string | undefined>
}
const Store = service<Store>()('Store')

const StoreLive = Store.make(function* () {
  log('Store: constructed, nothing opened')
  // Not opened here. Opened by the first read, closed with the runtime.
  const db = yield* memo(
    acquire(
      async () => {
        log('db: opening…')
        await new Promise((resolve) => setTimeout(resolve, 300))
        log('db: open')
        return new Map([['greeting', 'hello']])
      },
      () => log('db: closed')
    )
  )
  return {
    get: (key: string) =>
      gen(function* () {
        const rows = yield* db // empty → opens · opening → joins · open → returns
        return rows.get(key)
      }),
  }
})

interface Reports {
  build(): Fx<string>
}
const Reports = service<Reports>()('Reports')

const ReportsLive = Reports.make(function* () {
  log('Reports: constructed, on first use')
  return { build: () => sync(() => 'quarterly report') }
})

const rt = await runtime([StoreLive, lazy(ReportsLive)])
log('runtime ready')
console.log(rt.graph())

const read = gen(function* () {
  const store = yield* Store
  return yield* store.get('greeting')
})

const three = await rt.run(allConcurrent([read, read, read]))
log('three concurrent first reads, one open:', three)

await rt.run(read)
log('a later read: already open')

const report = await rt.run(
  gen(function* () {
    const reports = yield* Reports
    return yield* reports.build()
  })
)
log('report:', report)
console.log(rt.graph())

await rt.close()
log('runtime closed')
