// Handle failure: expected errors in the type, bugs kept apart.
import { TaggedError, catchAll, err, fx, gen, ok, run, runExit, Cause, service, sync, type Fx, type Result } from 'e2'

interface Note {
  readonly id: number
  readonly text: string
}

// #region errors
class EmptyNote extends TaggedError<'EmptyNote'> {
  readonly _tag = 'EmptyNote' as const
}

class NoteNotFound extends TaggedError<'NoteNotFound'> {
  readonly _tag = 'NoteNotFound' as const
  constructor(readonly id: number) {
    super(`there is no note ${id}`)
  }
}
// #endregion

// #region contract
interface Notes {
  add(text: string): Fx<Note, EmptyNote>
  get(id: number): Fx<Note, NoteNotFound>
}
const Notes = service<Notes>()('Notes')
// #endregion

// #region validate
// An ordinary function. No effects, no service, just a Result.
const validate = (text: string): Result<string, EmptyNote> =>
  text.trim() === '' ? err(new EmptyNote('a note needs some text')) : ok(text.trim())
// #endregion

// #region implementation
const NotesLive = Notes.make(function* () {
  const notes = new Map<number, Note>()
  return {
    add: (text) =>
      gen(function* () {
        const clean = yield* validate(text) // an EmptyNote stops here
        const note = { id: notes.size + 1, text: clean }
        notes.set(note.id, note)
        return note
      }),
    get: (id) => {
      const note = notes.get(id)
      return note === undefined ? err(new NoteNotFound(id)) : ok(note)
    },
  }
})
// #endregion

// #region program
const duplicate = fx(function* (id: number) {
  const notes = yield* Notes
  const original = yield* notes.get(id)
  return yield* notes.add(original.text)
})
// duplicate: (id: number) => Fx<Note, NoteNotFound | EmptyNote, 'Notes'>
// #endregion

// #region outcomes
const setup = fx(function* () {
  const notes = yield* Notes
  yield* notes.add('buy milk')
  return yield* duplicate(1)
})
console.log(await run(setup(), [NotesLive])) // Ok({ id: 2, text: "buy milk" })
console.log(await run(duplicate(7), [NotesLive])) // Err(NoteNotFound: there is no note 7)
// #endregion

// #region recover
// Handle one failure; the other stays in the type.
const duplicateOrSkip = (id: number) =>
  catchAll((error: NoteNotFound | EmptyNote) => (error._tag === 'NoteNotFound' ? ok(undefined) : err(error)))(
    duplicate(id)
  )
// (id: number) => Fx<Note | undefined, EmptyNote, 'Notes'>

console.log(await run(duplicateOrSkip(7), [NotesLive])) // Ok(undefined)
// #endregion

// #region defects
// A thrown exception is a bug, not an outcome: it is not in the type,
// catchAll does not see it, and `run` rejects. `runExit` shows everything.
const broken = sync((): Note => {
  throw new Error('index out of range')
})
const exit = await runExit(broken, [])
if (!exit.ok) console.log(Cause.pretty(exit.error)) // Die(Error: index out of range)
// #endregion
