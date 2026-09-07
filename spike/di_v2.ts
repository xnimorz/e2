// ---------------------------------------------------------------------------
// spike/di_v2.ts - DI REDESIGN GO/NO-GO GATE.
//
// Types only, like spike/fx_types.ts. `bun x tsc --noEmit` is the entire test.
// Nothing in src/ moves until this file passes.
//
// The question: can the explicit dependency tuple on `provider(Target, [deps],
// body)` go away - so that a service body simply `yield*`s what it needs, the
// way every other e2 body already does - without losing the flat provider
// list, the "named once" property, or the missing-service diagnostic?
//
// Answer, proven below: yes. The tuple existed for exactly one reason - the
// runtime sorted the graph topologically BEFORE building anything, and a sort
// needs edges up front. If construction is demand-driven instead (a `yield*
// Db` inside a provider body builds Db on the spot, memoised), no sort is
// needed, `Needs` can be inferred from the body exactly as `gen` infers
// `Dependency`, and every type below falls out of machinery that already
// exists. See spike/di_v2.md for the runtime side and the migration.
//
// Surface under test (the whole of DI):
//   service<Api>()('Name')            a contract and its key       (unchanged)
//   service('Name', function* () {})  the same, carrying a default (new)
//   Db.make(function* () {})          an implementation; deps inferred
//   Db.of(value)                      an already-built implementation
//   memo(fx)                          run once, on first use; the lazy-init primitive
//   memo(Service)                     the same, over a key: resolve a dependency on first use
//   lazy(provider)                    at the root: do not build this one at startup
//   run                               unchanged
//   runtime                           now rejects an open list at compile time
// Gone: provider, provider.of, provider.sync, Provider.make, Plan, positional
// injection, the undeclared-dependency constraint and its 8-level diagnostic.
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

interface FxYield<out Value, out Error, out Dependency extends string> {
  readonly [YieldTypeId]: FxVariance<Value, Error, Dependency>
}

interface FxIterator<out Yielded, out Value> {
  next(...args: ReadonlyArray<any>): IteratorResult<Yielded, Value>
}

interface Fx<out Value, out Error = never, out Dependency extends string = never> {
  readonly [FxTypeId]: FxVariance<Value, Error, Dependency>
  [Symbol.iterator](): FxIterator<FxYield<Value, Error, Dependency>, Value>
}

type AnyFx = Fx<any, any, any>
type AnyYield = FxYield<any, any, any>

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

declare function ok<Value>(value: Value): Ok<Value>
declare function sync<Value>(run: () => Value): Fx<Value>

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

/** The one reserved dependency: every provider runs inside the runtime's scope. */
type ScopeName = 'Scope'

// `acquire` and `fromPromise` as src/ops.ts declares them today: `open` may
// be async, and a third argument maps a rejection into the error channel.
declare function acquire<Value>(
  open: (signal: AbortSignal) => Value | Promise<Value>,
  close: (resource: Value, exit: unknown) => void | Promise<void>
): Fx<Value, never, ScopeName>
declare function acquire<Value, Error>(
  open: (signal: AbortSignal) => Value | Promise<Value>,
  close: (resource: Value, exit: unknown) => void | Promise<void>,
  onError: (reason: unknown) => Error
): Fx<Value, Error, ScopeName>
declare function fromPromise<Value>(make: (signal: AbortSignal) => Promise<Value>): Fx<Value>
declare function fromPromise<Value, Error>(
  make: (signal: AbortSignal) => Promise<Value>,
  onReject: (reason: unknown) => Error
): Fx<Value, Error>

/**
 * Runs an effect at most once per handle and shares the outcome. The one
 * primitive behind "initialise lazily, once, and let the first use wait".
 *
 * Yielding `memo(fx)` does NOT run `fx`. It records fx's requirements against
 * the body it is yielded in (so they land in a provider's `Needs`), captures
 * the current service map and scope, and returns a dependency-free handle.
 * Yielding the handle runs `fx` on first demand - against the captured map,
 * so an `acquire` inside registers on the scope the memo was created in and
 * not on whichever request happened to come first - and every concurrent
 * demand joins that one run. `eager` starts the run in the background at the
 * point of creation, so demands arriving before it settles wait and demands
 * arriving after do not.
 *
 * The runtime memoises providers with the same cell, so the two never
 * disagree about failure, interruption or teardown; see di_v2.md.
 */
declare function memo<Value, Error, Dependency extends string>(
  effect: Fx<Value, Error, Dependency>,
  options?: { readonly eager?: boolean }
): Fx<Fx<Value, Error>, never, Dependency>

/**
 * Marks a provider as not warmed at startup. `runtime` skips it when it
 * demands the list in order; it is built by whoever demands it first - a
 * consumer's body, a `memo(Service)` handle, a request. Its cell is the same
 * cell, so a second demander during construction joins rather than rebuilds.
 *
 * The trade is explicit and local to the composition root: a construction
 * failure no longer fails startup; it reaches the first demander as a defect,
 * and the cell resets so the next demand retries. Type-transparent - `Needs`,
 * `Provides` and the closure check are unchanged, so the list is still
 * checked as a whole (CASE 10).
 */
declare function lazy<Prov extends AnyProvider>(provider: Prov): Prov

// ===========================================================================
// THE PROPOSAL
// ===========================================================================

/**
 * A constructor for one service.
 *
 * `Needs` is whatever the body yielded, minus Scope. There is no declared
 * tuple to keep in sync with it, so the "undeclared dependency" error class
 * no longer exists. `provides` and `build` are what the runtime uses.
 */
interface Provider<out Provides extends string, out Needs extends string, out Error> {
  readonly provides: AnyService
  readonly build: () => AnyFx
  readonly _Provides: Covariant<Provides>
  readonly _Needs: Covariant<Needs>
  readonly _Error: Covariant<Error>
}
type AnyProvider = Provider<any, any, any>

/**
 * A service: a contract and the key used to look it up. Still an `Fx` that
 * resolves to its Api, so `yield* Db` needs no accessor.
 *
 * The two ways to implement it hang off the key itself. That is the whole
 * replacement for `provider(...)`: nothing to import, nothing to list.
 */
interface Service<Name extends string, Api> extends Fx<Api, never, Name> {
  readonly id: Name
  readonly _Api: Invariant<Api>

  /**
   * An implementation whose construction is a generator body. Dependencies
   * are what the body yields. `Value extends Api` rather than `Api` itself so
   * a class instance or an object with extra members is accepted; the
   * contract still bounds it, see CASE 6.
   */
  make<Yielded extends AnyYield, Value extends Api>(
    body: () => Generator<Yielded, Value, never>
  ): Provider<Name, Exclude<DependenciesOf<Yielded>, ScopeName>, ErrorOf<Yielded>>

  /** An already-built implementation: configuration, a test double. */
  of(value: Api): Provider<Name, never, never>
}
type AnyService = Service<string, any>

type NameOf<Of> = Of extends Service<infer Name, any> ? Name : never
type ApiOf<Of> = Of extends Service<any, infer Api> ? Api : never

/**
 * A service defined together with its default implementation.
 *
 * It is BOTH a `Service` (yield it, make alternatives from it) and a
 * `Provider` (pass it straight to `runtime`). Because it is structurally a
 * Provider, `ProvidesOf` / `NeedsOf` / `Check` need no special case for it.
 * An abstract `Service` is not a Provider, so passing one to `runtime` is
 * rejected - CASE 3.
 */
interface Defaulted<Name extends string, Api, Needs extends string, Error>
  extends Service<Name, Api>,
    Provider<Name, Needs, Error> {}

/** Contract-first: the Api is given, the name is inferred as a literal. */
declare function service<Api>(): <const Name extends string>(name: Name) => Service<Name, Api>
/** Implementation-first: both the Api and the dependencies come from the body. */
declare function service<const Name extends string, Yielded extends AnyYield, Api>(
  name: Name,
  make: () => Generator<Yielded, Api, never>
): Defaulted<Name, Api, Exclude<DependenciesOf<Yielded>, ScopeName>, ErrorOf<Yielded>>

// --- run / runtime: byte-for-byte the types e2 has today --------------------

type ProvidesOf<Prov> = Prov extends Provider<infer Provides, any, any> ? Provides : never
type NeedsOf<Prov> = Prov extends Provider<any, infer Needs, any> ? Needs : never
type FailsWith<Prov> = Prov extends Provider<any, any, infer Error> ? Error : never

type MissingServices<
  Dependency extends string,
  Providers extends readonly AnyProvider[],
> = Exclude<Dependency | NeedsOf<Providers[number]>, ProvidesOf<Providers[number]> | ScopeName>

type MissingMsg<Of extends string> = Of extends any ? `e2: missing service ${Of}` : never

type Check<Dependency extends string, Providers extends readonly AnyProvider[]> = [
  MissingServices<Dependency, Providers>,
] extends [never]
  ? unknown
  : MissingMsg<MissingServices<Dependency, Providers>>

type CheckAgainst<Dependency extends string, Provided extends string> = [
  Exclude<Dependency, Provided | ScopeName>,
] extends [never]
  ? unknown
  : MissingMsg<Exclude<Dependency, Provided | ScopeName>>

declare function run<
  Value,
  Error,
  Dependency extends string,
  Providers extends readonly AnyProvider[],
>(
  effect: Fx<Value, Error, Dependency> & Check<Dependency, Providers>,
  providers: Providers
): Promise<Result<Value, Error | FailsWith<Providers[number]>>>

interface Runtime<Provided extends string> {
  run<Value, Error, Dependency extends string>(
    effect: Fx<Value, Error, Dependency> & CheckAgainst<Dependency, Provided>
  ): Promise<Result<Value, Error>>
}

/**
 * Builds every provider, eagerly, in list order, each on first demand. There
 * is deliberately no lazy mode: construction is cheap once a service keeps
 * its expensive parts behind `memo`, and eager construction is what makes a
 * bad graph fail at startup rather than on the first request.
 *
 * Also where the graph is checked for closure. Today's `runtime` does not do
 * this at all - only `Plan.from` catches an unsatisfied provider, at startup.
 * A list whose own needs are not all supplied resolves to a literal naming
 * the gap, so the next line reads
 *   Property 'run' does not exist on type '"e2: missing service Logger"'.
 * Of four shapes tried (recorded in di_v2.md) this is the only one that both
 * names the service and cannot be bypassed by omitting an argument.
 */
declare function runtime<Providers extends readonly AnyProvider[]>(
  providers: Providers
): [MissingServices<never, Providers>] extends [never]
  ? Promise<Runtime<ProvidesOf<Providers[number]>>>
  : MissingMsg<MissingServices<never, Providers>>

// ===========================================================================
// FIXTURES
// ===========================================================================

type Equals<Left, Right> =
  (<Of>() => Of extends Left ? 1 : 2) extends <Of>() => Of extends Right ? 1 : 2
    ? true
    : false
declare const assertType: <_Passed extends true>() => void

class DbError {
  readonly _tag = 'DbError' as const
}
class ConnError {
  readonly _tag = 'ConnError' as const
}
interface User {
  readonly id: string
}
interface Pool {
  q(id: string): User
  close(): void
}
declare function connect(url: string): Fx<Pool, ConnError>

// --- CASE 1: contract-first, with the same-name convention -----------------
// `interface Db` and `const Db` live in different declaration spaces. Type
// `Db` is the Api, value `Db` is the key. This replaces both `DbApi` and
// `type Db = typeof Db` (the latter is never referenced anywhere in the
// prototype; the former is used only as a parameter type, which is what the
// interface now is).

interface Config {
  readonly url: string
  readonly userId: string
}
const Config = service<Config>()('Config')

interface Logger {
  info(message: string): Fx<void>
}
const Logger = service<Logger>()('Logger')

interface Db {
  query(id: string): Fx<User, DbError>
}
const Db = service<Db>()('Db')

assertType<Equals<typeof Db, Service<'Db', Db>>>()
assertType<Equals<ApiOf<typeof Db>, Db>>()
assertType<Equals<NameOf<typeof Db>, 'Db'>>()

const ConfigLive = Config.of({ url: 'postgres://', userId: 'me' })
assertType<Equals<typeof ConfigLive, Provider<'Config', never, never>>>()

// Parameters of returned methods are contextually typed from the contract:
// `message` below is `string` with no annotation.
const LoggerLive = Logger.make(function* () {
  const config = yield* Config
  return {
    info: (message) => sync(() => console.log(config.userId, message.toUpperCase())),
  }
})
assertType<Equals<typeof LoggerLive, Provider<'Logger', 'Config', never>>>()

// Dependencies are inferred from the body. Scope is stripped: every provider
// runs in the runtime scope, so `acquire` costs nothing in the type.
const DbLive = Db.make(function* () {
  const config = yield* Config
  const log = yield* Logger
  const pool = yield* connect(config.url)
  yield* acquire(() => pool, (p) => p.close())
  yield* log.info('connected')
  return { query: (id) => sync(() => pool.q(id)) }
})
assertType<Equals<typeof DbLive, Provider<'Db', 'Config' | 'Logger', ConnError>>>()

// A helper takes the interface, as it would take Effect's class type.
const byId = (db: Db, id: string) => db.query(id)

const getUser = fx(function* (id: string) {
  const db = yield* Db
  const log = yield* Logger
  yield* log.info(id)
  return yield* byId(db, id)
})
assertType<Equals<ReturnType<typeof getUser>, Fx<User, DbError, 'Db' | 'Logger'>>>()

// The flat list, order irrelevant, every service named once. Unchanged.
run(getUser('1'), [DbLive, ConfigLive, LoggerLive])
run(getUser('1'), [LoggerLive, DbLive, ConfigLive])

// The diagnostic is unchanged too - `Check` did not move. The exact wording
// is captured in spike/di_v2.md.
// @ts-expect-error e2: missing service Logger
run(getUser('1'), [DbLive, ConfigLive])
// @ts-expect-error a provider's own needs count: nothing in getUser mentions Config
run(getUser('1'), [DbLive, LoggerLive])

// --- CASE 2: implementation-first (Effect.Service without `dependencies`) --

const Clock = service('Clock', function* () {
  return { now: () => sync(() => Date.now()) }
})
type Clock = ApiOf<typeof Clock>
assertType<Equals<typeof Clock, Defaulted<'Clock', { now: () => Fx<number> }, never, never>>>()
assertType<Equals<Clock, { now: () => Fx<number> }>>()

const Audit = service('Audit', function* () {
  const clock = yield* Clock
  const log = yield* Logger
  return {
    record: (what: string) =>
      gen(function* () {
        const at = yield* clock.now()
        yield* log.info(`${at} ${what}`)
      }),
  }
})
assertType<Equals<NeedsOf<typeof Audit>, 'Clock' | 'Logger'>>()

// A defaulted service IS a provider: pass it straight in. Still named once,
// still flat - a default is never pulled in transitively, because the check
// works on names and a name cannot know whether it has a default.
const withDefaults = runtime([Audit, Clock, LoggerLive, ConfigLive])
assertType<Equals<Awaited<typeof withDefaults>, Runtime<'Audit' | 'Clock' | 'Logger' | 'Config'>>>()

// Audit's default needs Clock, and Clock is not in the list.
const open = runtime([Audit, LoggerLive, ConfigLive])
assertType<Equals<typeof open, 'e2: missing service Clock'>>()

// Substituting the default is just another provider for the same key.
runtime([Audit, Clock.of({ now: () => ok(0) }), LoggerLive, ConfigLive])

// --- CASE 3: an abstract service is not a provider ------------------------

// @ts-expect-error Db has no default; it needs Db.make(...) or Db.of(...)
runtime([Db, ConfigLive, LoggerLive])

// --- CASE 4: lazy, call-time dependencies ----------------------------------
// The contract says, per method, what is needed at call time. A method that
// yields a service does not make it a construction dependency: the
// requirement flows to exactly the programs that take that path, and a
// program that only reads locally runs against a list with no ServerFetch in
// it at all. Whether ServerFetch's own expensive parts are set up at startup
// or on first use is ServerFetch's business - CASE 9.

interface ServerFetch {
  fetchOne(id: string): Fx<User, DbError>
}
const ServerFetch = service<ServerFetch>()('ServerFetch')

interface Mps {
  loadLocal(id: string): Fx<User, DbError>
  loadRemote(id: string): Fx<User, DbError, 'ServerFetch'>
}
const Mps = service<Mps>()('Mps')

const MpsLive = Mps.make(function* () {
  const db = yield* Db
  return {
    loadLocal: (id) => db.query(id),
    loadRemote: (id) =>
      gen(function* () {
        const server = yield* ServerFetch
        return yield* server.fetchOne(id)
      }),
  }
})
// ServerFetch is not a construction dependency of Mps.
assertType<Equals<typeof MpsLive, Provider<'Mps', 'Db', never>>>()

const local = gen(function* () {
  const mps = yield* Mps
  return yield* mps.loadLocal('1')
})
const remote = gen(function* () {
  const mps = yield* Mps
  return yield* mps.loadRemote('1')
})
assertType<Equals<typeof local, Fx<User, DbError, 'Mps'>>>()
assertType<Equals<typeof remote, Fx<User, DbError, 'Mps' | 'ServerFetch'>>>()

run(local, [MpsLive, DbLive, ConfigLive, LoggerLive])
// @ts-expect-error e2: missing service ServerFetch - only the remote path needs it
run(remote, [MpsLive, DbLive, ConfigLive, LoggerLive])
run(remote, [
  MpsLive,
  DbLive,
  ConfigLive,
  LoggerLive,
  ServerFetch.of({ fetchOne: (id) => ok({ id }) }),
])

// Two services may depend on each other at call time. Neither is a
// construction dependency of the other, so there is no cycle to detect. Each
// method transitively needs both, and the contract has to say so - the first
// draft declared only the direct one and tsc rejected it.
interface Ping {
  ping(n: number): Fx<number, never, 'Ping' | 'Pong'>
}
interface Pong {
  pong(n: number): Fx<number, never, 'Ping' | 'Pong'>
}
const Ping = service<Ping>()('Ping')
const Pong = service<Pong>()('Pong')
const PingLive = Ping.make(function* () {
  return {
    ping: (n) =>
      gen(function* () {
        if (n === 0) return 0
        const pong = yield* Pong
        return yield* pong.pong(n - 1)
      }),
  }
})
const PongLive = Pong.make(function* () {
  return {
    pong: (n) =>
      gen(function* () {
        if (n === 0) return 0
        const ping = yield* Ping
        return yield* ping.ping(n - 1)
      }),
  }
})
assertType<Equals<typeof PingLive, Provider<'Ping', never, never>>>()
run(
  gen(function* () {
    const ping = yield* Ping
    return yield* ping.ping(3)
  }),
  [PingLive, PongLive]
)

// --- CASE 5: class-based, object-based, function-based - the key does not care

class PgDb implements Db {
  constructor(private readonly pool: Pool) {}
  query(id: string): Fx<User, DbError> {
    return sync(() => this.pool.q(id))
  }
}
const DbClassLive = Db.make(function* () {
  const config = yield* Config
  return new PgDb(yield* connect(config.url))
})
assertType<Equals<typeof DbClassLive, Provider<'Db', 'Config', ConnError>>>()

const makeDb = (pool: Pool): Db => ({ query: (id) => sync(() => pool.q(id)) })
const DbFnLive = Db.make(function* () {
  const config = yield* Config
  return makeDb(yield* connect(config.url))
})
assertType<Equals<typeof DbFnLive, Provider<'Db', 'Config', ConnError>>>()

// --- CASE 6: the contract bounds the implementation -------------------------
// `query` is declared `Fx<User, DbError>`: no call-time dependencies. An
// implementation that reaches for Logger inside `query` is rejected here,
// not discovered by a caller. To allow it, declare it in the contract (CASE
// 4) or resolve Logger at construction (CASE 1).

// @ts-expect-error Fx<User, never, 'Logger'> is not assignable to Fx<User, DbError, never>
Db.make(function* () {
  return {
    query: (id: string) =>
      gen(function* () {
        const log = yield* Logger
        yield* log.info(id)
        return { id }
      }),
  }
})

// A wrong shape is rejected on the return, where it is written.
// @ts-expect-error `query` is missing
Db.make(function* () {
  return { lookup: (id: string) => ok({ id }) }
})

// --- CASE 7: an extension point is just a service without a default --------
// This is the shape Effect.Service cannot express (COMPARISON.md). Here it is
// the same `service<Api>()` call as everything else, and its provider lives
// wherever the composition root wants it.

interface Stage<Value> {
  readonly name: string
  readonly run: (value: Value) => Fx<Value>
}
const PreStages = service<readonly Stage<User>[]>()('MPS/PreStages')

const PreStagesLive = PreStages.make(function* () {
  const db = yield* Db
  return [
    { name: 'exists', run: (user) => gen(function* () { yield* db.query(user.id); return user }) as Fx<User> },
    { name: 'noop', run: (user) => ok(user) },
  ]
})
assertType<Equals<typeof PreStagesLive, Provider<'MPS/PreStages', 'Db', never>>>()

// --- CASE 8: the forgotten-yield guard still applies inside a body ----------
// `gen` inside a method that returns an Fx without `yield*` is still poisoned.
const poisoned = gen(function* () {
  const db = yield* Db
  return db.query('1')
})
assertType<Equals<typeof poisoned, 'e2: this generator returns an Fx - did you forget `yield*`?'>>()

// --- CASE 9: memoised, lazy initialisation ----------------------------------
// A service whose resource must be opened asynchronously, exactly once, with
// nothing waiting for it at startup and the first read being the first thing
// that waits. The full IndexedDB shape is in the port's LocalStore; this
// case pins the type-level facts.

interface Handle {
  close(): void
}
declare function openIdb(name: string): Promise<Handle>
declare function lookup(handle: Handle, key: string): Promise<string | undefined>
class IdbError {
  readonly _tag = 'IdbError' as const
  constructor(readonly reason: unknown) {}
}

interface Cache {
  readonly get: (key: string) => Fx<string | undefined, IdbError>
}
const Cache = service<Cache>()('Cache')

const CacheLive = Cache.make(function* () {
  const config = yield* Config
  // 1. memo records the requirements of what it wraps against THIS body -
  //    Scope from `acquire`, which the provider then strips - and returns a
  //    handle with none: Fx<Handle, IdbError>.
  const db = yield* memo(
    acquire(
      () => openIdb('cache-' + config.userId),
      (handle) => handle.close(),
      (reason) => new IdbError(reason)
    )
  )
  assertType<Equals<typeof db, Fx<Handle, IdbError>>>()
  return {
    // 2. The read is the sync point. The first one opens the database; the
    //    rest find it open; concurrent first reads share one open.
    get: (key) =>
      gen(function* () {
        const handle = yield* db
        return yield* fromPromise(() => lookup(handle, key), (reason) => new IdbError(reason))
      }),
  }
})
// 3. Construction needs Config and cannot fail: the open's failure belongs to
//    the read that triggered it, where the contract already says IdbError.
assertType<Equals<typeof CacheLive, Provider<'Cache', 'Config', never>>>()

// 4. `eager` starts the open in the background at construction. Same types;
//    only the moment the work starts changes.
const WarmCacheLive = Cache.make(function* () {
  const db = yield* memo(
    acquire(() => openIdb('cache'), (handle) => handle.close(), (reason) => new IdbError(reason)),
    { eager: true }
  )
  return {
    get: (key) =>
      gen(function* () {
        const handle = yield* db
        return yield* fromPromise(() => lookup(handle, key), (reason) => new IdbError(reason))
      }),
  }
})
assertType<Equals<typeof WarmCacheLive, Provider<'Cache', never, never>>>()

// 5. A consumer sees none of this. Its contract and its provider are exactly
//    what they would be for a synchronous in-memory Cache.
const Greeter = service('Greeter', function* () {
  const cache = yield* Cache
  return {
    greet: (name: string) =>
      gen(function* () {
        const hit = yield* cache.get(name)
        return hit ?? 'hello ' + name
      }),
  }
})
assertType<Equals<NeedsOf<typeof Greeter>, 'Cache'>>()

// 6. Outside a provider, memo captures the request: shared within it, gone
//    with it. Two yields of the handle are one query.
const request = gen(function* () {
  const db = yield* Db
  const user = yield* memo(db.query('1'))
  const first = yield* user
  const second = yield* user
  return [first, second] as const
})
assertType<Equals<typeof request, Fx<readonly [User, User], DbError, 'Db'>>>()

// --- CASE 10: deferring a dependency past the point of use ------------------
// A sender seals, transmits, then persists. The store is needed only for the
// last step, and at the moment a send happens it may be unbuilt, or halfway
// through construction because a receiver is building it. A service key is
// an Fx, so `memo` applies to it unchanged: yielding memo(Store) at
// construction records 'Store' in Needs and returns a handle; yielding the
// handle after the wire call resolves Store THEN - builds it if the cell is
// empty, joins if it is inflight, returns it if done.

interface Sealer {
  seal(id: string): Fx<string>
}
interface Wire {
  send(sealed: string): Fx<void, DbError>
}
interface Store {
  ingest(id: string): Fx<User, DbError>
}
interface Sender {
  send(id: string): Fx<User, DbError>
}
const Sealer = service<Sealer>()('Sealer')
const Wire = service<Wire>()('Wire')
const Store = service<Store>()('Store')
const Sender = service<Sender>()('Sender')

const SenderLive = Sender.make(function* () {
  const sealer = yield* Sealer
  const wire = yield* Wire
  const lazyStore = yield* memo(Store)
  assertType<Equals<typeof lazyStore, Fx<Store>>>()
  return {
    send: (id) =>
      gen(function* () {
        const sealed = yield* sealer.seal(id)
        yield* wire.send(sealed)
        const store = yield* lazyStore // resolved here, after the wire accepted it
        return yield* store.ingest(id)
      }),
  }
})
// Needs is complete, so the list is still checked, and the contract is untouched.
assertType<Equals<typeof SenderLive, Provider<'Sender', 'Sealer' | 'Wire' | 'Store', never>>>()

declare const SealerLive: Provider<'Sealer', never, never>
declare const WireLive: Provider<'Wire', never, never>
declare const StoreLive: Provider<'Store', never, never>

// At the root, `lazy` keeps Store and Sender out of warm-up. Type-transparent:
const app = runtime([SealerLive, WireLive, lazy(StoreLive), lazy(SenderLive)])
assertType<Equals<Awaited<typeof app>, Runtime<'Sealer' | 'Wire' | 'Store' | 'Sender'>>>()
// ...and the closure check still sees through it.
const appOpen = runtime([SealerLive, WireLive, lazy(SenderLive)])
assertType<Equals<typeof appOpen, 'e2: missing service Store'>>()

// ===========================================================================
// PROTOTYPE PORT - prototype/e2/src, in the proposed API
//
// The files below are the real ones, ported line for line where the body is
// unchanged and abbreviated (`...`) only inside method bodies that do not
// touch the DI surface. Domain types are stubbed at the top. Compare with
// prototype/e2/src/services/send.ts, extensions/stages.ts, app/registries.ts
// and worker/main.ts.
// ===========================================================================

export namespace Prototype {
  // --- domain stubs --------------------------------------------------------
  interface Message {
    readonly id: string
    readonly threadId: string
    readonly body: string
  }
  type Payload = { readonly kind: 'text'; readonly body: string }
  interface Inbound {
    readonly id: string
    readonly threadId: string
    readonly authorId: string
    readonly sentAt: number
    readonly payload: Payload
  }
  interface Envelope extends Omit<Inbound, 'payload'> {
    readonly ciphertext: string
  }
  interface Directive {
    readonly _tag: 'PostMessage'
    readonly message: Message
  }
  class NetworkError {
    readonly _tag = 'NetworkError' as const
    constructor(readonly reason: string) {}
  }
  class ValidationError {
    readonly _tag = 'ValidationError' as const
    constructor(
      readonly stage: string,
      readonly reason: string
    ) {}
  }
  type DomainError = NetworkError | ValidationError | IdbError
  declare function sleep(ms: number): Fx<void>
  declare function fail<Error>(error: Error): Fx<never, Error>

  // --- services/config.ts ---------------------------------------------------
  // Was: interface ConfigApi + service<ConfigApi>()('Config') + type Config =
  // typeof Config + provider.of(Config, {...}). Configuration is the case
  // for implementation-first: the shape IS the value.

  export const Config = service('Config', function* () {
    return {
      deviceId: 'device-main',
      userId: 'user-me',
      pageSize: 50,
      mediaRoot: '/media',
    }
  })
  export type Config = ApiOf<typeof Config>

  // --- services/crypto.ts (seal only) -------------------------------------

  export interface Crypto {
    readonly seal: (inbound: Inbound) => Fx<Envelope>
    readonly deviceId: string
  }
  export const Crypto = service<Crypto>()('Crypto')

  export const CryptoLive = Crypto.make(function* () {
    const config = yield* Config
    const cipher = (text: string, shift: number) =>
      [...text].map((c) => String.fromCharCode(c.charCodeAt(0) + shift)).join('')
    return {
      seal: (inbound) =>
        sync(() => ({
          id: inbound.id,
          threadId: inbound.threadId,
          authorId: inbound.authorId,
          sentAt: inbound.sentAt,
          ciphertext: cipher(JSON.stringify(inbound.payload), 1),
        })),
      deviceId: config.deviceId,
    }
  })

  // --- services/network.ts (send only) ------------------------------------
  // `acquire` ties the connection to the runtime scope; Scope does not appear
  // in Needs.

  export interface Network {
    readonly send: (envelope: Envelope) => Fx<Envelope, NetworkError>
    readonly sentCount: Fx<number>
  }
  export const Network = service<Network>()('Network')

  export const NetworkLive = Network.make(function* () {
    const config = yield* Config
    const sent: Envelope[] = []
    yield* acquire(
      () => console.log('[network] connected as ' + config.deviceId),
      () => console.log('[network] disconnected after ' + sent.length + ' sends')
    )
    return {
      send: (envelope) =>
        gen(function* () {
          if (envelope.threadId === 'offline') {
            return yield* fail(new NetworkError('no route to host'))
          }
          yield* sleep(1)
          sent.push(envelope)
          return envelope
        }),
      sentCount: sync(() => sent.length),
    }
  })
  assertType<Equals<typeof NetworkLive, Provider<'Network', 'Config', never>>>()

  // --- services/local_store.ts, on IndexedDB --------------------------------
  // The scenario from the design discussion. Opening IndexedDB is async and
  // must happen once; nothing should wait for it at startup; the first read
  // should. The provider constructs synchronously, `memo` owns the open, and
  // the reads are the sync point. MPS below is not involved and its contract
  // does not mention any of it.

  interface IdbStore {
    get(key: string): Promise<Message | undefined>
    put(message: Message): Promise<void>
    close(): void
  }
  declare function openMessages(name: string): Promise<IdbStore>

  export interface LocalStore {
    readonly get: (id: string) => Fx<Message | undefined, IdbError>
    readonly put: (message: Message) => Fx<Message, IdbError>
  }
  export const LocalStore = service<LocalStore>()('LocalStore')

  export const LocalStoreLive = LocalStore.make(function* () {
    const config = yield* Config
    // Opened once, on the first read, closed with the runtime.
    const db = yield* memo(
      acquire(
        () => openMessages('messages-' + config.userId),
        (store) => store.close(),
        (reason) => new IdbError(reason)
      )
    )
    const idb = <Value>(run: (store: IdbStore) => Promise<Value>) =>
      gen(function* () {
        const store = yield* db
        return yield* fromPromise(() => run(store), (reason) => new IdbError(reason))
      })
    return {
      get: (id) => idb((store) => store.get(id)),
      put: (message) => idb(async (store) => (await store.put(message), message)),
    }
  })
  assertType<Equals<typeof LocalStoreLive, Provider<'LocalStore', 'Config', never>>>()

  // --- services/mps_contracts.ts: the extension points ---------------------
  // Unchanged in spirit: an extension point is a service nobody gives a
  // default to. It is now literally the same call as any other service.

  export interface Stage<Value, Error> {
    readonly name: string
    readonly run: (value: Value) => Fx<Value, Error>
  }
  export type Pipeline<Value, Error> = readonly Stage<Value, Error>[]
  export const stage = <Value, Error>(
    name: string,
    run: (value: Value) => Fx<Value, Error>
  ): Stage<Value, Error> => ({ name, run })

  export const PreStages = service<Pipeline<Directive, DomainError>>()('MPS/PreStages')
  export const PostStages = service<Pipeline<Message, DomainError>>()('MPS/PostStages')

  // --- services/mps.ts (ingest only) --------------------------------------

  export interface Mps {
    readonly ingest: (inbound: Inbound) => Fx<readonly Message[], DomainError>
    readonly describe: () => { readonly pre: readonly string[]; readonly post: readonly string[] }
  }
  export const Mps = service<Mps>()('Mps')

  export const MpsLive = Mps.make(function* () {
    const local = yield* LocalStore
    const preStages = yield* PreStages
    const postStages = yield* PostStages

    const runPipeline = <Value>(pipeline: Pipeline<Value, DomainError>, input: Value) =>
      gen(function* () {
        let current = input
        for (const step of pipeline) current = yield* step.run(current)
        return current
      })

    return {
      ingest: (inbound) =>
        gen(function* () {
          const message: Message = {
            id: inbound.id,
            threadId: inbound.threadId,
            body: inbound.payload.body,
          }
          const directive: Directive = { _tag: 'PostMessage', message }
          const checked = yield* runPipeline(preStages, directive)
          const finished = yield* runPipeline(postStages, checked.message)
          yield* local.put(finished)
          return [finished] as const
        }),
      describe: () => ({
        pre: preStages.map((s) => s.name),
        post: postStages.map((s) => s.name),
      }),
    }
  })
  assertType<
    Equals<typeof MpsLive, Provider<'Mps', 'LocalStore' | 'MPS/PreStages' | 'MPS/PostStages', never>>
  >()

  // --- services/send.ts, whole file ---------------------------------------
  // Before (prototype/e2/src/services/send.ts):
  //
  //   export interface SendApi { readonly send: (...) => Fx<readonly Message[], SendError> }
  //   export const Send = service<SendApi>()('Send')
  //   export type Send = typeof Send
  //   export const SendLive = provider(
  //     Send,
  //     [Config, Crypto, Network, Mps],
  //     function* (config, crypto, network, mps) { ... }
  //   )
  //
  // After: the dependency is written once, where it is used, and the contract
  // is the type `Send`.

  export interface Send {
    readonly send: (threadId: string, payload: Payload) => Fx<readonly Message[], DomainError>
  }
  export const Send = service<Send>()('Send')

  export const SendLive = Send.make(function* () {
    const config = yield* Config
    const crypto = yield* Crypto
    const network = yield* Network
    // Needed only once the network has accepted the envelope, and resolved
    // then: built if nobody has yet, joined if Receive is mid-way through
    // building it, returned if it is up.
    const lazyMps = yield* memo(Mps)
    let counter = 0

    return {
      send: (threadId, payload) =>
        gen(function* () {
          counter += 1
          const inbound: Inbound = {
            id: 'local-' + counter,
            threadId,
            authorId: config.userId,
            sentAt: Date.now(),
            payload,
          }
          const envelope = yield* crypto.seal(inbound)
          yield* network.send(envelope)
          const mps = yield* lazyMps
          return yield* mps.ingest(inbound)
        }),
    }
  })
  assertType<
    Equals<typeof SendLive, Provider<'Send', 'Config' | 'Crypto' | 'Network' | 'Mps', never>>
  >()

  // --- extensions/stages.ts -----------------------------------------------
  // Stages owned by other teams. `Provider.sync(X, [Dep], (dep) => ...)`
  // becomes `X.make(function* () { const dep = yield* Dep; ... })`.

  const nonEmpty: Stage<Directive, DomainError> = stage('non-empty', (directive) =>
    gen(function* () {
      if (directive.message.body.trim() === '') {
        return yield* fail(new ValidationError('non-empty', 'message body is blank'))
      }
      return directive
    })
  )

  export const CoreValidation = service<Pipeline<Directive, DomainError>>()('CoreValidation')
  export const CoreValidationLive = CoreValidation.make(function* () {
    return [nonEmpty]
  })

  export interface SearchIndex {
    readonly add: (message: Message) => Fx<void>
  }
  export const SearchIndex = service<SearchIndex>()('SearchIndex')
  export const SearchIndexLive = SearchIndex.make(function* () {
    const terms = new Map<string, Set<string>>()
    return {
      add: (message) =>
        sync(() => {
          for (const word of message.body.split(/\s+/)) {
            terms.set(word, (terms.get(word) ?? new Set()).add(message.id))
          }
        }),
    }
  })

  export const SearchStage = service<Stage<Message, DomainError>>()('SearchStage')
  export const SearchStageLive = SearchStage.make(function* () {
    const index = yield* SearchIndex
    return stage('search-index', (message: Message) =>
      gen(function* () {
        yield* index.add(message)
        return message
      })
    )
  })

  // --- app/registries.ts: the composition root ------------------------------

  export const PreStagesLive = PreStages.make(function* () {
    const core = yield* CoreValidation
    return [...core]
  })
  export const PostStagesLive = PostStages.make(function* () {
    const search = yield* SearchStage
    return [search]
  })

  // --- worker/main.ts -------------------------------------------------------
  // Flat, unordered, each service named once - and now also checked for
  // closure at this line rather than at startup. Config is a defaulted
  // service and goes in as itself. Startup policy lives here and nowhere
  // else: what is built at boot, what waits for the first use.

  export const worker = runtime([
    Config,
    NetworkLive, // connect at startup: this is a messaging client
    LocalStoreLive, // constructed at startup; opens IndexedDB on first read (memo inside)
    CoreValidationLive,
    SearchIndexLive,
    SearchStageLive,
    PreStagesLive,
    PostStagesLive,
    lazy(CryptoLive), // ratchet set up on first seal or open
    lazy(MpsLive), // built by the first read, send or receive - whichever comes first
    lazy(SendLive), // nothing until the user sends
  ])
  assertType<
    Equals<
      Awaited<typeof worker>,
      Runtime<
        | 'Config'
        | 'LocalStore'
        | 'Crypto'
        | 'Network'
        | 'CoreValidation'
        | 'SearchIndex'
        | 'SearchStage'
        | 'MPS/PreStages'
        | 'MPS/PostStages'
        | 'Mps'
        | 'Send'
      >
    >
  >()

  // Forget one and the list itself says which.
  export const forgotSearchIndex = runtime([
    Config,
    LocalStoreLive,
    CryptoLive,
    NetworkLive,
    CoreValidationLive,
    SearchStageLive,
    PreStagesLive,
    PostStagesLive,
    MpsLive,
    SendLive,
  ])
  assertType<Equals<typeof forgotSearchIndex, 'e2: missing service SearchIndex'>>()

  // A test swaps the network for a double: another provider for the same key.
  export const offline = runtime([
    Config,
    LocalStoreLive,
    CryptoLive,
    Network.of({
      send: () => fail(new NetworkError('offline')),
      sentCount: ok(0),
    }),
    CoreValidationLive,
    SearchIndexLive,
    SearchStageLive,
    PreStagesLive,
    PostStagesLive,
    MpsLive,
    SendLive,
  ])

  // The handler table, as worker/main.ts writes it today.
  export const sendMessage = (threadId: string, payload: Payload) =>
    gen(function* () {
      const send = yield* Send
      return yield* send.send(threadId, payload)
    })
  export async function serve() {
    const rt = await worker
    return rt.run(sendMessage('thread-a', { kind: 'text', body: 'hi' }))
  }
}

export {}
