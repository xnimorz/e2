// Every statement in this file is SUPPOSED to fail to typecheck. It is not
// part of the build - the root tsconfig excludes this directory - and is
// compiled only by src/tests/diagnostics.spec.ts, which pins the exact
// wording tsc produces.
//
// Keep the cases in this order; the spec matches on it.

import { fx, gen, run, runtime, service } from '../../index.ts'
import type { Fx } from '../../fx.ts'

class DbError {
  readonly _tag = 'DbError' as const
}

interface User {
  readonly id: string
}
interface DbSvc {
  query(id: string): Fx<User, DbError>
}
interface LogSvc {
  info(message: string): Fx<void>
}
interface CfgSvc {
  readonly url: string
}

const Db = service<DbSvc>()('Db')
const Logger = service<LogSvc>()('Logger')
const Config = service<CfgSvc>()('Config')

const ConfigLive = Config.of({ url: 'postgres://' })
const LoggerLive = Logger.make(function* () {
  yield* Config
  return { info: () => undefined as never }
})
const DbLive = Db.make(function* () {
  yield* Config
  yield* Logger
  return { query: () => undefined as never }
})

const getUser = fx(function* (id: string) {
  const db = yield* Db
  const log = yield* Logger
  yield* log.info(id)
  return yield* db.query(id)
})

// CASE 1 - one missing service.
run(getUser('1'), [DbLive, ConfigLive])

// CASE 2 - two missing dependencies.
run(getUser('1'), [DbLive])

// CASE 3 - a dependency the program never mentions, required only by a
// provider. Nothing in getUser refers to Config.
const DbNeedsConfig = Db.make(function* () {
  yield* Config
  return { query: () => undefined as never }
})
run(getUser('1'), [DbNeedsConfig, LoggerLive])

// CASE 4 - an implementation whose method reaches for a service the contract
// says it does not need. `query` is declared `Fx<User, DbError>`.
Db.make(function* () {
  return {
    query: (id: string) =>
      gen(function* () {
        const log = yield* Logger
        yield* log.info(id)
        return { id }
      }),
  }
})

// CASE 5 - returning an Fx without yield*. The guard poisons the value's
// type rather than erroring at the definition, so the diagnostic appears
// wherever the effect is actually used.
const forgotten = fx(function* (id: string) {
  const db = yield* Db
  return db.query(id)
})
run(forgotten('1'), [DbLive, ConfigLive, LoggerLive])

// CASE 6 - yield without the star.
fx(function* () {
  const db = yield Db
  return db
})

// CASE 7 - a runtime whose list is not closed: LoggerLive needs Config.
runtime([DbLive, LoggerLive]).then(() => undefined)
