// ---------------------------------------------------------------------------
// spike/fx_types.ts - PHASE 0 GO/NO-GO GATE.
//
// Types only. There is no runtime here; `bun x tsc --noEmit` is the entire
// test. Nothing else in the library gets written until this file passes.
//
// Findings baked in (see NOTES at the bottom of the file):
//   - Fx exposes a custom FxIterator whose `next` takes ...args: any[].
//     Using Iterator<Yielded, Value, never> fails with TS2766.
//   - FxIterator must NOT declare `return`/`throw`; their type params leak
//     into the result type of `yield*`.
//   - The Dependency channel carries service NAMES, not Service types.
// ---------------------------------------------------------------------------

declare const FxTypeId: unique symbol
declare const YieldTypeId: unique symbol

type Covariant<Of> = (_: never) => Of
type Invariant<Of> = (_: Of) => Of

interface FxVariance<out Value, out Error, out Dependency> {
  readonly _Value: Covariant<Value>
  readonly _Error: Covariant<Error>
  readonly _Dependency: Covariant<Dependency>
}

/**
 * Occupies the TYield slot of every e2 generator.
 *
 * Deliberately NOT iterable - that is what breaks the type-level circularity
 * Effect had to patch in v3 (PR #2625, "Avoid circularity on generators").
 * Purely phantom: at runtime the Fx node itself is yielded, so unlike Effect
 * v3's YieldWrap this costs zero allocations per yield*.
 */
interface FxYield<out Value, out Error, out Dependency extends string> {
  readonly [YieldTypeId]: FxVariance<Value, Error, Dependency>
}

/**
 * The iterator every Fx hands to `yield*`.
 *
 * `next` takes `...args: ReadonlyArray<any>` rather than a typed TNext.
 * Declaring `Iterator<Yielded, Value, never>` instead fails with TS2766
 * ("the 'next' method of its iterator expects type 'never', but the containing
 * generator will always send 'any'"), because when TS checks the delegation
 * the containing generator's own TNext is still uninferred `any`.
 *
 * `return` and `throw` are deliberately absent: their own type parameters leak
 * into the result type of `yield*` (you get `LogSvc | Of` instead of `LogSvc`).
 */
interface FxIterator<out Yielded, out Value> {
  next(...args: ReadonlyArray<any>): IteratorResult<Yielded, Value>
}

/**
 * A lazy description of a computation producing `Value`, failing with `Error`,
 * requiring the services named by `Dependency`.
 */
interface Fx<out Value, out Error = never, out Dependency extends string = never> {
  readonly [FxTypeId]: FxVariance<Value, Error, Dependency>
  [Symbol.iterator](): FxIterator<FxYield<Value, Error, Dependency>, Value>
}

type AnyFx = Fx<any, any, any>
type AnyYield = FxYield<any, any, any>

// --- extraction ------------------------------------------------------------
// The [Of] tuple wrapping is mandatory: it stops distribution so `infer`
// collects the union across ALL members instead of distributing over them.

type ErrorOf<Yielded> = [Yielded] extends [never]
  ? never
  : [Yielded] extends [FxYield<infer _Value, infer Error, infer _Dependency>]
    ? Error
    : never

type DependenciesOf<Yielded> = [Yielded] extends [never]
  ? never
  : [Yielded] extends [FxYield<infer _Value, infer _Error, infer Dependency>]
    ? Dependency
    : never

// --- Result is the pure subset of Fx ---------------------------------------
// Ok IS succeed(); Err IS fail(). `yield* someResult` is the `?` operator.

interface Ok<out Value> extends Fx<Value, never, never> {
  readonly _tag: 'Ok'
  readonly ok: true
  readonly value: Value
}

interface Err<out Error> extends Fx<never, Error, never> {
  readonly _tag: 'Err'
  readonly ok: false
  readonly error: Error
}

type Result<Value, Error = never> = Ok<Value> | Err<Error>
type AnyResult = Result<any, any>

// --- Service: a service key that is itself an Fx --------------------------------

interface Service<Name extends string, Service> extends Fx<Service, never, Name> {
  readonly id: Name
  // Invariant so Service<'Db', {a: 1}> is never confused with Service<'Db', {}>.
  readonly _Service: Invariant<Service>
}

type AnyService = Service<string, any>
type NameOf<Of> = Of extends Service<infer Name, any> ? Name : never
type ApiOf<Of> = Of extends Service<any, infer Service> ? Service : never

/** The one reserved dependency name: providers may use Scope undeclared. */
type ScopeName = 'Scope'

// --- gen / fx ---------------------------------------------------------------

/** Guards `return someFx` with no yield*. Result is carved out on purpose. */
type Returned<Value, Yielded extends AnyYield> = [Value] extends [AnyResult]
  ? Fx<Value, ErrorOf<Yielded>, DependenciesOf<Yielded>>
  : [Value] extends [AnyFx]
    ? 'e2: this generator returns an Fx - did you forget `yield*`?'
    : Fx<Value, ErrorOf<Yielded>, DependenciesOf<Yielded>>

declare function gen<Yielded extends AnyYield, Value>(
  body: () => Generator<Yielded, Value, never>
): Returned<Value, Yielded>

declare function fx<Args extends readonly any[], Yielded extends AnyYield, Value>(
  body: (...args: Args) => Generator<Yielded, Value, never>
): (...args: Args) => Returned<Value, Yielded>

// --- providers + the missing-dependency diagnostic --------------------------

interface Provider<out Provides extends string, out Needs extends string, out Error> {
  readonly provides: AnyService
  readonly needs: readonly AnyService[]
  readonly _Provides: Covariant<Provides>
  readonly _Needs: Covariant<Needs>
  readonly _Error: Covariant<Error>
}

type AnyProvider = Provider<any, any, any>

// Naked type params => these DO distribute over the union they are given.
type ProvidesOf<Prov> = Prov extends Provider<infer Provides, any, any> ? Provides : never
type NeedsOf<Prov> = Prov extends Provider<any, infer Needs, any> ? Needs : never
type FailsWith<Prov> = Prov extends Provider<any, any, infer Error> ? Error : never

/**
 * A provider's declared `deps` tuple is the ONLY place dependencies are
 * written. It feeds the type level here and `provider.needs` (the topological
 * sort) at runtime, so the two cannot drift. The conditional return type below
 * additionally rejects a build body that reaches for anything it did not
 * declare - which is what makes the flat, unordered provider list safe.
 */
declare function provider<
  Target extends AnyService,
  const Deps extends readonly AnyService[],
  Yielded extends AnyYield,
  Value extends ApiOf<Target>,
>(
  target: Target,
  deps: Deps,
  build: (...services: { [K in keyof Deps]: ApiOf<Deps[K]> }) => Generator<
    Yielded,
    Value,
    never
  >
): [Exclude<DependenciesOf<Yielded>, NameOf<Deps[number]> | ScopeName>] extends [never]
  ? Provider<NameOf<Target>, NameOf<Deps[number]>, ErrorOf<Yielded>>
  : `e2: provider for ${NameOf<Target>} uses an undeclared dependency - add it to the deps list`

type MissingServices<
  Dependency extends string,
  Providers extends readonly AnyProvider[],
> = Exclude<Dependency | NeedsOf<Providers[number]>, ProvidesOf<Providers[number]>>

/** Distributes, so several missing deps yield a union of readable literals. */
type MissingMsg<Of extends string> = Of extends any
  ? `e2: missing service ${Of}`
  : never

type Check<Dependency extends string, Providers extends readonly AnyProvider[]> = [
  MissingServices<Dependency, Providers>,
] extends [never]
  ? unknown
  : MissingMsg<MissingServices<Dependency, Providers>>

declare function run<
  Value,
  Error,
  Dependency extends string,
  Providers extends readonly AnyProvider[],
>(
  effect: Fx<Value, Error, Dependency> & Check<Dependency, Providers>,
  providers: Providers
): Promise<Result<Value, Error | FailsWith<Providers[number]>>>

// ===========================================================================
// FIXTURES
// ===========================================================================

type Equals<Left, Right> =
  (<Of>() => Of extends Left ? 1 : 2) extends <Of>() => Of extends Right ? 1 : 2
    ? true
    : false

declare const assert: <_Passed extends true>() => void

interface User {
  id: string
  name: string
}

declare class DbError {
  readonly _tag: 'DbError'
}
declare class HttpError {
  readonly _tag: 'HttpError'
}
declare class ParseError {
  readonly _tag: 'ParseError'
}
declare class ConnError {
  readonly _tag: 'ConnError'
}

interface DbSvc {
  query(id: string): Fx<User, DbError>
}
interface LogSvc {
  info(msg: string, ...rest: unknown[]): Fx<void>
}
interface CfgSvc {
  readonly url: string
}

declare const Db: Service<'Db', DbSvc>
declare const Logger: Service<'Logger', LogSvc>
declare const Config: Service<'Config', CfgSvc>

declare function http(url: string): Fx<string, HttpError, never>
/** A plain sync fallible function - no Fx involved. */
declare function parseCount(raw: string): Result<number, ParseError>
declare function connect(url: string): Fx<DbSvc, ConnError>

// ===========================================================================
// ASSERTION 1 - union accumulation: straight line, loop, conditional, Result
// ===========================================================================

const getUser = fx(function* (id: string, retry: boolean) {
  const db = yield* Db
  const log = yield* Logger
  const cfg = yield* Config
  yield* log.info('load', id, cfg.url)
  if (retry) {
    for (let i = 0; i < 3; i++) {
      const raw = yield* http(cfg.url) // adds HttpError
      const n = yield* parseCount(raw) // adds ParseError - Result as `?`
      if (n > 0) break
    }
  }
  return yield* db.query(id) // adds DbError
})

assert<
  Equals<
    ReturnType<typeof getUser>,
    Fx<User, DbError | HttpError | ParseError, 'Db' | 'Logger' | 'Config'>
  >
>()

// ===========================================================================
// ASSERTION 2 - generators calling generators
// ===========================================================================

const outer = gen(function* () {
  const u = yield* getUser('1', true)
  return u.name
})

assert<
  Equals<
    typeof outer,
    Fx<string, DbError | HttpError | ParseError, 'Db' | 'Logger' | 'Config'>
  >
>()

// ===========================================================================
// ASSERTION 3 - zero-yield generator
// ===========================================================================

const pure = gen(function* () {
  return 42
})

assert<Equals<typeof pure, Fx<number, never, never>>>()

// ===========================================================================
// ASSERTION 4 - a bare `yield` (missing *) is rejected outright
// ===========================================================================

// Note the diagnostic lands on the gen() call, not on the `yield` line: the
// Yielded constraint rejects Service<'Db', DbSvc> because it has no [YieldTypeId].
// @ts-expect-error e2: `yield` used without `*`
gen(function* () {
  const db = yield Db
  return db
})

// ===========================================================================
// ASSERTION 5 - forgotten yield* on the return statement
// ===========================================================================

const forgotten = fx(function* (id: string) {
  const db = yield* Db
  return db.query(id) // no yield*
})

assert<
  Equals<
    ReturnType<typeof forgotten>,
    'e2: this generator returns an Fx - did you forget `yield*`?'
  >
>()

// ===========================================================================
// ASSERTION 6 - returning a Result on purpose is still allowed
// ===========================================================================

const deliberateResult = gen(function* () {
  return parseCount('1')
})

assert<Equals<typeof deliberateResult, Fx<Result<number, ParseError>, never, never>>>()

// ===========================================================================
// ASSERTION 7 - the missing-dependency diagnostic
// ===========================================================================

declare const DbLive: Provider<'Db', 'Config' | 'Logger', ConnError>
declare const LoggerLive: Provider<'Logger', 'Config', never>
declare const ConfigLive: Provider<'Config', never, ParseError>

// complete graph - compiles, and each provider's own error joins the channel
const complete = run(getUser('1', false), [DbLive, LoggerLive, ConfigLive])
assert<
  Equals<
    typeof complete,
    Promise<Result<User, DbError | HttpError | ParseError | ConnError>>
  >
>()

// @ts-expect-error e2: missing service Logger (required transitively by DbLive,
// never mentioned by getUser itself)
run(getUser('1', false), [DbLive, ConfigLive])

// @ts-expect-error e2: missing service Logger | e2: missing service Config
run(getUser('1', false), [DbLive])

// ===========================================================================
// ASSERTION 8 - a provider body cannot reach for an undeclared dependency
// ===========================================================================

const DbLiveOk = provider(Db, [Config, Logger], function* (cfg, log) {
  yield* log.info('connecting', cfg.url)
  return yield* connect(cfg.url)
})

assert<Equals<typeof DbLiveOk, Provider<'Db', 'Config' | 'Logger', ConnError>>>()

// Logger is used but NOT declared in deps.
const DbLiveUndeclared = provider(Db, [Config], function* (cfg) {
  const log = yield* Logger
  yield* log.info('connecting', cfg.url)
  return yield* connect(cfg.url)
})

assert<
  Equals<
    typeof DbLiveUndeclared,
    'e2: provider for Db uses an undeclared dependency - add it to the deps list'
  >
>()

// ===========================================================================
// NOTES - empirical findings from the phase 0 spike (TypeScript 5.9.3)
// ===========================================================================
//
// 1. TS2766 is the first wall you hit.
//    Declaring `[Symbol.iterator](): Iterator<FxYield<...>, Value, never>` on
//    Fx fails on EVERY `yield*` with:
//      "Cannot delegate iteration to value because the 'next' method of its
//       iterator expects type 'never', but the containing generator will
//       always send 'any'."
//    At the point TS checks the delegation the containing generator's own
//    TNext is still uninferred `any`. The fix is a custom iterator interface
//    whose `next` takes `...args: ReadonlyArray<any>`. Effect hit the same
//    wall and solved it the same way (see its EffectGenerator).
//
// 2. Do NOT put `return` or `throw` on FxIterator.
//    `return<Of>(value: Of): IteratorResult<Yielded, Of>` leaks its own type
//    parameter into the result type of `yield*`: you get `LogSvc | Of` and
//    then "Property 'info' does not exist on type 'LogSvc | Of'". TS only
//    needs `next` to type a delegation. Keep the interface to one member.
//
// 3. The Dependency channel carries service NAMES, not Service types.
//    Both work, but the printed types differ sharply:
//      Service types:  Fx<User, DbError | HttpError | ParseError,
//                     Service<"Db", DbSvc> | Service<"Logger", LogSvc>
//                       | Service<"Config", CfgSvc>>          <- 62 chars
//      names:      Fx<User, DbError | HttpError | ParseError,
//                     "Db" | "Logger" | "Config">          <- 26 chars
//    That shows up in every hover, not just in error messages, and it is the
//    main mitigation for IDE type truncation. Exclude<> also becomes nominal
//    by construction rather than by relying on the `id` literal.
//    Cost: two tags sharing a name are indistinguishable at the type level.
//    Plan.from's duplicate-id check is what catches that, at runtime.
//
// 4. Union accumulation does NOT have a practical cliff.
//    A single body with 500 yield* (250 tags, each yielded then invoked)
//    infers all 250 error types and all 250 dependency names exactly:
//      25 yields  0.3s | 60  0.4s | 120  0.5s | 250  1.0s   (x2 yields each)
//    The feared O(n^2) blowup did not materialise. Guidance of "<40 yields
//    per body" is unnecessary; keep bodies small for readability, not for tsc.
//
// 5. A bare `yield` IS caught, contrary to the original expectation that it
//    would silently type as `never`. The `Yielded extends AnyYield` constraint
//    rejects it. The diagnostic lands on the gen()/fx() call, not on the
//    `yield` line, and bottoms out in a clear final line:
//      "Property '[YieldTypeId]' is missing in type 'Service<"Db", DbSvc>' but
//       required in type 'FxYield<any, any, any>'."
//
// 6. Putting the Check intersection on the PROVIDERS argument is worse.
//    `providers: Providers & Check<...>` intersects a string literal into the
//    array element type and produces noise about `Provider<...> & string`
//    that never names the missing service. Keep Check on the effect
//    argument, where the failure reads:
//      "Type 'Fx<User, DbError | HttpError | ParseError,
//              "Db" | "Logger" | "Config">' is not assignable to type
//       '"e2: missing service Logger"'."
