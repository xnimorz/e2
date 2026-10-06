// Concurrency and resources: structured, cancellable, cleaned up.
import {
  Schedule,
  TaggedError,
  acquire,
  err,
  fork,
  gen,
  interruptFiber,
  race,
  retry,
  run,
  scoped,
  sleep,
  timeout,
} from 'e2'

const start = performance.now()
const log = (...parts: unknown[]) =>
  console.log(`${String(Math.round(performance.now() - start)).padStart(5)}ms `, ...parts)

// 1. Children die with their parent.
const ticker = gen(function* () {
  try {
    for (let tick = 1; ; tick++) {
      yield* sleep(100)
      log(`tick ${tick}`)
    }
  } finally {
    log('ticker: finally ran')
  }
})
await run(
  gen(function* () {
    yield* fork(ticker)
    yield* sleep(350)
    log('parent: done, so the ticker is interrupted')
  }),
  []
)

// 2. race and timeout interrupt the loser.
const slow = gen(function* () {
  yield* sleep(1_000)
  return 'slow'
})
const fast = gen(function* () {
  yield* sleep(100)
  return 'fast'
})
log('race:', await run(race(slow, fast), []))

class TimedOut extends TaggedError<'TimedOut'> {
  readonly _tag = 'TimedOut' as const
}
const limited = await run(timeout(200, () => new TimedOut('slow took too long'))(slow), [])
log('timeout:', limited)

// 3. retry follows a schedule.
class Unavailable extends TaggedError<'Unavailable'> {
  readonly _tag = 'Unavailable' as const
}
let attempts = 0
const flaky = gen(function* () {
  attempts += 1
  log(`connect: attempt ${attempts}`)
  if (attempts < 3) return yield* err(new Unavailable('try again'))
  return 'connected'
})
log('retry:', await run(retry(Schedule.exponential(50).upTo(5))(flaky), []))

// 4. Finalizers receive the Exit that closed their scope.
const transaction = (outcome: 'commit' | 'fail' | 'hang') =>
  scoped(
    gen(function* () {
      yield* acquire(
        () => log(`tx(${outcome}): begin`),
        (_, exit) => log(`tx(${outcome}): ${exit.ok ? 'commit' : `rollback, because ${exit.error._tag}`}`)
      )
      if (outcome === 'fail') return yield* err(new Unavailable('write rejected'))
      if (outcome === 'hang') yield* sleep(10_000)
      return outcome
    })
  )

await run(transaction('commit'), [])
await run(transaction('fail'), [])
await run(
  gen(function* () {
    const fiber = yield* fork(transaction('hang'))
    yield* sleep(50)
    yield* interruptFiber(fiber)
  }),
  []
)
