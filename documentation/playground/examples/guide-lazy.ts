// Open expensive things lazily: once, on first use, shared.
import { acquire, allConcurrent, fx, gen, lazy, memo, runtime, service, type Fx } from 'e2'

const started = performance.now()
const log = (...parts: unknown[]) =>
  console.log(`${String(Math.round(performance.now() - started)).padStart(5)}ms `, ...parts)

interface Note {
  readonly id: number
  readonly text: string
}

interface Notes {
  list(): Fx<readonly Note[]>
}
const Notes = service<Notes>()('Notes')

// Pretend this is IndexedDB: slow to open, and not always needed.
const openDatabase = async (): Promise<Map<number, Note>> => {
  log('database: opening…')
  await new Promise((resolve) => setTimeout(resolve, 300))
  log('database: open')
  return new Map([[1, { id: 1, text: 'buy milk' }]])
}

// #region memo
const NotesLive = Notes.make(function* () {
  // Not opened here. `db` is a handle: the first read opens the database,
  // reads that arrive meanwhile wait for that same open, later reads reuse it.
  const db = yield* memo(acquire(openDatabase, () => log('database: closed')))
  return {
    list: () =>
      gen(function* () {
        const rows = yield* db
        return [...rows.values()]
      }),
  }
})
// #endregion

// #region lazy
interface Export {
  toMarkdown(): Fx<string>
}
const Export = service<Export>()('Export')

const ExportLive = Export.make(function* () {
  log('export: built, because someone used it')
  const notes = yield* Notes
  return {
    toMarkdown: () =>
      gen(function* () {
        const all = yield* notes.list()
        return all.map((note) => `- ${note.text}`).join('\n')
      }),
  }
})

// lazy(): not built at startup at all.
const app = await runtime([NotesLive, lazy(ExportLive)])
log('app: started, database untouched')
// #endregion

// #region use
const list = fx(function* () {
  const notes = yield* Notes
  return yield* notes.list()
})

await app.run(allConcurrent([list(), list(), list()])) // one open, three readers
log('app: three reads done')

const markdown = await app.run(
  gen(function* () {
    const exporter = yield* Export
    return yield* exporter.toMarkdown()
  })
)
log('app: export', markdown)
await app.close()
// #endregion

