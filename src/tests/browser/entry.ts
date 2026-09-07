/**
 * Browser smoke-test entry point.
 *
 * The three-service example, verbatim, bundled with `--target=browser` and
 * executed with every Node global shadowed. If e2 reached for `process`,
 * `Buffer`, `require` or `node:*` anywhere, this would not run.
 */
import { acquire, fromPromise, sleep } from '../../ops.ts'
import { err, ok } from '../../result.ts'
import { run, runtime } from '../../run.ts'
import { sync, type Fx } from '../../fx.ts'
import { fx } from '../../gen.ts'
import { service } from '../../service.ts'
import { race, retry, Schedule } from '../../ops.ts'

class Boom {
  readonly _tag = 'Boom' as const
  constructor(readonly id: string) {}
}

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

const logged: string[] = []
const released: string[] = []

const ConfigLive = Config.make(function* () {
  yield* sleep(1)
  return yield* fromPromise(async () => ({ url: 'https://example.test' }))
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
    () => void released.push('pool')
  )
  yield* log.info(`connected to ${pool.url}`)
  return {
    query: (id: string) => (id === '1' ? ok({ id, name: 'Ada' }) : err(new Boom(id))),
  }
})

const getUser = fx(function* (id: string) {
  const db = yield* Db
  const log = yield* Logger
  yield* log.info(`load ${id}`)
  return yield* db.query(id)
})

async function main(): Promise<Record<string, unknown>> {
  const providers = [DbLive, ConfigLive, LoggerLive] as const

  const found = await run(getUser('1'), providers)
  const missing = await run(getUser('nope'), providers)

  // Timers, AbortSignal and structured concurrency, in a browser.
  const raced = await run(
    race(
      fx(function* () {
        yield* sleep(5)
        return 'fast'
      })(),
      fx(function* () {
        yield* sleep(200)
        return 'slow'
      })()
    ),
    providers
  )

  // Retry with a real delay.
  let attempts = 0
  const flaky = fx(function* () {
    attempts += 1
    if (attempts < 3) {
      return yield* err(new Boom('flaky'))
    }
    return attempts
  })
  const retried = await run(retry(Schedule.spaced(2).upTo(5))(flaky()), providers)

  // A long-lived runtime, torn down explicitly.
  const rt = await runtime(providers)
  const viaRuntime = await rt.run(getUser('1'))
  await rt.close()

  return {
    found: found.ok ? found.value : null,
    missingIsErr: !missing.ok,
    missingId: missing.ok ? null : (missing.error as Boom).id,
    raced: raced.ok ? raced.value : null,
    retried: retried.ok ? retried.value : null,
    viaRuntime: viaRuntime.ok ? viaRuntime.value : null,
    logged: [...logged],
    released: [...released],
  }
}

;(globalThis as Record<string, unknown>).__e2_browser_result = main()
