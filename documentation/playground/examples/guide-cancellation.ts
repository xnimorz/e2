// Time out, retry, cancel: work that stops when nobody wants it.
import { Schedule, TaggedError, fork, fromPromise, fx, gen, interruptFiber, retry, run, service, sleep, timeout, type Fx } from 'e2'

const started = performance.now()
const log = (...parts: unknown[]) =>
  console.log(`${String(Math.round(performance.now() - started)).padStart(5)}ms `, ...parts)

// #region request
class Offline extends TaggedError<'Offline'> {
  readonly _tag = 'Offline' as const
}
class TooSlow extends TaggedError<'TooSlow'> {
  readonly _tag = 'TooSlow' as const
}

// Pretend this is `fetch`: it takes a signal and stops when it fires.
// The first two requests find the server unreachable.
let failuresLeft = 2
const upload = (signal: AbortSignal, delay: number): Promise<string> =>
  new Promise((resolve, reject) => {
    log('upload: sending…')
    const timer = setTimeout(() => {
      if (failuresLeft-- > 0) reject(new Error('offline'))
      else resolve('synced')
    }, delay)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      log('upload: aborted')
      reject(signal.reason)
    })
  })
// #endregion

// #region service
interface Sync {
  push(delay: number): Fx<string, Offline>
}
const Sync = service<Sync>()('Sync')

const SyncLive = Sync.of({
  // fromPromise hands the fiber's AbortSignal to the request.
  push: (delay) => fromPromise((signal) => upload(signal, delay), () => new Offline('server unreachable')),
})
// #endregion

// #region policy
const syncNow = fx(function* (delay: number) {
  const sync = yield* Sync
  return yield* sync.push(delay)
})

// Retry offline failures with backoff, and give up after a second overall.
const reliable = (delay: number) =>
  timeout(1_000, () => new TooSlow('gave up'))(retry(Schedule.exponential(100).upTo(5))(syncNow(delay)))
// (delay: number) => Fx<string, Offline | TooSlow, 'Sync'>

log('result:', await run(reliable(50), [SyncLive]))
// #endregion

// #region cancel
// Cancelling the caller cancels the request.
await run(
  gen(function* () {
    const background = yield* fork(syncNow(5_000))
    yield* sleep(100)
    yield* interruptFiber(background) // upload: aborted
  }),
  [SyncLive]
)
// #endregion
