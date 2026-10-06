// Test it: swap in doubles, keep the program.
import { fx, gen, ok, run, service, sync, type Fx } from 'e2'

interface Note {
  readonly id: number
  readonly text: string
  readonly createdAt: Date
}

interface Clock {
  readonly now: Fx<Date>
}
const Clock = service<Clock>()('Clock')

interface Notes {
  add(text: string): Fx<Note>
  list(): Fx<readonly Note[]>
}
const Notes = service<Notes>()('Notes')

const NotesInMemory = Notes.make(function* () {
  const clock = yield* Clock
  const notes: Note[] = []
  return {
    add: (text) =>
      gen(function* () {
        const note = { id: notes.length + 1, text, createdAt: yield* clock.now }
        notes.push(note)
        return note
      }),
    list: () => sync(() => [...notes]),
  }
})

// #region program
// The code under test. It knows nothing about tests.
const today = fx(function* () {
  const notes = yield* Notes
  const clock = yield* Clock
  const now = yield* clock.now
  const all = yield* notes.list()
  return all.filter((note) => note.createdAt.toDateString() === now.toDateString())
})
// today: () => Fx<Note[], never, 'Notes' | 'Clock'>
// #endregion

// #region doubles
// A double is just another provider for the same key.
const At = (iso: string) => Clock.of({ now: ok(new Date(iso)) })

const Seeded = (texts: readonly string[], createdAt: Date) =>
  Notes.of({
    add: () => ok({ id: 0, text: '', createdAt }),
    list: () => ok(texts.map((text, index) => ({ id: index + 1, text, createdAt }))),
  })
// #endregion

// #region tests
const check = (name: string, pass: boolean) => console.log(pass ? '✓' : '✗', name)

const morning = await run(today(), [Seeded(['buy milk'], new Date('2026-03-01T09:00')), At('2026-03-01T18:00')])
check('a note from this morning counts as today', morning.ok && morning.value.length === 1)

const yesterday = await run(today(), [Seeded(['buy milk'], new Date('2026-02-28T09:00')), At('2026-03-01T18:00')])
check('a note from yesterday does not', yesterday.ok && yesterday.value.length === 0)
// #endregion

// #region real
// The real implementation, with only the clock replaced.
const added = await run(
  gen(function* () {
    const notes = yield* Notes
    yield* notes.add('call mum')
    return yield* today()
  }),
  [NotesInMemory, At('2026-03-01T12:00')]
)
check('a note added now is today', added.ok && added.value.length === 1)
// #endregion
