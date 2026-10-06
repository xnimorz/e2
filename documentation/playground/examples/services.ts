// Services: a contract, a key, an implementation, a run.
//
// Hover `getUser` to see the signature nobody wrote. Then delete `LoggerLive`
// from the list at the bottom: the call stops compiling, and the error names
// the missing service.
import { TaggedError, err, fx, ok, run, runtime, service, sync, type Fx } from 'e2'

interface User {
  readonly id: string
  readonly name: string
}

class NotFound extends TaggedError<'NotFound'> {
  readonly _tag = 'NotFound' as const
  constructor(readonly id: string) {
    super(`no user ${id}`)
  }
}

// A contract and its key share a name: type Db is the contract, value Db the key.
interface Config {
  readonly prefix: string
}
const Config = service<Config>()('Config')

interface Logger {
  info(message: string): Fx<void>
}
const Logger = service<Logger>()('Logger')

interface Db {
  query(id: string): Fx<User, NotFound>
}
const Db = service<Db>()('Db')

// Implementations. A body's dependencies are whatever it yields.
const ConfigLive = Config.of({ prefix: 'app' })

const LoggerLive = Logger.make(function* () {
  const config = yield* Config
  return {
    info: (message: string) => sync(() => console.log(`[${config.prefix}] ${message}`)),
  }
})
// Provider<'Logger', 'Config', never>

const DbLive = Db.make(function* () {
  const log = yield* Logger
  yield* log.info('db: connected')
  const rows = new Map([['1', { id: '1', name: 'Ada' }]])
  return {
    query: (id: string) => {
      const row = rows.get(id)
      return row === undefined ? err(new NotFound(id)) : ok(row)
    },
  }
})
// Provider<'Db', 'Logger', never>

// A program. Its requirements are inferred from what it yields.
const getUser = fx(function* (id: string) {
  const db = yield* Db
  const log = yield* Logger
  yield* log.info(`load ${id}`)
  return yield* db.query(id)
})
// (id: string) => Fx<User, NotFound, 'Db' | 'Logger'>

// `run` builds the list, runs the program, and tears the list down. Order is irrelevant.
const result = await run(getUser('1'), [DbLive, LoggerLive, ConfigLive])
console.log(result.ok ? `found ${result.value.name}` : result.error.message)

// A long-lived process builds the graph once and keeps it.
const rt = await runtime([DbLive, LoggerLive, ConfigLive])
for (const id of ['1', '2']) {
  const found = await rt.run(getUser(id))
  console.log(id, '→', found.ok ? found.value : `${found.error._tag}: ${found.error.message}`)
}
await rt.close()
