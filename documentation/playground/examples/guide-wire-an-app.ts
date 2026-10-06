// Wire an application: services that use services, built once.
import { acquire, fx, gen, runtime, service, sync, type Fx } from 'e2'

interface Note {
  readonly id: number
  readonly text: string
  readonly createdAt: Date
}

// #region contracts
interface Config {
  readonly appName: string
}
const Config = service<Config>()('Config')

interface Clock {
  readonly now: Fx<Date>
}
const Clock = service<Clock>()('Clock')

interface Logger {
  info(message: string): Fx<void>
}
const Logger = service<Logger>()('Logger')

interface Notes {
  add(text: string): Fx<Note>
  list(): Fx<readonly Note[]>
}
const Notes = service<Notes>()('Notes')
// #endregion

// #region leaves
// A value you already have: `of`.
const ConfigLive = Config.of({ appName: 'notes' })
const ClockLive = Clock.of({ now: sync(() => new Date()) })

// Something that needs other services: `make`, and yield them.
const LoggerLive = Logger.make(function* () {
  const config = yield* Config
  return {
    info: (message) => sync(() => console.log(`[${config.appName}] ${message}`)),
  }
})
// Provider<'Logger', 'Config', never>
// #endregion

// #region notes
const NotesLive = Notes.make(function* () {
  const clock = yield* Clock
  const log = yield* Logger

  // Opened while the app starts, closed when it stops.
  const storage = yield* acquire(
    () => {
      console.log('storage: opened')
      return new Map<number, Note>()
    },
    () => console.log('storage: closed')
  )

  return {
    add: (text) =>
      gen(function* () {
        const note = { id: storage.size + 1, text, createdAt: yield* clock.now }
        storage.set(note.id, note)
        yield* log.info(`added note ${note.id}`)
        return note
      }),
    list: () => sync(() => [...storage.values()]),
  }
})
// Provider<'Notes', 'Clock' | 'Logger', never>
// #endregion

const remember = fx(function* (text: string) {
  const notes = yield* Notes
  yield* notes.add(text)
  return yield* notes.list()
})

// #region runtime
// One list, any order. Each service is built once, when first needed.
const app = await runtime([NotesLive, LoggerLive, ClockLive, ConfigLive])

await app.run(remember('buy milk'))
const all = await app.run(remember('call mum'))
console.log(all.ok && all.value.map((note) => note.text)) // ["buy milk", "call mum"]

await app.close() // storage: closed
// #endregion
