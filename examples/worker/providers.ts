import { sync, type Fx } from '../../src/fx.ts'
import { Err, Ok } from '../../src/result.ts'
import { Heavy, HeavyError, type HeavySvc } from './contract.ts'
import { call, openLink } from './client.ts'

export const decodeHeavyError = (raw: unknown): HeavyError =>
  new HeavyError(
    typeof raw === 'object' && raw !== null && 'reason' in raw
      ? String((raw as { reason: unknown }).reason)
      : 'unknown'
  )

/**
 * Runs the work on a worker thread.
 *
 * The worker is acquired on the provider's scope, so it is terminated when the
 * runtime closes - success, failure or interruption alike.
 */
export const HeavyOnWorker = Heavy.make(function* () {
  const link = yield* openLink(new URL('./heavy.worker.ts', import.meta.url))
  return {
    digest: (input: string, rounds: number) =>
      call<string, HeavyError>(link, 'digest', [input, rounds], decodeHeavyError),
    countPrimes: (limit: number) =>
      call<number, HeavyError>(link, 'countPrimes', [limit], decodeHeavyError),
  } satisfies HeavySvc
})

/**
 * Runs the same work inline, blocking whoever calls it.
 *
 * Exists to make the point that the *calling program is identical*. Swapping
 * threads is a one-line change to the provider list; nothing that consumes
 * `Heavy` knows or cares which side of a boundary the work happens on. That is
 * the payoff for routing this through DI rather than through an import.
 */
export const HeavyOnMainThread = Heavy.make(function* () {
  return {
  digest: (input: string, rounds: number): Fx<string, HeavyError> =>
    sync(() => {
      let hash = 0x811c9dc5
      for (let round = 0; round < rounds; round++) {
        for (let index = 0; index < input.length; index++) {
          hash ^= input.charCodeAt(index)
          hash = Math.imul(hash, 0x01000193) >>> 0
        }
      }
      return hash.toString(16).padStart(8, '0')
    }),
  countPrimes: (limit: number): Fx<number, HeavyError> =>
    limit < 2
      // The two implementations must agree on failures as well as on values,
      // or swapping providers is not actually transparent.
      ? new Err(new HeavyError(`limit must be at least 2, received ${limit}`))
      : sync(() => {
      const sieve = new Uint8Array(limit + 1)
      let found = 0
      for (let candidate = 2; candidate <= limit; candidate++) {
        if (sieve[candidate] === 1) continue
        found += 1
        for (let m = candidate * candidate; m <= limit; m += candidate) sieve[m] = 1
      }
      return found
    }),
  }
})

/** A stub, to show the third implementation costs nothing extra. */
export const HeavyStub = Heavy.of({
  digest: () => new Ok('stubbed') as Fx<string, HeavyError>,
  countPrimes: () => new Err(new HeavyError('stub has no primes')) as Fx<number, HeavyError>,
})
