import {
  Gen,
  SingleShot,
  type AnyFx,
  type AnyYield,
  type Fx,
  type FxIterator,
  type FxVariance,
  type FxYield,
} from './fx.ts'
import type { DependenciesOf, ErrorOf } from './gen.ts'
import { Provider, type ProviderVariance } from './provider.ts'
import { Ok } from './result.ts'
import { FxTypeId, ProviderTypeId, type Invariant } from './types.ts'

/** The one service a provider may use without it appearing in `Needs`. */
export const SCOPE_NAME = 'Scope'
export type ScopeName = typeof SCOPE_NAME

/**
 * A service: a contract, and the key used to look up whatever satisfies it.
 *
 * The interface behind a service is its **Api**, and nothing else in the
 * library is called a service, so the word means exactly one thing. By
 * convention the interface and the key share a name - `interface Db` and
 * `const Db` live in different declaration spaces - so type `Db` is the
 * contract, value `Db` is the key, and `yield* Db` gives a `Db`.
 *
 * A `Service` is itself an `Fx` that resolves to its Api, which is why
 * `const db = yield* Db` works with no accessor helper, and why `memo(Db)`
 * defers a dependency with no API of its own.
 *
 * The two ways to implement a service hang off the key: `Db.make(body)` for
 * construction that may yield other services, `Db.of(value)` for a value you
 * already hold. Both return a {@link Provider}.
 *
 * `Name` is a string literal, and it is what the dependency channel carries.
 * That makes `Exclude<Dependency, Provided>` nominal by construction and keeps
 * hovers short - `Fx<User, DbError, 'Db'>` rather than
 * `Fx<User, DbError, Service<'Db', DbApi>>`. The trade is that two services may
 * not share a name; the runtime rejects that when the list is assembled.
 *
 * `Api` is invariant, so `Service<'Db', {a: 1}>` is never silently accepted
 * where `Service<'Db', {}>` is expected.
 */
export class Service<Name extends string, Api> implements Fx<Api, never, Name> {
  /** Instruction discriminant: resolve this service from the map. */
  readonly _tag = 'Service' as const

  declare readonly [FxTypeId]: FxVariance<Api, never, Name>
  declare readonly _Api: Invariant<Api>

  constructor(readonly id: Name) {}

  /**
   * An implementation whose construction is a generator body.
   *
   * Dependencies are whatever the body yields; `Scope` is stripped because
   * every provider runs inside the runtime's scope. `Value extends Api`
   * rather than `Api` itself, so a class instance or an object with extra
   * members is accepted, while the contract still bounds every method: an
   * implementation whose `query` reaches for `Logger` when the contract says
   * `Fx<User, DbError>` is rejected here, where it is written.
   */
  make<Yielded extends AnyYield, Value extends Api>(
    body: () => Generator<Yielded, Value, never>
  ): Provider<Name, Exclude<DependenciesOf<Yielded>, ScopeName>, ErrorOf<Yielded>> {
    // A fresh thunk per construction: generator objects are single-use.
    return new Provider(this, () => new Gen(body as never)) as never
  }

  /** An already-built implementation: configuration, a test double. */
  of(value: Api): Provider<Name, never, never> {
    return new Provider(this, () => new Ok(value)) as never
  }

  [Symbol.iterator](): FxIterator<FxYield<Api, never, Name>, Api> {
    return new SingleShot(this) as never
  }

  toString(): string {
    return `Service(${this.id})`
  }
}

/**
 * A service defined together with its default implementation.
 *
 * It is a `Service` - yield it, make alternatives from it with `.make` and
 * `.of` - and structurally also a `Provider`, so it goes into `runtime([...])`
 * as itself. An abstract `Service` is not a `Provider`, so passing one to
 * `runtime` is rejected at compile time.
 *
 * Defaults are never pulled in transitively. The closure check works on
 * names, and a name cannot know whether it has a default, so every service
 * is still named once in the list.
 */
export class Defaulted<
  Name extends string,
  Api,
  out Needs extends string,
  out Error,
> extends Service<Name, Api> {
  declare readonly [ProviderTypeId]: ProviderVariance<Name, Needs, Error>

  readonly provides: AnyService
  readonly lazy: boolean = false

  constructor(
    id: Name,
    readonly build: () => AnyFx
  ) {
    super(id)
    this.provides = this
  }

  override toString(): string {
    return `Service(${this.id}, with default)`
  }
}

export type AnyService = Service<string, any>

/** The literal name a service is registered under. */
export type NameOf<Of> = Of extends Service<infer Name, any> ? Name : never
/** The interface a service resolves to. */
export type ApiOf<Of> = Of extends Service<any, infer Api> ? Api : never

/**
 * Defines a service.
 *
 * Contract-first - the Api is given, the name is inferred as a literal:
 *
 * ```ts
 * export interface Db { query(id: string): Fx<User, DbError> }
 * export const Db = service<Db>()('Db')
 * ```
 *
 * Implementation-first - both the Api and the dependencies come from the
 * body, and the result carries its default:
 *
 * ```ts
 * export const Config = service('Config', function* () {
 *   return { url: 'postgres://', pageSize: 50 }
 * })
 * export type Config = ApiOf<typeof Config>
 * ```
 *
 * The first form is two calls because `Api` is explicit while `Name` must be
 * inferred as a literal, and TypeScript infers all of a call's type
 * arguments or none.
 */
export function service<Api>(): <const Name extends string>(name: Name) => Service<Name, Api>
export function service<const Name extends string, Yielded extends AnyYield, Api>(
  name: Name,
  make: () => Generator<Yielded, Api, never>
): Defaulted<Name, Api, Exclude<DependenciesOf<Yielded>, ScopeName>, ErrorOf<Yielded>>
export function service(
  name?: string,
  make?: () => Generator<AnyYield, unknown, never>
): unknown {
  if (name === undefined) {
    return <const Name extends string>(id: Name) => new Service(id)
  }
  return new Defaulted(name, () => new Gen(make as never))
}
