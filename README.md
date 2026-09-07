# e2

A re-think of [Effect](https://effect.website), scoped to **dependency injection and control flow**. No Schema, no Stream, no HTTP layer, no platform package.

Runs on Bun and in the browser. No `node:async_hooks`, no decorators, no build step, no runtime dependencies.

```ts
export interface Db { query(id: string): Fx<User, DbError> }
export const Db = service<Db>()('Db')   // type Db is the contract, value Db is the key

export const DbLive = Db.make(function* () {
  const config = yield* Config          // dependencies are what the body yields
  const pool = yield* acquire(() => connect(config.url), (p) => p.close())
  return { query: (id) => sync(() => pool.find(id)) }
})                                      // Provider<'Db', 'Config', never>

const getUser = fx(function* (id: string) {
  const db = yield* Db
  const log = yield* Logger
  yield* log.info(`load ${id}`)
  return yield* db.query(id)
})
// (id: string) => Fx<User, DbError, 'Db' | 'Logger'>

const result = await run(getUser('1'), [DbLive, LoggerLive, ConfigLive])
// Result<User, DbError | ParseError | ConnError>

// or build the graph once and keep it
await using rt = await runtime([DbLive, LoggerLive, ConfigLive])
await rt.run(getUser('1'))
```

## What it keeps from Effect

Requirements are **inferred, not declared** — use a service six frames deep and the dependency set propagates without touching one intermediate signature. A missing dependency is a compile error. Test substitution is total and type-proven. Providers unify DI with async construction and ordered teardown.

## What it changes

### Diagnostics that name the problem

```
Type 'Fx<User, DbError, "Db" | "Logger">'
  is not assignable to type '"e2: missing service Logger"'.
```

Two lines, and the second one is the answer. Effect's equivalent hands you two `Context<…>` unions to diff by eye. The dependency channel carries service **names** rather than service objects, so `Fx<User, DbError, 'Db'>` is what you see in every hover too, not `Fx<User, DbError, Service<'Db', DbApi>>`.

That message is [pinned by a test](src/tests/diagnostics.spec.ts) that shells out to `tsc` and asserts the exact wording, so a TypeScript upgrade that degrades it turns CI red rather than quietly eroding the point of the library.

### One way to compose providers

Effect has `Layer.provide`, `provideMerge`, `merge` and `mergeAll`, and choosing wrongly is the most common way to get stuck. e2 has a flat, unordered list. Nothing declares its dependencies twice: a provider's body yields what it needs, and the runtime builds each service on first demand, memoised, so construction order is dependency order without a sort:

```ts
await run(getUser('1'), [DbLive, ConfigLive, LoggerLive]) // order is irrelevant
```

A service is built exactly once, because there is no user-visible composition graph to get wrong. A list that does not close over its own needs is a compile error at the list, not a surprise at startup:

```
Property 'run' does not exist on type '"e2: missing service Config"'.
```

### Lazy initialisation

Construction is eager by default, which is what makes a bad graph fail at startup. Two ways to opt out, both the same mechanism:

```ts
// In a provider: opened once, on the first read, closed with the runtime.
const db = yield* memo(acquire(() => openIdb(config.userId), (h) => h.close(), (e) => new IdbError(e)))
get: (id) => gen(function* () { return yield* read(yield* db, id) })

// In a consumer: record the dependency now, resolve it at the point of use -
// built if nobody has, joined if it is mid-construction, returned if it is up.
const lazyMps = yield* memo(Mps)
…
yield* network.send(envelope)
const mps = yield* lazyMps

// At the composition root: not built at startup at all.
await runtime([Config, NetworkLive, lazy(CryptoLive), lazy(SendLive)])
```

`memo(fx)` records `fx`'s requirements against the body it is yielded in and hands back a handle with none, so a contract never has to mention how its implementation initialises. A service key is an `Fx`, which is why `memo(Mps)` needs no API of its own. Concurrent first uses share one run, a caller interrupted while waiting does not cancel it, and a failed run is retried by the next use.

### The key is the same key on either side of a worker

Because a service is looked up by name and its contract is TypeScript, a service can be served across a worker boundary by key: `serve(rt, [Mps, Send], codec)` in the worker, `remote(Worker, [Mps, Send])` on the main thread, and `yield* Mps` cannot tell which side it is on. The bridge that does this lives in [`prototype/e2/src/bridge`](prototype/e2/src/bridge) rather than in the core, since it is platform code; it rejects at compile time any member that cannot cross - a plain value, a callback anywhere but last - and names it.

### `Result` is the pure subset of `Fx`

`Ok` **is** `succeed`; `Err` **is** `fail`. The same two classes are the interpreter's success and failure instructions.

```ts
const load = fx(function* (raw: string) {
  const config = yield* parseConfig(raw) // a plain Result<Config, ParseError>
  const port = yield* parsePort(config)  // a plain Result<number, RangeError>
  return { ...config, port }
})                     // Fx<Config, ParseError | RangeError>
```

`yield* someResult` short-circuits — **that is the `?` operator TypeScript doesn't have** — and there is no adapter layer between plain fallible functions and effectful ones. Outside an `fx` body, `if (!result.ok) return result` typechecks with no cast.

### Spelled-out type parameters

`Fx<Value, Error, Dependency>`, not `Effect<A, E, R>`.

## Core

| | |
|---|---|
| `fx` / `gen` | build an effect from a generator body |
| `ok` / `err`, `sync`, `suspend`, `async_` | primitives |
| `map`, `flatMap`, `catchAll`, `mapError`, `attemptFx` | combinators |
| `service<Api>()('Name')`, `service('Name', function* () {})` | define a service: a contract plus its lookup key, optionally with its default |
| `Db.make(function* () {})`, `Db.of(value)` | implement a service; dependencies are what the body yields |
| `memo`, `lazy` | run once on first use; keep a provider out of the startup warm-up |
| `run`, `runExit`, `runSync`, `runSyncExit`, `runtime` | entry points |

## Control flow

| | |
|---|---|
| `fork`, `join`, `joinExit`, `interruptFiber` | fibers |
| `race`, `allConcurrent`, `timeout`, `forEach` | concurrency |
| `retry`, `repeat`, `Schedule` | policies, with `.jittered()`, `.maxDelay()`, `.upTo()` |
| `scoped`, `acquire`, `addFinalizer`, `ensuring` | resources |
| `memo`, `batch` | run once on first use; coalesce many single calls into one run |
| `sleep`, `fromPromise` | suspension |

Children die with their parent — a fiber cannot complete while it still has children, so forked work never outlives what forked it. Interruption travels by `AbortSignal`, handed to `fromPromise` explicitly, so `fetch` cancels for free. Finalizers receive the `Exit` that closed the scope, so they can tell success from failure from interruption.

Interruption is delivered **once**: everything that runs afterwards — scope finalizers, `ensuring` handlers, a generator's `finally` — runs to completion rather than being re-interrupted. A hung finalizer therefore cannot itself be cancelled. That is the deliberate side of the trade against cleanup that silently never happens.

## The `yield*` footgun

An `Fx` is a description. Building one and not running it does nothing, silently. Most shapes of that mistake are type errors, because `Fx` carries a `unique symbol` brand:

| Mistake | Caught by |
|---|---|
| `const u = db.query(id); u.name` | types |
| `f(db.query(id))` where `f(u: User)` | types |
| `return db.query(id)` without `yield*` | types |
| `const db = yield Db` (no `*`) | types |
| `db.query(id)` as a bare statement | **lint** |
| `if (someFx)`, `!someFx`, `someFx ? a : b` | **lint** |
| `await someFx` | **lint** |
| `[...someFx]`, `Promise.all([someFx])` | **lint** |

The last four are not solvable in the type system. They are covered by [`eslint-plugin-e2`](packages/eslint-plugin-e2), whose `no-floating-fx` rule is exact precisely because the brand is: it does not need to resolve the e2 module to recognise an effect. It deliberately does **not** flag a discarded `Result`, which is eager — by the time you hold one the work has happened.

## Honest limitations

- **`runSync` fails at runtime, not compile time.** Reaching an async operation produces `Die(AsyncBoundary)` naming the escape route. Tracking synchronicity in the type would double the type surface on every constructor; it isn't worth it. Use `runSync` for tests and genuinely synchronous pipelines.
- **A contract violation is a deep diagnostic.** An implementation whose method reaches for a service the contract does not declare is rejected where it is written, but the useful line - `Type '"Logger"' is not assignable to type 'never'` - sits under nine levels of structural walk through `Generator` and `IteratorResult`.
- **A forgotten `yield*` on a `return` is silent if the effect is never used.** The guard poisons the value's type; it surfaces wherever the effect is used, which is every realistic case, but an unused bad definition compiles. The closure check on `runtime` has the same shape: it lives in the return type, so an unused `runtime(...)` compiles.
- **Two tags may not share a name.** The dependency channel carries names, which is what buys the readable diagnostics. The runtime rejects duplicates when the list is assembled. Use distinct tags for distinct instances.
- **`lazy()` trades fail-fast for one service.** A provider wrapped at the root is not exercised at startup, so a construction bug in it is found by its first user, as a `ProviderFailed` defect, and the cell resets so the next use retries.
- **`run(effect, providers)` builds and tears down the whole graph on every call.** That is the point of `runtime` — calling `run` per request would reconnect the pool per request.
- **Do not annotate a generator body's return type.** `function* (): Generator<…, User>` supplies a contextual type that disables inference and collapses `Error` and `Dependency` to whatever you wrote.

## Status

Early, but complete through the planned phases and green end to end.

| Phase | |
|---|---|
| 0 — typing spike | ✅ |
| 1 — `Result` + `Cause` | ✅ |
| 2 — DI types (`Service`, `Provider`, demand-driven `Cell`) | ✅ |
| 3 — synchronous interpreter | ✅ |
| 4 — async, fibers, scopes | ✅ |
| 5 — ops, lint rule, docs | ✅ |

`spike/fx_types.ts` records the type-level proof the approach holds, including measured findings on TypeScript's inference limits. `spike/di_v2.ts` and `spike/di_v2.md` record the DI redesign that removed the provider dependency tuple, with its measured diagnostics.

## Development

```bash
bun install
bun run check          # typecheck + lint + tests
bun run smoke:browser  # build dist/e2-smoke.js, then open dist/smoke.html
```

The browser bundle is ~34 KB and is verified in CI by executing it with every Node global shadowed out of scope. For comparison, `effect@3.22.1` unpacks to 27 MB.
