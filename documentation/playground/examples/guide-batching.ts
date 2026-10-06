// Coalesce writes: many single calls, one write.
import { batch, forEach, fx, gen, run, service, sync, type Fx } from 'e2'

interface Note {
  readonly id: number
  readonly text: string
}

interface Notes {
  add(text: string): Fx<Note>
  readonly saved: Fx<number>
}
const Notes = service<Notes>()('Notes')

// #region batch
const NotesLive = Notes.make(function* () {
  const rows = new Map<number, Note>()
  let writes = 0

  // One operation over many notes; callers hand it one note at a time.
  const disk = yield* batch(
    (notes: readonly Note[]) =>
      sync(() => {
        writes += 1
        console.log(`write #${writes}: ${notes.length} notes`)
        return notes
      }),
    { maxSize: 100 }
  )

  return {
    add: (text) =>
      gen(function* () {
        const note = { id: rows.size + 1, text }
        rows.set(note.id, note) // readable now
        yield* disk.enqueue(note) // durable shortly, with its neighbours
        return note
      }),
    saved: sync(() => writes),
  }
})
// #endregion

// #region import
const importNotes = fx(function* (texts: readonly string[]) {
  const notes = yield* Notes
  yield* forEach((text: string) => notes.add(text))(texts)
  return texts.length
})

const lines = Array.from({ length: 250 }, (_, index) => `note ${index + 1}`)
console.log(await run(importNotes(lines), [NotesLive]))
// write #1: 100 notes
// write #2: 100 notes
// write #3: 50 notes   <- flushed when the run ends; nothing is lost
// #endregion
