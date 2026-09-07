import type { AnyFx } from './fx.ts'
import type { AnyService, ScopeName } from './service.ts'
import { ProviderTypeId, type Covariant } from './types.ts'

export interface ProviderVariance<
  out Provides extends string,
  out Needs extends string,
  out Error,
> {
  readonly _Provides: Covariant<Provides>
  readonly _Needs: Covariant<Needs>
  readonly _Error: Covariant<Error>
}

/**
 * A constructor for one service.
 *
 * `Needs` is whatever the body yielded, minus `Scope`, inferred exactly as
 * `gen` infers an effect's dependencies. There is no declared tuple to keep
 * in sync with it: the runtime discovers the edges by running the body, and
 * builds each service it reaches on the spot. That is what makes the flat,
 * unordered provider list safe without a sort.
 *
 * Nobody constructs one of these by hand. `Db.make(function* () { … })` and
 * `Db.of(value)` do, and a service defined with a default is one already.
 */
export class Provider<out Provides extends string, out Needs extends string, out Error> {
  declare readonly [ProviderTypeId]: ProviderVariance<Provides, Needs, Error>

  constructor(
    readonly provides: AnyService,
    /** A fresh effect per attempt: generator objects are single-use. */
    readonly build: () => AnyFx,
    /** Skipped by the runtime's warm-up; built by whoever demands it first. */
    readonly lazy: boolean = false
  ) {}

  toString(): string {
    return `Provider(${this.provides.id}${this.lazy ? ', lazy' : ''})`
  }
}

export type AnyProvider = Provider<any, any, any>

// Naked type parameters, so these distribute over the union they are given.
export type ProvidesOf<Prov> = Prov extends Provider<infer Provides, any, any>
  ? Provides
  : never
export type NeedsOf<Prov> = Prov extends Provider<any, infer Needs, any> ? Needs : never
export type FailsWith<Prov> = Prov extends Provider<any, any, infer Error> ? Error : never

/**
 * Marks a provider as not built at startup.
 *
 * The runtime skips it when it warms the list; it is built by whoever
 * demands it first - a consumer's body, a `memo(Service)` handle, a request -
 * and later demanders join that one build. The trade is explicit and local
 * to the composition root: a construction failure no longer fails startup.
 * It reaches the first demander as a `ProviderFailed` defect, and the cell
 * resets so the next demand retries.
 *
 * Type-transparent: `Needs`, `Provides` and the closure check are unchanged,
 * so the list is still checked as a whole.
 */
export const lazy = <Prov extends AnyProvider>(
  provider: Prov
): Provider<ProvidesOf<Prov>, NeedsOf<Prov>, FailsWith<Prov>> =>
  new Provider(provider.provides, provider.build, true)

/**
 * What a program still needs that the given providers do not supply.
 *
 * Note the `NeedsOf` term: a provider's own requirements are folded in, so
 * omitting a provider that nothing in the program mentions directly - but that
 * another provider depends on - is still caught.
 *
 * `Scope` is always excluded: every entry point supplies one.
 */
export type MissingServices<
  Dependency extends string,
  Providers extends readonly AnyProvider[],
> = Exclude<
  Dependency | NeedsOf<Providers[number]>,
  ProvidesOf<Providers[number]> | ScopeName
>

/** The same check against an already-built runtime's provided set. */
export type CheckAgainst<Dependency extends string, Provided extends string> = [
  Exclude<Dependency, Provided | ScopeName>,
] extends [never]
  ? unknown
  : MissingMsg<Exclude<Dependency, Provided | ScopeName>>

/** Distributes, so several missing dependencies produce several literals. */
export type MissingMsg<Of extends string> = Of extends any
  ? `e2: missing service ${Of}`
  : never

/**
 * `unknown` when the graph is complete, otherwise a literal naming what is
 * missing.
 *
 * Intersected with the *effect* argument of `run`, never with the providers
 * argument: intersecting a string literal into an array element type produces
 * `Provider<...> & string` noise that never names the missing service.
 */
export type Check<
  Dependency extends string,
  Providers extends readonly AnyProvider[],
> = [MissingServices<Dependency, Providers>] extends [never]
  ? unknown
  : MissingMsg<MissingServices<Dependency, Providers>>
