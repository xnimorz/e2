import type { Result } from './result.ts'
import { assertNever, type Covariant } from './types.ts'

/**
 * Why a fiber stopped short of producing a value.
 *
 * Three cases, and the distinction matters at exactly one place - the boundary:
 *
 *   - `Fail` is an expected error, the thing the `Error` channel tracks.
 *   - `Die` is a defect: a bug, a thrown non-error, a broken invariant. It is
 *     deliberately NOT folded into the `Error` channel, because forcing every
 *     call site to handle `Error | Defect` poisons the channel and makes
 *     exhaustive recovery impossible.
 *   - `Interrupt` is cancellation, which is neither success nor failure.
 */
export class Fail<out Error> {
  readonly _tag = 'Fail' as const
  declare readonly _Error: Covariant<Error>

  constructor(readonly error: Error) {}
}

export class Die {
  readonly _tag = 'Die' as const

  constructor(readonly defect: unknown) {}
}

export class Interrupt {
  readonly _tag = 'Interrupt' as const

  constructor(readonly reason?: string) {}
}

export type Cause<Error> = Fail<Error> | Die | Interrupt
export type AnyCause = Cause<any>

/**
 * The outcome of running an Fx to completion.
 *
 * Reuses `Result` rather than introducing a third vocabulary: an `Exit` is just
 * a `Result` whose failure side has been widened to include defects and
 * interruption.
 */
export type Exit<Value, Error = never> = Result<Value, Cause<Error>>

export const fail = <Error>(error: Error): Fail<Error> => new Fail(error)
export const die = (defect: unknown): Die => new Die(defect)
export const interrupt = (reason?: string): Interrupt => new Interrupt(reason)

export const isFail = <Error>(cause: Cause<Error>): cause is Fail<Error> =>
  cause._tag === 'Fail'
export const isDie = <Error>(cause: Cause<Error>): cause is Die => cause._tag === 'Die'
export const isInterrupt = <Error>(cause: Cause<Error>): cause is Interrupt =>
  cause._tag === 'Interrupt'

/** The value to throw when a `Cause` has to cross into ordinary JS. */
export function squash<Error>(cause: Cause<Error>): unknown {
  switch (cause._tag) {
    case 'Fail':
      return cause.error
    case 'Die':
      return cause.defect
    case 'Interrupt':
      return new Error(
        cause.reason == null ? 'e2: interrupted' : `e2: interrupted - ${cause.reason}`
      )
    default:
      return assertNever(cause)
  }
}

export function pretty<Error>(cause: Cause<Error>): string {
  switch (cause._tag) {
    case 'Fail':
      return `Fail(${String(cause.error)})`
    case 'Die':
      return `Die(${String(cause.defect)})`
    case 'Interrupt':
      return cause.reason == null ? 'Interrupt' : `Interrupt(${cause.reason})`
    default:
      return assertNever(cause)
  }
}
