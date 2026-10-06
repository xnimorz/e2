// Your first service: a contract, a key, an implementation, a run.
import { fx, run, service, sync, type Fx } from 'e2'

// #region contract
interface Note {
  readonly id: number
  readonly text: string
}

// What a notes store can do. Nothing about how.
interface Notes {
  add(text: string): Fx<Note>
  list(): Fx<readonly Note[]>
}

// The key the program asks for. Same name as the interface, on purpose.
const Notes = service<Notes>()('Notes')
// #endregion

// #region implementation
const NotesInMemory = Notes.make(function* () {
  const notes: Note[] = []
  return {
    add: (text) =>
      sync(() => {
        const note = { id: notes.length + 1, text }
        notes.push(note)
        return note
      }),
    list: () => sync(() => [...notes]),
  }
})
// #endregion

// #region program
const remember = fx(function* (text: string) {
  const notes = yield* Notes
  yield* notes.add(text)
  return yield* notes.list()
})
// remember: (text: string) => Fx<readonly Note[], never, 'Notes'>
// #endregion

// #region run
const result = await run(remember('buy milk'), [NotesInMemory])
console.log(result) // Ok([{ id: 1, text: "buy milk" }])
// #endregion

// Try it: change [NotesInMemory] to [] and look at the Problems panel.
