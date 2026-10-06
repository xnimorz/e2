# e2

**Typed dependency injection and structured control flow for TypeScript.**

e2 makes three things the compiler checks instead of things you keep in your head: what a piece of code depends on, how it can fail, and what happens to the work it started when it stops. You write ordinary sequential code in generator functions; e2 infers the rest into one type, `Fx<Value, Error, Dependency>`, and runs it.

It runs on Bun, in the browser and in workers, with no decorators, no build step and no runtime dependencies.

**[Documentation](https://xnimorz.github.io/e2/)** · **[Playground](https://xnimorz.github.io/e2/playground.html)**

```bash
npm install e2      # or: bun add e2
```

TypeScript 5.5 or later. Version 3 is a new library under an old name: e2 2.x was an unrelated event emitter.

## Why

In most TypeScript applications those three questions are answered by convention:

- **Dependencies** are either imports, which hard-wire one implementation and make tests reach for module mocks, or a DI container, which wires at runtime from decorators and reflection and tells you about a missing binding when the app starts — or when the first request hits the code path that needed it.
- **Failure** is `throw`. Nothing in a signature says what can go wrong, and every `catch` receives `unknown`.
- **Lifetime** is an `AbortSignal` threaded through by hand, `finally` blocks you hope run, and promises nobody awaits that keep going after the thing that started them has given up.

e2 moves all three into the type of the code itself:

```ts
const getUser = fx(function* (id: string) {
  const db = yield* Db
  const log = yield* Logger
  yield* log.info(`load ${id}`)
  return yield* db.query(id)
})
// (id: string) => Fx<User, DbError, 'Db' | 'Logger'>
```

Nobody wrote that signature. `'Db' | 'Logger'` is there because the body asked for them; `DbError` is there because `db.query` can fail with it. Call `getUser` six functions deep and the requirement travels up without touching a single intermediate signature. Run it without a `Logger` and it does not compile:

```
Type 'Fx<User, DbError, "Db" | "Logger">'
  is not assignable to type '"e2: missing service Logger"'.
```

The second line is the answer. That diagnostic is a feature, so it is [pinned by a test](src/tests/diagnostics.spec.ts) that runs `tsc` and asserts the exact wording; a TypeScript upgrade that degrades it fails CI.

## Three ideas

Everything in e2 is one of these.

**An effect is a description.** An `Fx` says what to compute, how it can fail, and which services it needs. Building one does nothing. An interpreter runs it later, against a set of services, and produces a `Result`. Because nothing has happened until then, an effect can be retried, raced, timed out, cancelled or run against test doubles without being written differently.

**Dependencies are names, and they are inferred.** A service is a contract plus a key. `yield* Db` puts `'Db'` in the type. Wiring is one flat, unordered list of implementations; each is built the first time something asks for it, so construction order is dependency order without anyone declaring it.

**One cell does the sharing.** "Build once, let everyone who asks share the result, let a failure be retried" is the same mechanism whether the thing being built is a service, a database opened on first use, or a batch of writes. Services, `memo` and `batch` are one implementation, so they cannot disagree about joining, failure or teardown.

## Services

```ts
export interface Db { query(id: string): Fx<User, DbError> }
export const Db = service<Db>()('Db')   // type Db is the contract, value Db is the key

export const ConfigLive = Config.of({ url: 'postgres://localhost' })

export const DbLive = Db.make(function* () {
  const config = yield* Config          // this is the dependency declaration
  const pool = yield* acquire(() => connect(config.url), (p) => p.close())
  return { query: (id) => sync(() => pool.find(id)) }
})                                      // Provider<'Db', 'Config', never>

const result = await run(getUser('1'), [DbLive, LoggerLive, ConfigLive])  // order is irrelevant
// Result<User, DbError>

// A long-lived process builds the graph once and keeps it.
await using rt = await runtime([DbLive, LoggerLive, ConfigLive])
await rt.run(getUser('1'))
```

An implementation is a body that yields what it needs, so nothing declares its dependencies twice. Each service is built exactly once, and what it opened with `acquire` is closed, in reverse order, when the runtime closes. A list that does not cover its own needs is a compile error at the list, not a surprise at startup:

```
Property 'run' does not exist on type '"e2: missing service Config"'.
```

Swapping an implementation — for a test double, an in-memory store, a worker — is a change to the list and is type-checked like any other.

## Lazy initialisation

Construction is eager by default, which is what makes a bad graph fail at startup. When that is the wrong trade, there are two ways out, and they are the same mechanism:

```ts
// In a provider: opened once, on the first read, closed with the runtime.
const db = yield* memo(acquire(() => openIdb(config.userId), (h) => h.close(), (e) => new IdbError(e)))
get: (id) => gen(function* () { return yield* read(yield* db, id) })

// In a consumer: record the dependency now, resolve it at the point of use -
// built if nobody has, joined if it is mid-construction, returned if it is up.
const lazyMps = yield* memo(Mps)
…
const mps = yield* lazyMps

// At the composition root: not built at startup at all.
await runtime([Config, NetworkLive, lazy(CryptoLive), lazy(SendLive)])
```

`memo(fx)` records `fx`'s requirements against the body it is yielded in and hands back a handle with none, so a contract never has to mention how its implementation initialises. Concurrent first uses share one run, a caller interrupted while waiting does not cancel it, and a failed run is retried by the next use.

## Errors: `Result` is the pure subset of `Fx`

`Ok` **is** `succeed` and `Err` **is** `fail` — the same two classes are the interpreter's success and failure instructions. So a plain fallible function needs no adapter to be used from effectful code:

```ts
const load = fx(function* (raw: string) {
  const config = yield* parseConfig(raw) // a plain Result<Config, ParseError>
  const port = yield* parsePort(config)  // a plain Result<number, RangeError>
  return { ...config, port }
})                                       // Fx<Config, ParseError | RangeError>
```

`yield* someResult` short-circuits on failure — the `?` operator TypeScript does not have. Outside an `fx` body, `if (!result.ok) return result` narrows with no cast.

Failures come in three kinds, kept apart in a `Cause`: `Fail` for the errors in the type, `Die` for defects (a thrown exception, a broken invariant), and `Interrupt` for cancellation.

## Concurrency and resources

Work is structured: children die with their parent, and a fiber cannot complete while it still has children, so forked work never outlives what forked it. Interruption travels by `AbortSignal`, handed to `fromPromise` explicitly, so `fetch` cancels for free. Finalizers receive the `Exit` that closed their scope, so they can tell success from failure from interruption.

Interruption is delivered **once**: everything that runs afterwards — scope finalizers, `ensuring` handlers, a generator's `finally` — runs to completion rather than being re-interrupted. A hung finalizer therefore cannot itself be cancelled; that is the deliberate side of the trade against cleanup that silently never happens.

## Workers

Because a service is looked up by name and its contract is a TypeScript interface, the same key works on either side of a worker boundary. [`examples/worker`](examples/worker) implements one service three ways — on a worker thread, inline on the main thread, and as a stub — and the program that consumes it is identical in all three. Moving work off the main thread is a one-line change to the provider list.

## The whole surface

| | |
|---|---|
| `fx` / `gen` | build an effect from a generator body |
| `ok` / `err`, `sync`, `suspend`, `async_`, `fromPromise`, `sleep` | primitives |
| `map`, `flatMap`, `catchAll`, `mapError`, `attemptFx` | combinators |
| `service<Api>()('Name')`, `service('Name', function* () {})` | define a service: a contract plus its key, optionally with a default |
| `Db.make(function* () {})`, `Db.of(value)` | implement a service; dependencies are what the body yields |
| `run`, `runExit`, `runSync`, `runSyncExit`, `runtime` | entry points |
| `memo`, `lazy`, `batch` | run once on first use; keep a provider out of startup; coalesce many calls into one run |
| `fork`, `join`, `joinExit`, `interruptFiber` | fibers |
| `race`, `allConcurrent`, `timeout`, `forEach` | concurrency |
| `retry`, `repeat`, `Schedule` | policies, with `.jittered()`, `.maxDelay()`, `.upTo()` |
| `scoped`, `acquire`, `addFinalizer`, `ensuring` | resources |

The [documentation](https://xnimorz.github.io/e2/) covers each area in depth, with step-by-step guides, and every example runs in the [playground](https://xnimorz.github.io/e2/playground.html).

## The `yield*` footgun

An `Fx` is a description, so building one and not running it does nothing, silently. Most shapes of that mistake are type errors, because `Fx` carries a `unique symbol` brand:

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

The last four are out of the type system's reach. [`eslint-plugin-e2`](packages/eslint-plugin-e2) (`npm install --save-dev eslint-plugin-e2`) covers them with `no-floating-fx`, which is exact because the brand is: it recognises an effect without resolving the e2 module. It deliberately does **not** flag a discarded `Result`, which is eager — by the time you hold one, the work has happened.

## Limitations

- **`runSync` fails at runtime, not compile time.** Reaching an async operation produces `Die(AsyncBoundary)` naming the escape route. Tracking synchronicity in the type would double the type surface of every constructor. Use `runSync` for tests and genuinely synchronous pipelines.
- **A contract violation is a deep diagnostic.** An implementation whose method reaches for a service the contract does not declare is rejected where it is written, but the useful line — `Type '"Logger"' is not assignable to type 'never'` — sits under nine levels of structural walk through `Generator` and `IteratorResult`.
- **A forgotten `yield*` on a `return` is silent if the effect is never used.** The guard poisons the value's type, which surfaces wherever the effect is used — every realistic case — but an unused bad definition compiles. The closure check on `runtime` has the same shape: an unused `runtime(...)` compiles.
- **Two services may not share a name.** The dependency channel carries names; that is what buys the readable diagnostics. The runtime rejects duplicates when the list is assembled.
- **`lazy()` trades fail-fast for one service.** A provider wrapped at the root is not exercised at startup, so a construction bug in it is found by its first user, as a `ProviderFailed` defect; the cell resets so the next use retries.
- **`run(effect, providers)` builds and tears down the whole graph on every call.** That is what `runtime` is for — calling `run` per request would reconnect the pool per request.
- **Do not annotate a generator body's return type.** `function* (): Generator<…, User>` supplies a contextual type that disables inference and collapses `Error` and `Dependency` to whatever you wrote.

## Coming from Effect

e2 is built on the same idea as [Effect](https://effect.website) — effects as values, requirements inferred from use — and if you know Effect you will recognise most of it. The differences are deliberate:

- **Scope.** e2 is the DI and control-flow core only; there is no Schema, Stream or platform layer to adopt along with it.
- **Names in the dependency channel.** `Fx<User, DbError, 'Db'>`, not `Effect<A, E, R>` with service objects in `R`. That is what makes hovers and missing-service errors readable.
- **One way to compose.** A flat, unordered list instead of `Layer.provide`, `provideMerge`, `merge` and `mergeAll`.
- **No adapter between `Result` and `Fx`.** The pure case is a subset of the effectful one.

## Status

Early, and complete through the planned phases: types, `Result` and `Cause`, DI, the synchronous and async interpreters, fibers and scopes, operators, the lint rule and documentation. Everything is green end to end.

[`spike/`](spike) holds the type-level proofs the design rests on: `fx_types.ts` shows the approach holds, with measured findings on TypeScript's inference limits; `di_v2.ts` and `di_v2.md` record the DI redesign that removed explicit provider dependency lists.

## Development

```bash
bun install
bun run check          # typecheck + lint + tests
bun run smoke:browser  # build dist/e2-smoke.js, then open dist/smoke.html
bun run site:serve     # build the documentation and playground into out/site, and serve them
bun run build          # compile e2 and eslint-plugin-e2 into their lib/ directories
```

The site is published to GitHub Pages on every push to `master`.

### Releasing

`e2` and `eslint-plugin-e2` are released together, at one version. Set the same `version` in both `package.json` files, commit and push, then:

```bash
bun run release --dry-run   # check, build, pack, and verify the tarballs in a scratch project
bun run release             # the same, then push tag vX.Y.Z; the Release workflow publishes to npm
```

`bun run release --publish` publishes from your machine instead, which a package's very first release needs if npm trusted publishing is not set up yet.

The release script is itself an e2 program: git, npm, the shell and the terminal are services ([`scripts/release/contracts.ts`](scripts/release/contracts.ts)), each mode is a provider list ([`scripts/release.ts`](scripts/release.ts)), and [`scripts/release/release.spec.ts`](scripts/release/release.spec.ts) runs the real release logic against doubles. Ctrl+C stops running commands and removes the scratch project before exiting.

TypeScript 5.5 or later. The browser bundle is verified in CI by executing it with every Node global shadowed out of scope.
