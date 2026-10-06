// Batching: many single calls, one run.
//
// `enqueue` is write-behind: the caller does not wait. `add` waits for its
// own element of the result: the DataLoader shape.
import { allConcurrent, batch, forEach, gen, run, service, sync, type Fx } from 'e2'

interface Store {
  put(row: string): Fx<void>
  readonly flush: Fx<void>
  readonly writes: Fx<number>
}
const Store = service<Store>()('Store')

const StoreLive = Store.make(function* () {
  let writes = 0
  const writer = yield* batch(
    (rows: readonly string[]) =>
      sync(() => {
        writes += 1
        console.log(`write #${writes}: ${rows.length} rows`)
        return rows
      }),
    { maxSize: 20 }
  )
  return { put: writer.enqueue, flush: writer.flush, writes: sync(() => writes) }
})

const fifty = gen(function* () {
  const store = yield* Store
  yield* forEach((n: number) => store.put(`row ${n}`))(Array.from({ length: 50 }, (_, n) => n))
  yield* store.flush
  return yield* store.writes
})
console.log('writes for 50 puts:', await run(fifty, [StoreLive]))

// add: each caller gets its own result, one lookup for all of them.
interface Users {
  name(id: number): Fx<string>
}
const Users = service<Users>()('Users')

const UsersLive = Users.make(function* () {
  const loader = yield* batch((ids: readonly number[]) =>
    sync(() => {
      console.log(`one lookup for ids ${ids.join(', ')}`)
      return ids.map((id) => `user-${id}`)
    })
  )
  return { name: loader.add }
})

const names = gen(function* () {
  const users = yield* Users
  return yield* allConcurrent([users.name(1), users.name(2), users.name(3)])
})
console.log(await run(names, [UsersLive]))
