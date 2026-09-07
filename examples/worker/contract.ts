import type { Fx } from '../../src/fx.ts'
import { service } from '../../src/service.ts'

export class HeavyError {
  readonly _tag = 'HeavyError' as const
  constructor(readonly reason: string) {}
}

/**
 * The contract. Shared by both sides, implemented on one and proxied on the
 * other - the calling program cannot tell which.
 */
export interface HeavySvc {
  /** Deliberately CPU-bound, so blocking the main thread would be visible. */
  readonly digest: (input: string, rounds: number) => Fx<string, HeavyError>
  readonly countPrimes: (limit: number) => Fx<number, HeavyError>
}

export const Heavy = service<HeavySvc>()('Heavy')
export type Heavy = typeof Heavy
