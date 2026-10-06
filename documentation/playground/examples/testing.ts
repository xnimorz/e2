// Testing: a double is another provider for the same key.
//
// The program does not change; the list does. The list is type-checked like
// everything else, so a double cannot be silently missing.
import { fx, ok, run, runSync, service, sync, type Fx } from 'e2'

interface Clock {
  readonly now: Fx<Date>
}
const Clock = service<Clock>()('Clock')

const ClockLive = Clock.of({ now: sync(() => new Date()) })

const greeting = fx(function* (name: string) {
  const clock = yield* Clock
  const now = yield* clock.now
  return `Good ${now.getHours() < 12 ? 'morning' : 'afternoon'}, ${name}`
})
// (name: string) => Fx<string, never, 'Clock'>

console.log('live:', await run(greeting('Ada'), [ClockLive]))

// A fixed clock. Nothing is mocked: the double is a value.
const nineAm = Clock.of({ now: ok(new Date(2026, 0, 1, 9)) })
const threePm = Clock.of({ now: ok(new Date(2026, 0, 1, 15)) })
console.log('9am: ', await run(greeting('Ada'), [nineAm]))
console.log('3pm: ', await run(greeting('Ada'), [threePm]))

// Nothing here suspends, so a test needs no await at all.
console.log('sync:', runSync(greeting('Grace'), [nineAm]))
